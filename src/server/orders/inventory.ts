import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { audit } from "../audit/service.ts";
import type { InventoryMovementReason } from "./schema.ts";

type Db = Kysely<Database>;

const INVENTORY_STATES = new Set(["", "in_stock", "low", "out", "untracked"]);

export type InventoryRowDto = {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  stockQuantity: number | null;
  lowStockThreshold: number | null;
  trackInventory: boolean;
  productType: string;
  state: "in_stock" | "low" | "out" | "untracked";
  active: boolean;
};

export async function listInventory(
  db: Db,
  userId: string,
  publicId: string,
  opts: { search?: string; state?: string } = {},
): Promise<{ items: InventoryRowDto[] }> {
  const stateRaw = opts.state ?? "";
  if (!INVENTORY_STATES.has(stateRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте фильтр остатков.");

  const b = await requireBusiness(db, userId, publicId, "orders.write");
  const products = await db
    .selectFrom("product as p")
    .leftJoin("product_variant as v", (join) =>
      join
        .onRef("v.product_id", "=", "p.id")
        .onRef("v.business_id", "=", "p.business_id")
        .on("v.active", "=", true),
    )
    .select([
      "p.id as product_id",
      "p.name",
      "p.sku as product_sku",
      "p.stock_quantity as product_stock",
      "p.low_stock_threshold",
      "p.track_inventory",
      "p.product_type",
      "p.use_variants",
      "p.active as product_active",
      "v.id as variant_id",
      "v.label as variant_label",
      "v.sku as variant_sku",
      "v.stock_quantity as variant_stock",
      "v.active as variant_active",
    ])
    .where("p.business_id", "=", b.id)
    .where("p.product_type", "=", "product")
    .orderBy("p.name")
    .orderBy("v.label")
    .execute();

  const items: InventoryRowDto[] = [];
  for (const row of products) {
    if (row.use_variants && !row.variant_id) continue;
    if (!row.use_variants && row.variant_id) continue;
    const stock = row.use_variants ? row.variant_stock : row.product_stock;
    const threshold = row.low_stock_threshold;
    let state: InventoryRowDto["state"] = "untracked";
    if (row.track_inventory) {
      if (stock == null || stock <= 0) state = "out";
      else if (threshold != null && stock <= threshold) state = "low";
      else state = "in_stock";
    }
    if (stateRaw && stateRaw !== state) continue;
    const name = row.name;
    const sku = row.use_variants ? row.variant_sku : row.product_sku;
    if (opts.search) {
      const q = opts.search.toLowerCase();
      const hay = `${name} ${row.variant_label ?? ""} ${sku ?? ""}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    items.push({
      productId: row.product_id,
      variantId: row.variant_id,
      name,
      variantLabel: row.variant_label,
      sku,
      stockQuantity: stock,
      lowStockThreshold: threshold,
      trackInventory: row.track_inventory,
      productType: row.product_type,
      state,
      active: row.use_variants
        ? Boolean(row.variant_active && row.product_active)
        : Boolean(row.product_active),
    });
  }
  return { items };
}

export async function adjustInventory(
  db: Db,
  userId: string,
  publicId: string,
  body: Record<string, unknown>,
) {
  const productId = String(body.productId ?? body.product_id ?? "");
  requireUuid(productId);
  const variantRaw = body.variantId ?? body.variant_id;
  const variantId =
    variantRaw === null || variantRaw === undefined || variantRaw === ""
      ? null
      : String(variantRaw);
  if (variantId) requireUuid(variantId);

  const quantityRaw = body.quantity ?? body.stockQuantity ?? body.stock_quantity;
  const deltaRaw = body.delta;
  let mode: "set" | "delta" = "set";
  let value = 0;
  if (deltaRaw !== undefined) {
    mode = "delta";
    value = Number(deltaRaw);
  } else {
    value = Number(quantityRaw);
  }
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < -1_000_000 ||
    value > 1_000_000
  )
    throw new AppError(400, "INVALID_STOCK", "Проверьте количество.");

  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "orders.write");
    const product = await tx
      .selectFrom("product")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", productId)
      .forUpdate()
      .executeTakeFirst();
    if (!product)
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");
    if (product.product_type === "service")
      throw new AppError(400, "INVALID_STOCK", "У услуги нет складского учёта.");

    if (product.use_variants) {
      if (!variantId)
        throw new AppError(
          400,
          "INVALID_STOCK",
          "Для товара с вариантами укажите variantId.",
        );
    } else if (variantId) {
      throw new AppError(
        400,
        "INVALID_STOCK",
        "У этого товара нет вариантов.",
      );
    }

    let remaining: number | null = null;
    let delta = 0;

    if (variantId) {
      const variant = await tx
        .selectFrom("product_variant")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "=", productId)
        .where("id", "=", variantId)
        .forUpdate()
        .executeTakeFirst();
      if (!variant)
        throw new AppError(404, "VARIANT_NOT_FOUND", "Вариант не найден.");
      if (!variant.active)
        throw new AppError(
          400,
          "INVALID_STOCK",
          "Нельзя менять остаток неактивного варианта.",
        );
      // Ensure variant belongs to this product (already filtered) and business.
      if (variant.product_id !== productId)
        throw new AppError(404, "VARIANT_NOT_FOUND", "Вариант не найден.");

      const current = variant.stock_quantity ?? 0;
      remaining = mode === "set" ? value : current + value;
      if (remaining < 0)
        throw new AppError(
          400,
          "INVALID_STOCK",
          "Остаток не может быть отрицательным.",
        );
      delta = remaining - current;
      await tx
        .updateTable("product_variant")
        .set({
          stock_quantity: remaining,
          availability: remaining === 0 ? "out_of_stock" : "quantity",
          updated_at: new Date(),
        })
        .where("id", "=", variantId)
        .where("business_id", "=", b.id)
        .execute();
      // Manual quantity adjustment enables product-level inventory tracking.
      await tx
        .updateTable("product")
        .set({
          track_inventory: true,
          availability: "quantity",
          updated_at: new Date(),
        })
        .where("id", "=", productId)
        .where("business_id", "=", b.id)
        .execute();
    } else {
      const current = product.stock_quantity ?? 0;
      remaining = mode === "set" ? value : current + value;
      if (remaining < 0)
        throw new AppError(
          400,
          "INVALID_STOCK",
          "Остаток не может быть отрицательным.",
        );
      delta = remaining - current;
      await tx
        .updateTable("product")
        .set({
          stock_quantity: remaining,
          track_inventory: true,
          availability: remaining === 0 ? "out_of_stock" : "quantity",
          updated_at: new Date(),
        })
        .where("id", "=", productId)
        .where("business_id", "=", b.id)
        .execute();
    }

    await recordMovement(tx, {
      businessId: b.id,
      productId,
      variantId,
      delta,
      remaining,
      reason: "manual_adjustment",
      actorUserId: userId,
    });

    await audit(tx, b.id, userId, "inventory_adjusted", productId, {
      delta,
      remaining,
      variantId,
    });

    return {
      productId,
      variantId,
      stockQuantity: remaining,
      delta,
    };
  });
}

export async function recordMovement(
  db: Db | Transaction<Database>,
  input: {
    businessId: string;
    productId: string;
    variantId?: string | null;
    delta: number;
    remaining: number | null;
    reason: InventoryMovementReason;
    orderId?: string | null;
    actorUserId?: string | null;
  },
) {
  await db
    .insertInto("inventory_movement")
    .values({
      id: randomUUID(),
      business_id: input.businessId,
      product_id: input.productId,
      variant_id: input.variantId ?? null,
      delta: input.delta,
      remaining: input.remaining,
      reason: input.reason,
      order_id: input.orderId ?? null,
      actor_user_id: input.actorUserId ?? null,
    })
    .execute();
}
