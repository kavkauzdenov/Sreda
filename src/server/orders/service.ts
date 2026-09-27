import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { audit } from "../audit/service.ts";
import {
  clientActivity,
  matchClient,
  normalizeIdentity,
} from "../clients/service.ts";
import { notify, resolveByEventKey } from "../notifications/service.ts";
import { assertEntitlement } from "../billing/entitlement.ts";
import { evaluateLowStockCrossing } from "./low-stock.ts";
import type {
  CartPlatform,
  OrderFulfillment,
  OrderStatus,
  ProductAvailability,
} from "./schema.ts";

async function maybeEmitLowStock(
  tx: Transaction<Database>,
  businessId: string,
  input: {
    productId: string;
    productName: string;
    variantId?: string | null;
    previousStock: number;
    nextStock: number;
    threshold: number | null | undefined;
  },
) {
  const crossing = evaluateLowStockCrossing(input);
  if (!crossing.crossed || !crossing.eventKey) return;
  await notify(
    tx,
    businessId,
    "inventory.low_stock",
    crossing.eventKey,
    `Низкий остаток: ${input.productName} (${input.nextStock})`,
    "/orders",
  );
}

const fail = (message = "Проверьте параметры заказа.") =>
  new AppError(400, "INVALID_ORDER", message);

function isUniqueViolation(error: unknown) {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    String((error as { code: unknown }).code) === "23505"
  );
}

async function withSavepoint<T>(
  tx: Transaction<Database>,
  name: string,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  await sql.raw(`SAVEPOINT ${name}`).execute(tx);
  try {
    const value = await run();
    await sql.raw(`RELEASE SAVEPOINT ${name}`).execute(tx);
    return { ok: true, value };
  } catch (error) {
    await sql.raw(`ROLLBACK TO SAVEPOINT ${name}`).execute(tx);
    return { ok: false, error };
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const AVAILABILITIES: ProductAvailability[] = [
  "quantity",
  "in_stock",
  "made_to_order",
  "out_of_stock",
];

const PLATFORMS: CartPlatform[] = ["telegram", "vk", "web"];

const ORDER_STATUSES: OrderStatus[] = [
  "new",
  "accepted",
  "assembling",
  "ready",
  "handed_over",
  "delivered",
  "completed",
  "cancelled",
];

/** Allowed forward transitions; cancelled handled separately from early states. */
const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["assembling", "cancelled"],
  assembling: ["ready", "cancelled"],
  ready: ["handed_over", "delivered", "cancelled"],
  handed_over: ["completed"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
};

function id(value: unknown) {
  if (typeof value !== "string" || !UUID_RE.test(value)) throw fail();
  return value;
}

function optionalId(value: unknown) {
  if (value == null || value === "") return null;
  return id(value);
}

function text(
  value: unknown,
  min: number,
  max: number,
  message: string,
) {
  if (typeof value !== "string") throw fail(message);
  const trimmed = value.trim();
  if (trimmed.length < min || value.length > max) throw fail(message);
  return trimmed;
}

function optionalText(value: unknown, max: number, fallback = "") {
  if (value == null) return fallback;
  if (typeof value !== "string" || value.length > max) throw fail();
  return value;
}

function integer(value: unknown, min: number, max: number) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw fail();
  return value;
}

function money(value: unknown, message = "Проверьте цену.") {
  const raw =
    typeof value === "number"
      ? value.toFixed(2)
      : typeof value === "string"
        ? value.trim()
        : null;
  if (raw === null || !/^\d{1,10}(\.\d{1,2})?$/.test(raw) || Number(raw) < 0)
    throw fail(message);
  return raw;
}

function optionalMoney(value: unknown) {
  if (value == null || value === "") return null;
  return money(value);
}

function availability(value: unknown): ProductAvailability {
  if (
    typeof value !== "string" ||
    !AVAILABILITIES.includes(value as ProductAvailability)
  )
    throw fail("Проверьте доступность товара.");
  return value as ProductAvailability;
}

function platform(value: unknown): CartPlatform {
  if (typeof value !== "string" || !PLATFORMS.includes(value as CartPlatform))
    throw fail("Проверьте площадку.");
  return value as CartPlatform;
}

function fulfillment(value: unknown): OrderFulfillment {
  if (value !== "delivery" && value !== "pickup")
    throw fail("Выберите доставку или самовывоз.");
  return value;
}

function requestKey(value: unknown) {
  const key = String(value ?? "");
  if (!/^[a-zA-Z0-9:_-]{8,200}$/.test(key))
    throw fail("Проверьте ключ запроса.");
  return key;
}

function phone(value: unknown) {
  if (typeof value !== "string" || !value.trim())
    throw fail("Укажите телефон.");
  return normalizeIdentity({ kind: "phone", value }).value;
}

function isSellable(mode: ProductAvailability, stock: number | null) {
  if (mode === "out_of_stock") return false;
  if (mode === "quantity") return (stock ?? 0) > 0;
  return true;
}

function tracksQuantity(
  trackInventory: boolean,
  mode: ProductAvailability,
) {
  return trackInventory && mode === "quantity";
}

function linePrice(
  productPrice: string,
  variantPrice: string | null | undefined,
) {
  return variantPrice != null && variantPrice !== ""
    ? variantPrice
    : productPrice;
}

function multiplyMoney(unit: string, qty: number) {
  return (Math.round(Number(unit) * qty * 100) / 100).toFixed(2);
}

async function allocateOrderNumber(
  tx: Transaction<Database>,
  businessId: string,
): Promise<number> {
  await tx
    .insertInto("business_order_seq")
    .values({ business_id: businessId, next_number: 1001 })
    .onConflict((oc) => oc.column("business_id").doNothing())
    .execute();
  const seq = await tx
    .selectFrom("business_order_seq")
    .select("next_number")
    .where("business_id", "=", businessId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const orderNumber = seq.next_number;
  await tx
    .updateTable("business_order_seq")
    .set({ next_number: orderNumber + 1 })
    .where("business_id", "=", businessId)
    .execute();
  return orderNumber;
}

export function formatOrderLabel(orderNumber: number | null | undefined) {
  return orderNumber != null ? "Заказ №" + orderNumber : "Заказ";
}

/** Run work in a new transaction, or inline when `db` is already one. */
function runInTx<T>(
  db: Kysely<Database>,
  fn: (tx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  if (db.isTransaction) return fn(db as Transaction<Database>);
  return db.transaction().execute(fn);
}

async function writeStatusHistory(
  tx: Transaction<Database>,
  businessId: string,
  orderId: string,
  from: OrderStatus | null,
  to: OrderStatus,
  actor: string | null,
  note = "",
) {
  await tx
    .insertInto("order_status_history")
    .values({
      id: randomUUID(),
      business_id: businessId,
      order_id: orderId,
      from_status: from,
      to_status: to,
      actor_user_id: actor,
      note,
    })
    .execute();
}

async function assertAttachment(
  tx: Kysely<Database>,
  businessId: string,
  attachmentId: string,
) {
  const row = await tx
    .selectFrom("attachment")
    .select("id")
    .where("business_id", "=", businessId)
    .where("id", "=", attachmentId)
    .executeTakeFirst();
  if (!row)
    throw new AppError(404, "ATTACHMENT_NOT_FOUND", "Файл не найден.");
}

async function replaceProductImages(
  tx: Transaction<Database>,
  businessId: string,
  productId: string,
  images: unknown,
) {
  if (images == null) return;
  if (!Array.isArray(images) || images.length > 20) throw fail();
  const attachmentIds = images.map((item) => {
    if (typeof item === "string") return id(item);
    if (item && typeof item === "object" && "attachment_id" in item)
      return id((item as { attachment_id: unknown }).attachment_id);
    throw fail("Проверьте изображения товара.");
  });
  for (const attachmentId of attachmentIds)
    await assertAttachment(tx, businessId, attachmentId);
  await tx
    .deleteFrom("product_image")
    .where("business_id", "=", businessId)
    .where("product_id", "=", productId)
    .execute();
  let position = 0;
  for (const attachmentId of attachmentIds) {
    await tx
      .insertInto("product_image")
      .values({
        id: randomUUID(),
        business_id: businessId,
        product_id: productId,
        attachment_id: attachmentId,
        position: position++,
      })
      .execute();
  }
}

async function replaceProductOptionGroups(
  tx: Transaction<Database>,
  businessId: string,
  productId: string,
  groups: unknown,
) {
  if (groups == null) return;
  if (!Array.isArray(groups) || groups.length > 5)
    throw fail("Не больше 5 групп опций.");
  const existingGroups = await tx
    .selectFrom("product_option_group")
    .select("id")
    .where("business_id", "=", businessId)
    .where("product_id", "=", productId)
    .execute();
  const existingOptions = await tx
    .selectFrom("product_option as o")
    .innerJoin("product_option_group as g", "g.id", "o.group_id")
    .select(["o.id", "o.group_id"])
    .where("o.business_id", "=", businessId)
    .where("g.business_id", "=", businessId)
    .where("g.product_id", "=", productId)
    .execute();
  const keepGroups = new Set<string>();
  const keepOptions = new Set<string>();
  let groupPos = 0;
  for (const raw of groups) {
    if (!raw || typeof raw !== "object") throw fail();
    const body = raw as Record<string, unknown>;
    const groupId = body.id ? id(body.id) : randomUUID();
    keepGroups.add(groupId);
    const groupValue = {
      id: groupId,
      business_id: businessId,
      product_id: productId,
      name: text(body.name, 1, 80, "Укажите название группы опций."),
      position:
        body.position == null
          ? groupPos
          : integer(body.position, 0, 100000),
    };
    groupPos += 1;
    if (existingGroups.some((row) => row.id === groupId)) {
      await tx
        .updateTable("product_option_group")
        .set(groupValue)
        .where("business_id", "=", businessId)
        .where("id", "=", groupId)
        .execute();
    } else {
      await tx.insertInto("product_option_group").values(groupValue).execute();
    }
    if (!Array.isArray(body.options) || body.options.length > 20)
      throw fail("Не больше 20 опций в группе.");
    let optionPos = 0;
    for (const rawOption of body.options) {
      if (!rawOption || typeof rawOption !== "object") throw fail();
      const optionBody = rawOption as Record<string, unknown>;
      const optionId = optionBody.id ? id(optionBody.id) : randomUUID();
      keepOptions.add(optionId);
      const optionValue = {
        id: optionId,
        business_id: businessId,
        group_id: groupId,
        name: text(optionBody.name, 1, 80, "Укажите название опции."),
        position:
          optionBody.position == null
            ? optionPos
            : integer(optionBody.position, 0, 100000),
      };
      optionPos += 1;
      const existingOption = existingOptions.find((row) => row.id === optionId);
      if (existingOption) {
        await tx
          .updateTable("product_option")
          .set(optionValue)
          .where("business_id", "=", businessId)
          .where("id", "=", optionId)
          .execute();
      } else {
        await tx.insertInto("product_option").values(optionValue).execute();
      }
    }
  }
  for (const row of existingOptions) {
    if (keepOptions.has(row.id)) continue;
    await tx
      .deleteFrom("product_option")
      .where("business_id", "=", businessId)
      .where("id", "=", row.id)
      .execute();
  }
  for (const row of existingGroups) {
    if (keepGroups.has(row.id)) continue;
    await tx
      .deleteFrom("product_option")
      .where("business_id", "=", businessId)
      .where("group_id", "=", row.id)
      .execute();
    await tx
      .deleteFrom("product_option_group")
      .where("business_id", "=", businessId)
      .where("id", "=", row.id)
      .execute();
  }
}

async function replaceProductVariants(
  tx: Transaction<Database>,
  businessId: string,
  productId: string,
  variants: unknown,
  opts?: { forceNullPrices?: boolean },
) {
  if (variants == null) return;
  if (!Array.isArray(variants) || variants.length > 100) throw fail();
  const existing = await tx
    .selectFrom("product_variant")
    .select("id")
    .where("business_id", "=", businessId)
    .where("product_id", "=", productId)
    .execute();
  const productOptions = await tx
    .selectFrom("product_option as o")
    .innerJoin("product_option_group as g", "g.id", "o.group_id")
    .select(["o.id", "o.group_id"])
    .where("o.business_id", "=", businessId)
    .where("g.business_id", "=", businessId)
    .where("g.product_id", "=", productId)
    .execute();
  const optionById = new Map(productOptions.map((o) => [o.id, o.group_id]));
  const keep = new Set<string>();
  const seenCombos = new Set<string>();
  for (const raw of variants) {
    if (!raw || typeof raw !== "object") throw fail();
    const body = raw as Record<string, unknown>;
    const variantId = body.id ? id(body.id) : randomUUID();
    keep.add(variantId);
    const optionIds = Array.isArray(body.option_ids)
      ? body.option_ids.map(id)
      : [];
    if (new Set(optionIds).size !== optionIds.length)
      throw fail("Вариант содержит повторяющиеся опции.");
    const groups = new Set<string>();
    for (const optionId of optionIds) {
      const groupId = optionById.get(optionId);
      if (!groupId)
        throw fail("Опция варианта должна принадлежать этому товару.");
      if (groups.has(groupId))
        throw fail("В варианте не больше одной опции из группы.");
      groups.add(groupId);
    }
    if (optionIds.length) {
      const combo = [...optionIds].sort().join("\0");
      if (seenCombos.has(combo))
        throw fail("Два варианта с одинаковым набором опций.");
      seenCombos.add(combo);
    }
    const mode = availability(body.availability ?? "in_stock");
    const stock =
      mode === "quantity"
        ? integer(body.stock_quantity ?? 0, 0, 1_000_000)
        : null;
    const value = {
      id: variantId,
      business_id: businessId,
      product_id: productId,
      option_ids: JSON.stringify(optionIds),
      label: optionalText(body.label, 200),
      sku:
        body.sku == null || body.sku === ""
          ? null
          : text(body.sku, 1, 64, "Проверьте артикул."),
      price: opts?.forceNullPrices ? null : optionalMoney(body.price),
      availability: mode,
      stock_quantity: stock,
      active: body.active === false ? false : true,
      updated_at: new Date(),
    };
    if (existing.some((row) => row.id === variantId)) {
      await tx
        .updateTable("product_variant")
        .set(value)
        .where("business_id", "=", businessId)
        .where("id", "=", variantId)
        .execute();
    } else {
      await tx.insertInto("product_variant").values(value).execute();
    }
  }
  for (const row of existing) {
    if (keep.has(row.id)) continue;
    await tx
      .updateTable("product_variant")
      .set({ active: false, updated_at: new Date() })
      .where("business_id", "=", businessId)
      .where("id", "=", row.id)
      .execute();
  }
}

/** Returns true when quantity-tracked stock was actually decremented. */
async function decrementStock(
  tx: Transaction<Database>,
  businessId: string,
  productId: string,
  variantId: string | null,
  quantity: number,
): Promise<boolean> {
  if (variantId) {
    const variant = await tx
      .selectFrom("product_variant")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("id", "=", variantId)
      .where("product_id", "=", productId)
      .forUpdate()
      .executeTakeFirst();
    if (!variant)
      throw new AppError(404, "VARIANT_NOT_FOUND", "Вариант не найден.");
    const product = await tx
      .selectFrom("product")
      .select([
        "track_inventory",
        "active",
        "use_variants",
        "name",
        "low_stock_threshold",
      ])
      .where("business_id", "=", businessId)
      .where("id", "=", productId)
      .forUpdate()
      .executeTakeFirst();
    if (!product?.active)
      throw new AppError(409, "PRODUCT_UNAVAILABLE", "Товар недоступен.");
    if (!product.use_variants)
      throw fail("Этот товар больше не использует варианты.");
    if (!variant.active)
      throw new AppError(409, "PRODUCT_UNAVAILABLE", "Товар недоступен.");
    if (!isSellable(variant.availability, variant.stock_quantity))
      throw new AppError(409, "OUT_OF_STOCK", "Недостаточно товара на складе.");
    if (
      tracksQuantity(product.track_inventory, variant.availability)
    ) {
      const stock = variant.stock_quantity ?? 0;
      if (stock < quantity)
        throw new AppError(
          409,
          "OUT_OF_STOCK",
          "Недостаточно товара на складе.",
        );
      const remaining = stock - quantity;
      await tx
        .updateTable("product_variant")
        .set({
          stock_quantity: remaining,
          updated_at: new Date(),
          ...(remaining === 0 ? { availability: "out_of_stock" } : {}),
        })
        .where("business_id", "=", businessId)
        .where("id", "=", variantId)
        .execute();
      await audit(
        tx,
        businessId,
        null,
        "inventory_adjusted",
        variantId,
        {
          product_id: productId,
          delta: -quantity,
          remaining,
        },
        "system",
      );
      await maybeEmitLowStock(tx, businessId, {
        productId,
        productName: product.name,
        variantId,
        previousStock: stock,
        nextStock: remaining,
        threshold: product.low_stock_threshold,
      });
      return true;
    }
    return false;
  }

  const product = await tx
    .selectFrom("product")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("id", "=", productId)
    .forUpdate()
    .executeTakeFirst();
  if (!product?.active)
    throw new AppError(409, "PRODUCT_UNAVAILABLE", "Товар недоступен.");
  if (product.use_variants)
    throw fail("Выберите вариант товара.");
  if (!isSellable(product.availability, product.stock_quantity))
    throw new AppError(409, "OUT_OF_STOCK", "Недостаточно товара на складе.");
  if (tracksQuantity(product.track_inventory, product.availability)) {
    const stock = product.stock_quantity ?? 0;
    if (stock < quantity)
      throw new AppError(409, "OUT_OF_STOCK", "Недостаточно товара на складе.");
    const remaining = stock - quantity;
    await tx
      .updateTable("product")
      .set({
        stock_quantity: remaining,
        updated_at: new Date(),
        ...(remaining === 0 ? { availability: "out_of_stock" } : {}),
      })
      .where("business_id", "=", businessId)
      .where("id", "=", productId)
      .execute();
    await audit(
      tx,
      businessId,
      null,
      "inventory_adjusted",
      productId,
      { delta: -quantity, remaining },
      "system",
    );
    await maybeEmitLowStock(tx, businessId, {
      productId,
      productName: product.name,
      previousStock: stock,
      nextStock: remaining,
      threshold: product.low_stock_threshold,
    });
    return true;
  }
  return false;
}

/**
 * Restore stock that was actually deducted at checkout.
 * Does not re-infer from the live catalog mode (merchant may have changed it).
 */
async function restoreStock(
  tx: Transaction<Database>,
  businessId: string,
  productId: string,
  variantId: string | null,
  quantity: number,
) {
  if (variantId) {
    const variant = await tx
      .selectFrom("product_variant")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("id", "=", variantId)
      .where("product_id", "=", productId)
      .forUpdate()
      .executeTakeFirst();
    if (!variant) return;
    await tx
      .selectFrom("product")
      .select("id")
      .where("business_id", "=", businessId)
      .where("id", "=", productId)
      .forUpdate()
      .executeTakeFirst();
    const stock = (variant.stock_quantity ?? 0) + quantity;
    await tx
      .updateTable("product_variant")
      .set({
        stock_quantity: stock,
        availability: "quantity",
        updated_at: new Date(),
      })
      .where("business_id", "=", businessId)
      .where("id", "=", variantId)
      .execute();
    await audit(
      tx,
      businessId,
      null,
      "inventory_adjusted",
      variantId,
      {
        product_id: productId,
        delta: quantity,
        remaining: stock,
        reason: "order_cancelled",
      },
      "system",
    );
    return;
  }

  const product = await tx
    .selectFrom("product")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("id", "=", productId)
    .forUpdate()
    .executeTakeFirst();
  if (!product) return;
  const stock = (product.stock_quantity ?? 0) + quantity;
  await tx
    .updateTable("product")
    .set({
      stock_quantity: stock,
      availability: "quantity",
      track_inventory: true,
      updated_at: new Date(),
    })
    .where("business_id", "=", businessId)
    .where("id", "=", productId)
    .execute();
  await audit(
    tx,
    businessId,
    null,
    "inventory_adjusted",
    productId,
    { delta: quantity, remaining: stock, reason: "order_cancelled" },
    "system",
  );
}

async function restoreOrderInventory(
  tx: Transaction<Database>,
  businessId: string,
  orderId: string,
) {
  const items = await tx
    .selectFrom("order_item")
    .select(["product_id", "variant_id", "quantity", "stock_deducted"])
    .where("business_id", "=", businessId)
    .where("order_id", "=", orderId)
    .execute();
  for (const item of items) {
    if (!item.product_id || !item.stock_deducted) continue;
    await restoreStock(
      tx,
      businessId,
      item.product_id,
      item.variant_id,
      item.quantity,
    );
  }
}

export class CatalogService {
  constructor(private db: Kysely<Database>) {}

  async listCategories(userId: string, publicId: string) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    return this.db
      .selectFrom("product_category")
      .selectAll()
      .where("business_id", "=", b.id)
      .orderBy("position")
      .orderBy("name")
      .execute();
  }

  async saveCategory(
    userId: string,
    publicId: string,
    body: Record<string, unknown>,
    categoryId?: string,
  ) {
    return runInTx(this.db, async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "orders.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "orders.write");
      const key = categoryId ? id(categoryId) : body.id ? id(body.id) : randomUUID();
      const value = {
        id: key,
        business_id: b.id,
        name: text(body.name, 1, 120, "Укажите название категории."),
        description: optionalText(body.description, 2000),
        position: integer(body.position ?? 0, 0, 100000),
        active: body.active === false ? false : true,
        updated_at: new Date(),
      };
      if (categoryId || body.id) {
        const changed = await tx
          .updateTable("product_category")
          .set(value)
          .where("business_id", "=", b.id)
          .where("id", "=", key)
          .returning("id")
          .executeTakeFirst();
        if (!changed)
          throw new AppError(404, "CATEGORY_NOT_FOUND", "Категория не найдена.");
        await audit(tx, b.id, userId, "product_updated", key, {
          kind: "category",
        });
      } else {
        await tx.insertInto("product_category").values(value).execute();
        await audit(tx, b.id, userId, "product_created", key, {
          kind: "category",
        });
      }
      return { id: key };
    });
  }

  async deleteCategory(userId: string, publicId: string, categoryId: string) {
    return runInTx(this.db, async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "orders.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      const key = id(categoryId);
      await tx
        .updateTable("product")
        .set({ category_id: null, updated_at: new Date() })
        .where("business_id", "=", b.id)
        .where("category_id", "=", key)
        .execute();
      const deleted = await tx
        .deleteFrom("product_category")
        .where("business_id", "=", b.id)
        .where("id", "=", key)
        .returning("id")
        .executeTakeFirst();
      if (!deleted)
        throw new AppError(404, "CATEGORY_NOT_FOUND", "Категория не найдена.");
      await audit(tx, b.id, userId, "product_updated", key, {
        kind: "category_deleted",
      });
      return { ok: true };
    });
  }

  async listProducts(userId: string, publicId: string, categoryId?: string) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    let q = this.db
      .selectFrom("product")
      .selectAll()
      .where("business_id", "=", b.id)
      .orderBy("position")
      .orderBy("name");
    if (categoryId) q = q.where("category_id", "=", id(categoryId));
    const products = await q.execute();
    const ids = products.map((p) => p.id);
    if (!ids.length) return [];
    const [images, variants] = await Promise.all([
      this.db
        .selectFrom("product_image")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "in", ids)
        .orderBy("position")
        .execute(),
      this.db
        .selectFrom("product_variant")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "in", ids)
        .orderBy("created_at")
        .execute(),
    ]);
    return products.map((product) => ({
      ...product,
      images: images.filter((row) => row.product_id === product.id),
      variants: variants.filter((row) => row.product_id === product.id),
    }));
  }

  async getProduct(userId: string, publicId: string, productId: string) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    const product = await this.db
      .selectFrom("product")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", id(productId))
      .executeTakeFirst();
    if (!product)
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");
    const [images, variants, groups, options] = await Promise.all([
      this.db
        .selectFrom("product_image")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "=", product.id)
        .orderBy("position")
        .execute(),
      this.db
        .selectFrom("product_variant")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "=", product.id)
        .execute(),
      this.db
        .selectFrom("product_option_group")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("product_id", "=", product.id)
        .orderBy("position")
        .execute(),
      this.db
        .selectFrom("product_option as o")
        .innerJoin("product_option_group as g", "g.id", "o.group_id")
        .selectAll("o")
        .where("o.business_id", "=", b.id)
        .where("g.product_id", "=", product.id)
        .orderBy("o.position")
        .execute(),
    ]);
    return { ...product, images, variants, option_groups: groups, options };
  }

  async saveProduct(
    userId: string,
    publicId: string,
    body: Record<string, unknown>,
    productId?: string,
  ) {
    return runInTx(this.db, async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "orders.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "orders.write");
      const key = productId
        ? id(productId)
        : body.id
          ? id(body.id)
          : randomUUID();
      const updating = !!(productId || body.id);
      const existing = updating
        ? await tx
            .selectFrom("product")
            .selectAll()
            .where("business_id", "=", b.id)
            .where("id", "=", key)
            .executeTakeFirst()
        : undefined;
      if (updating && !existing)
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");

      const has = (field: string) =>
        Object.prototype.hasOwnProperty.call(body, field);

      let categoryId: string | null;
      if (has("category_id")) {
        categoryId = optionalId(body.category_id);
        if (categoryId) {
          const category = await tx
            .selectFrom("product_category")
            .select("id")
            .where("business_id", "=", b.id)
            .where("id", "=", categoryId)
            .executeTakeFirst();
          if (!category)
            throw new AppError(
              404,
              "CATEGORY_NOT_FOUND",
              "Категория не найдена.",
            );
        }
      } else if (existing) {
        categoryId = existing.category_id;
      } else {
        categoryId = optionalId(body.category_id);
        if (categoryId) {
          const category = await tx
            .selectFrom("product_category")
            .select("id")
            .where("business_id", "=", b.id)
            .where("id", "=", categoryId)
            .executeTakeFirst();
          if (!category)
            throw new AppError(
              404,
              "CATEGORY_NOT_FOUND",
              "Категория не найдена.",
            );
        }
      }

      const mode = availability(
        has("availability")
          ? body.availability
          : (existing?.availability ?? "in_stock"),
      );
      const trackInventory = has("track_inventory")
        ? body.track_inventory === true
        : (existing?.track_inventory ?? false);
      const stock =
        mode === "quantity"
          ? integer(
              has("stock_quantity")
                ? (body.stock_quantity ?? 0)
                : (existing?.stock_quantity ?? 0),
              0,
              1_000_000,
            )
          : null;
      if (trackInventory && mode === "quantity" && stock === null)
        throw fail("Укажите количество на складе.");

      const currencyRaw = has("currency")
        ? String(body.currency ?? "RUB")
        : (existing?.currency ?? "RUB");
      if (!/^[A-Z]{3}$/.test(currencyRaw)) throw fail();

      const value = {
        id: key,
        business_id: b.id,
        category_id: categoryId,
        name: text(
          has("name") ? body.name : (existing?.name ?? body.name),
          1,
          200,
          "Укажите название товара.",
        ),
        description: has("description")
          ? optionalText(body.description, 8000)
          : (existing?.description ?? optionalText(body.description, 8000)),
        price: money(has("price") ? body.price : (existing?.price ?? body.price)),
        compare_at_price: has("compare_at_price")
          ? optionalMoney(body.compare_at_price)
          : (existing?.compare_at_price ?? optionalMoney(body.compare_at_price)),
        currency: currencyRaw,
        sku: has("sku")
          ? body.sku == null || body.sku === ""
            ? null
            : text(body.sku, 1, 64, "Проверьте артикул.")
          : (existing?.sku ??
            (body.sku == null || body.sku === ""
              ? null
              : text(body.sku, 1, 64, "Проверьте артикул."))),
        active: has("active")
          ? body.active === false
            ? false
            : true
          : (existing?.active ?? true),
        position: integer(
          has("position") ? (body.position ?? 0) : (existing?.position ?? 0),
          0,
          100000,
        ),
        use_variants: has("use_variants")
          ? body.use_variants === true
          : (existing?.use_variants ?? false),
        variant_prices_enabled: has("variant_prices_enabled")
          ? body.variant_prices_enabled === true
          : (existing?.variant_prices_enabled ?? false),
        track_inventory: trackInventory,
        availability: mode,
        stock_quantity: stock,
        updated_at: new Date(),
      };
      if (updating) {
        await tx
          .updateTable("product")
          .set(value)
          .where("business_id", "=", b.id)
          .where("id", "=", key)
          .execute();
        await audit(tx, b.id, userId, "product_updated", key);
      } else {
        await tx.insertInto("product").values(value).execute();
        await audit(tx, b.id, userId, "product_created", key);
      }
      await replaceProductImages(tx, b.id, key, body.images);
      if (!value.use_variants) {
        await replaceProductOptionGroups(tx, b.id, key, []);
        await replaceProductVariants(tx, b.id, key, []);
      } else {
        if (has("option_groups"))
          await replaceProductOptionGroups(tx, b.id, key, body.option_groups);
        await replaceProductVariants(tx, b.id, key, body.variants, {
          forceNullPrices: !value.variant_prices_enabled,
        });
      }
      return { id: key };
    });
  }

  async deleteProduct(userId: string, publicId: string, productId: string) {
    return runInTx(this.db, async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "orders.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      const key = id(productId);
      const changed = await tx
        .updateTable("product")
        .set({ active: false, updated_at: new Date() })
        .where("business_id", "=", b.id)
        .where("id", "=", key)
        .returning("id")
        .executeTakeFirst();
      if (!changed)
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");
      await audit(tx, b.id, userId, "product_updated", key, {
        soft_deleted: true,
      });
      return { ok: true };
    });
  }

  /** Public catalog for bot / unauthenticated channel flows. */
  async catalogForBusiness(businessId: string) {
    const categories = await this.db
      .selectFrom("product_category")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("active", "=", true)
      .orderBy("position")
      .orderBy("name")
      .execute();
    const products = await this.db
      .selectFrom("product")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("active", "=", true)
      .orderBy("position")
      .orderBy("name")
      .execute();
    const ids = products.map((p) => p.id);
    const [images, variants] = ids.length
      ? await Promise.all([
          this.db
            .selectFrom("product_image")
            .selectAll()
            .where("business_id", "=", businessId)
            .where("product_id", "in", ids)
            .orderBy("position")
            .execute(),
          this.db
            .selectFrom("product_variant")
            .selectAll()
            .where("business_id", "=", businessId)
            .where("product_id", "in", ids)
            .where("active", "=", true)
            .orderBy("created_at")
            .execute(),
        ])
      : [[], []];
    return {
      categories,
      products: products.map((product) => ({
        ...product,
        images: images.filter((row) => row.product_id === product.id),
        variants: variants.filter((row) => row.product_id === product.id),
      })),
    };
  }

  async productForBusiness(businessId: string, productId: string) {
    const product = await this.db
      .selectFrom("product")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("id", "=", id(productId))
      .where("active", "=", true)
      .executeTakeFirst();
    if (!product)
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");
    const [images, variants] = await Promise.all([
      this.db
        .selectFrom("product_image")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("product_id", "=", product.id)
        .orderBy("position")
        .execute(),
      this.db
        .selectFrom("product_variant")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("product_id", "=", product.id)
        .where("active", "=", true)
        .execute(),
    ]);
    return { ...product, images, variants };
  }
}

export class OrderService {
  constructor(private db: Kysely<Database>) {}

  async getOrCreateCart(
    tx: Transaction<Database>,
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
  ) {
    const existing = await tx
      .selectFrom("cart")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("platform", "=", platform)
      .where("external_user_id", "=", externalUserId)
      .forUpdate()
      .executeTakeFirst();
    if (existing) return existing;
    const cart = {
      id: randomUUID(),
      business_id: businessId,
      client_id: null as string | null,
      platform,
      external_user_id: externalUserId,
      updated_at: new Date(),
    };
    const inserted = await withSavepoint(tx, "cart_create", async () => {
      await tx.insertInto("cart").values(cart).execute();
      return cart;
    });
    if (inserted.ok) return inserted.value;
    if (!isUniqueViolation(inserted.error)) throw inserted.error;
    const raced = await tx
      .selectFrom("cart")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("platform", "=", platform)
      .where("external_user_id", "=", externalUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!raced) throw inserted.error;
    return raced;
  }

  private async loadCart(
    tx: Kysely<Database>,
    businessId: string,
    cartId: string,
    cart: {
      id: string;
      business_id: string;
      client_id: string | null;
      platform: CartPlatform;
      external_user_id: string;
      updated_at: Date;
    },
  ) {
    const items = await tx
      .selectFrom("cart_item as i")
      .innerJoin("product as p", "p.id", "i.product_id")
      .leftJoin("product_variant as v", "v.id", "i.variant_id")
      .select([
        "i.id",
        "i.product_id",
        "i.variant_id",
        "i.quantity",
        "p.name as product_name",
        "p.price as product_price",
        "p.currency",
        "p.availability as product_availability",
        "p.stock_quantity as product_stock",
        "p.track_inventory",
        "p.use_variants",
        "p.active as product_active",
        "v.label as variant_label",
        "v.price as variant_price",
        "v.availability as variant_availability",
        "v.stock_quantity as variant_stock",
        "v.active as variant_active",
      ])
      .where("i.business_id", "=", businessId)
      .where("i.cart_id", "=", cartId)
      .orderBy("i.created_at")
      .execute();
    return { ...cart, items };
  }

  async getCart(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
  ) {
    return runInTx(this.db, async (tx) => {
      const cart = await this.getOrCreateCart(
        tx,
        businessId,
        platform,
        externalUserId,
      );
      return this.loadCart(tx, businessId, cart.id, cart);
    });
  }

  async addCartItem(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
    body: Record<string, unknown>,
  ) {
    return runInTx(this.db, async (tx) => {
      const cart = await this.getOrCreateCart(
        tx,
        businessId,
        platform,
        externalUserId,
      );
      const productId = id(body.product_id);
      const variantId = optionalId(body.variant_id);
      const quantity = integer(body.quantity ?? 1, 1, 999);
      const product = await tx
        .selectFrom("product")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("id", "=", productId)
        .forUpdate()
        .executeTakeFirst();
      if (!product?.active)
        throw new AppError(404, "PRODUCT_NOT_FOUND", "Товар не найден.");
      if (product.use_variants && !variantId)
        throw fail("Выберите вариант товара.");
      if (!product.use_variants && variantId) throw fail();
      let variant: {
        availability: ProductAvailability;
        stock_quantity: number | null;
        active: boolean;
      } | null = null;
      if (variantId) {
        const row = await tx
          .selectFrom("product_variant")
          .selectAll()
          .where("business_id", "=", businessId)
          .where("id", "=", variantId)
          .where("product_id", "=", productId)
          .forUpdate()
          .executeTakeFirst();
        if (!row?.active)
          throw new AppError(404, "VARIANT_NOT_FOUND", "Вариант не найден.");
        variant = row;
      }
      const mode = variant?.availability ?? product.availability;
      const stock = variant?.stock_quantity ?? product.stock_quantity;
      if (!isSellable(mode, stock))
        throw new AppError(409, "OUT_OF_STOCK", "Товар недоступен.");
      if (
        tracksQuantity(product.track_inventory, mode) &&
        (stock ?? 0) < quantity
      )
        throw new AppError(
          409,
          "OUT_OF_STOCK",
          "Недостаточно товара на складе.",
        );
      const existing = await tx
        .selectFrom("cart_item")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("cart_id", "=", cart.id)
        .where("product_id", "=", productId)
        .where("variant_id", variantId === null ? "is" : "=", variantId)
        .forUpdate()
        .executeTakeFirst();
      if (existing) {
        const next = existing.quantity + quantity;
        if (next > 999) throw fail("Слишком много позиций.");
        if (
          tracksQuantity(product.track_inventory, mode) &&
          (stock ?? 0) < next
        )
          throw new AppError(
            409,
            "OUT_OF_STOCK",
            "Недостаточно товара на складе.",
          );
        await tx
          .updateTable("cart_item")
          .set({ quantity: next, updated_at: new Date() })
          .where("business_id", "=", businessId)
          .where("id", "=", existing.id)
          .execute();
      } else {
        const inserted = await withSavepoint(tx, "cart_item_insert", async () => {
          await tx
            .insertInto("cart_item")
            .values({
              id: randomUUID(),
              business_id: businessId,
              cart_id: cart.id,
              product_id: productId,
              variant_id: variantId,
              quantity,
            })
            .execute();
        });
        if (!inserted.ok) {
          if (!isUniqueViolation(inserted.error)) throw inserted.error;
          const raced = await tx
            .selectFrom("cart_item")
            .selectAll()
            .where("business_id", "=", businessId)
            .where("cart_id", "=", cart.id)
            .where("product_id", "=", productId)
            .where("variant_id", variantId === null ? "is" : "=", variantId)
            .forUpdate()
            .executeTakeFirst();
          if (!raced) throw inserted.error;
          const next = raced.quantity + quantity;
          if (next > 999) throw fail("Слишком много позиций.");
          if (
            tracksQuantity(product.track_inventory, mode) &&
            (stock ?? 0) < next
          )
            throw new AppError(
              409,
              "OUT_OF_STOCK",
              "Недостаточно товара на складе.",
            );
          await tx
            .updateTable("cart_item")
            .set({ quantity: next, updated_at: new Date() })
            .where("business_id", "=", businessId)
            .where("id", "=", raced.id)
            .execute();
        }
      }
      await tx
        .updateTable("cart")
        .set({ updated_at: new Date() })
        .where("business_id", "=", businessId)
        .where("id", "=", cart.id)
        .execute();
      return this.loadCart(tx, businessId, cart.id, {
        ...cart,
        updated_at: new Date(),
      });
    });
  }

  async updateCartItem(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
    itemId: string,
    quantity: unknown,
  ) {
    return runInTx(this.db, async (tx) => {
      const cart = await this.getOrCreateCart(
        tx,
        businessId,
        platform,
        externalUserId,
      );
      const qty = integer(quantity, 1, 999);
      const item = await tx
        .selectFrom("cart_item")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("cart_id", "=", cart.id)
        .where("id", "=", id(itemId))
        .forUpdate()
        .executeTakeFirst();
      if (!item)
        throw new AppError(404, "CART_ITEM_NOT_FOUND", "Позиция не найдена.");
      const product = await tx
        .selectFrom("product")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("id", "=", item.product_id)
        .forUpdate()
        .executeTakeFirst();
      if (!product?.active)
        throw new AppError(409, "PRODUCT_UNAVAILABLE", "Товар недоступен.");
      let mode = product.availability;
      let stock = product.stock_quantity;
      if (item.variant_id) {
        const variant = await tx
          .selectFrom("product_variant")
          .selectAll()
          .where("business_id", "=", businessId)
          .where("id", "=", item.variant_id)
          .forUpdate()
          .executeTakeFirst();
        if (!variant?.active)
          throw new AppError(409, "PRODUCT_UNAVAILABLE", "Товар недоступен.");
        mode = variant.availability;
        stock = variant.stock_quantity;
      }
      if (
        tracksQuantity(product.track_inventory, mode) &&
        (stock ?? 0) < qty
      )
        throw new AppError(
          409,
          "OUT_OF_STOCK",
          "Недостаточно товара на складе.",
        );
      await tx
        .updateTable("cart_item")
        .set({ quantity: qty, updated_at: new Date() })
        .where("business_id", "=", businessId)
        .where("id", "=", item.id)
        .execute();
      await tx
        .updateTable("cart")
        .set({ updated_at: new Date() })
        .where("business_id", "=", businessId)
        .where("id", "=", cart.id)
        .execute();
      return this.loadCart(tx, businessId, cart.id, {
        ...cart,
        updated_at: new Date(),
      });
    });
  }

  async removeCartItem(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
    itemId: string,
  ) {
    return runInTx(this.db, async (tx) => {
      const cart = await this.getOrCreateCart(
        tx,
        businessId,
        platform,
        externalUserId,
      );
      await tx
        .deleteFrom("cart_item")
        .where("business_id", "=", businessId)
        .where("cart_id", "=", cart.id)
        .where("id", "=", id(itemId))
        .execute();
      await tx
        .updateTable("cart")
        .set({ updated_at: new Date() })
        .where("business_id", "=", businessId)
        .where("id", "=", cart.id)
        .execute();
      return this.loadCart(tx, businessId, cart.id, {
        ...cart,
        updated_at: new Date(),
      });
    });
  }

  async clearCart(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
  ) {
    return runInTx(this.db, async (tx) => {
      const cart = await this.getOrCreateCart(
        tx,
        businessId,
        platform,
        externalUserId,
      );
      await tx
        .deleteFrom("cart_item")
        .where("business_id", "=", businessId)
        .where("cart_id", "=", cart.id)
        .execute();
      await tx
        .updateTable("cart")
        .set({ updated_at: new Date() })
        .where("business_id", "=", businessId)
        .where("id", "=", cart.id)
        .execute();
      return { ...cart, items: [] };
    });
  }

  async checkout(
    businessId: string,
    body: Record<string, unknown>,
    actor: string | null = null,
  ) {
    return runInTx(this.db, async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .where("archived_at", "is", null)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await assertEntitlement(tx, businessId, "orders");

      const key = requestKey(body.request_key);
      const source = platform(body.source ?? body.platform);
      const externalUserId =
        typeof body.external_user_id === "string"
          ? body.external_user_id.slice(0, 200)
          : "";
      let customerName = text(
        body.customer_name ?? body.name,
        1,
        120,
        "Укажите имя.",
      );
      let customerPhone = phone(body.customer_phone ?? body.phone);
      const orderFulfillment = fulfillment(body.fulfillment);
      const deliveryAddress =
        orderFulfillment === "delivery"
          ? text(
              body.delivery_address,
              1,
              500,
              "Укажите адрес доставки.",
            )
          : optionalText(body.delivery_address, 500);
      const comment = optionalText(body.comment, 2000);
      const conversationId = optionalId(body.conversation_id);
      const explicitClientId = optionalId(body.client_id ?? body.clientId);

      let clientId: string | null = null;
      if (explicitClientId) {
        const existingClient = await tx
          .selectFrom("client")
          .select(["id", "name", "phone"])
          .where("business_id", "=", businessId)
          .where("id", "=", explicitClientId)
          .where("archived_at", "is", null)
          .executeTakeFirst();
        if (!existingClient)
          throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
        clientId = existingClient.id;
        if (existingClient.name) customerName = existingClient.name.slice(0, 120);
        if (existingClient.phone) {
          try {
            customerPhone = phone(existingClient.phone);
          } catch {
            /* keep body phone if stored value is unexpected */
          }
        }
      }

      const hashPayload = {
        source,
        external_user_id: externalUserId,
        customer_name: customerName,
        customer_phone: customerPhone,
        fulfillment: orderFulfillment,
        delivery_address: deliveryAddress,
        comment,
        cart: body.cart_items ?? null,
        client_id: clientId,
      };
      const hash = createHash("sha256")
        .update(JSON.stringify(hashPayload))
        .digest("hex");

      const duplicate = await tx
        .selectFrom("order")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("request_key", "=", key)
        .executeTakeFirst();
      if (duplicate) {
        if (duplicate.request_hash !== hash)
          throw new AppError(
            409,
            "REQUEST_CONFLICT",
            "Запрос уже использован.",
          );
        return duplicate;
      }

      let cartItems: {
        product_id: string;
        variant_id: string | null;
        quantity: number;
      }[] = [];

      if (Array.isArray(body.cart_items) && body.cart_items.length) {
        cartItems = body.cart_items.map((raw) => {
          if (!raw || typeof raw !== "object") throw fail();
          const item = raw as Record<string, unknown>;
          return {
            product_id: id(item.product_id),
            variant_id: optionalId(item.variant_id),
            quantity: integer(item.quantity, 1, 999),
          };
        });
      } else {
        const cart = await this.getOrCreateCart(
          tx,
          businessId,
          source,
          externalUserId,
        );
        const items = await tx
          .selectFrom("cart_item")
          .selectAll()
          .where("business_id", "=", businessId)
          .where("cart_id", "=", cart.id)
          .forUpdate()
          .execute();
        if (!items.length)
          throw new AppError(400, "CART_EMPTY", "Корзина пуста.");
        cartItems = items.map((item) => ({
          product_id: item.product_id,
          variant_id: item.variant_id,
          quantity: item.quantity,
        }));
      }

      if (!cartItems.length)
        throw new AppError(400, "CART_EMPTY", "Корзина пуста.");

      if (!clientId) {
        const identities: {
          kind: "telegram" | "vk" | "phone";
          value: string;
          username?: string | null;
        }[] = [{ kind: "phone", value: customerPhone }];
        if (source === "telegram" && externalUserId)
          identities.push({ kind: "telegram", value: externalUserId });
        if (source === "vk" && externalUserId)
          identities.push({ kind: "vk", value: externalUserId });

        clientId = await matchClient(tx, businessId, {
          name: customerName,
          phone: customerPhone,
          identities,
        });
      }

      const snapshot: {
        product_id: string;
        variant_id: string | null;
        name: string;
        variant_label: string;
        sku: string | null;
        unit_price: string;
        quantity: number;
        line_total: string;
        stock_deducted: boolean;
      }[] = [];
      let currency: string | null = null;
      let totalCents = 0;

      for (const item of cartItems) {
        const product = await tx
          .selectFrom("product")
          .selectAll()
          .where("business_id", "=", businessId)
          .where("id", "=", item.product_id)
          .executeTakeFirstOrThrow();
        if (currency == null) currency = product.currency;
        else if (currency !== product.currency)
          throw new AppError(
            400,
            "MIXED_CURRENCY",
            "В одном заказе должны быть товары одной валюты.",
          );
        const stockDeducted = await decrementStock(
          tx,
          businessId,
          item.product_id,
          item.variant_id,
          item.quantity,
        );
        let variantLabel = "";
        let variantSku: string | null = null;
        let unit = product.price;
        if (item.variant_id) {
          const variant = await tx
            .selectFrom("product_variant")
            .selectAll()
            .where("business_id", "=", businessId)
            .where("id", "=", item.variant_id)
            .executeTakeFirstOrThrow();
          variantLabel = variant.label;
          variantSku = variant.sku;
          unit = linePrice(product.price, variant.price);
        }
        const lineTotal = multiplyMoney(unit, item.quantity);
        totalCents += Math.round(Number(lineTotal) * 100);
        snapshot.push({
          product_id: product.id,
          variant_id: item.variant_id,
          name: product.name,
          variant_label: variantLabel,
          sku: variantSku ?? product.sku,
          unit_price: unit,
          quantity: item.quantity,
          line_total: lineTotal,
          stock_deducted: stockDeducted,
        });
      }

      const orderId = randomUUID();
      const total = (totalCents / 100).toFixed(2);
      const orderNumber = await allocateOrderNumber(tx, businessId);
      const order = await tx
        .insertInto("order")
        .values({
          id: orderId,
          business_id: businessId,
          client_id: clientId,
          status: "new",
          fulfillment: orderFulfillment,
          customer_name: customerName,
          customer_phone: customerPhone,
          delivery_address: deliveryAddress,
          comment,
          currency: currency ?? "RUB",
          total,
          items_snapshot: JSON.stringify(snapshot),
          source,
          request_key: key,
          request_hash: hash,
          conversation_id: conversationId,
          inventory_restored_at: null,
          order_number: orderNumber,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      for (const line of snapshot) {
        await tx
          .insertInto("order_item")
          .values({
            id: randomUUID(),
            business_id: businessId,
            order_id: orderId,
            product_id: line.product_id,
            variant_id: line.variant_id,
            name: line.name,
            variant_label: line.variant_label,
            sku: line.sku,
            unit_price: line.unit_price,
            quantity: line.quantity,
            line_total: line.line_total,
            stock_deducted: line.stock_deducted,
          })
          .execute();
      }

      await writeStatusHistory(tx, businessId, orderId, null, "new", actor);

      if (externalUserId) {
        const cart = await tx
          .selectFrom("cart")
          .select("id")
          .where("business_id", "=", businessId)
          .where("platform", "=", source)
          .where("external_user_id", "=", externalUserId)
          .executeTakeFirst();
        if (cart) {
          await tx
            .deleteFrom("cart_item")
            .where("business_id", "=", businessId)
            .where("cart_id", "=", cart.id)
            .execute();
          await tx
            .updateTable("cart")
            .set({ client_id: clientId, updated_at: new Date() })
            .where("business_id", "=", businessId)
            .where("id", "=", cart.id)
            .execute();
        }
      }

      await clientActivity(
        tx,
        businessId,
        clientId,
        "order.created",
        "order:" + orderId,
        orderId,
        actor,
      );
      await notify(
        tx,
        businessId,
        "order.created",
        "order:" + orderId,
        formatOrderLabel(orderNumber) +
          ": " +
          customerName +
          "\n" +
          total +
          " " +
          (currency ?? "RUB"),
        "/orders?id=" + orderId,
      );
      await audit(tx, businessId, actor, "order_created", orderId, {
        source,
        total,
        client_id: clientId,
      });
      return order;
    });
  }

  async checkoutForBusiness(
    userId: string,
    publicId: string,
    body: Record<string, unknown>,
  ) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    return this.checkout(b.id, body, userId);
  }

  async list(userId: string, publicId: string, status?: string, page = 0) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw fail();
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    let q = this.db
      .selectFrom("order as o")
      .innerJoin("client as c", (join) =>
        join
          .onRef("c.id", "=", "o.client_id")
          .onRef("c.business_id", "=", "o.business_id"),
      )
      .selectAll("o")
      .select(["c.name as client_name", "c.phone as client_phone"])
      .where("o.business_id", "=", b.id)
      .orderBy("o.created_at", "desc")
      .orderBy("o.id")
      .limit(100)
      .offset(page * 100);
    if (status) {
      if (!ORDER_STATUSES.includes(status as OrderStatus))
        throw fail("Проверьте статус.");
      q = q.where("o.status", "=", status as OrderStatus);
    }
    return q.execute();
  }

  async listByClient(
    userId: string,
    publicId: string,
    clientId: string,
    page = 0,
  ) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000) throw fail();
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    const key = id(clientId);
    return this.db
      .selectFrom("order")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("client_id", "=", key)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(100)
      .offset(page * 100)
      .execute();
  }

  async get(userId: string, publicId: string, orderId: string) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    const order = await this.db
      .selectFrom("order as o")
      .innerJoin("client as c", (join) =>
        join
          .onRef("c.id", "=", "o.client_id")
          .onRef("c.business_id", "=", "o.business_id"),
      )
      .selectAll("o")
      .select(["c.name as client_name", "c.phone as client_phone"])
      .where("o.business_id", "=", b.id)
      .where("o.id", "=", id(orderId))
      .executeTakeFirst();
    if (!order)
      throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");
    const [items, history] = await Promise.all([
      this.db
        .selectFrom("order_item")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("order_id", "=", order.id)
        .execute(),
      this.db
        .selectFrom("order_status_history")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("order_id", "=", order.id)
        .orderBy("created_at")
        .execute(),
    ]);
    return { ...order, items, history };
  }

  async transitionStatus(
    userId: string,
    publicId: string,
    orderId: string,
    body: Record<string, unknown>,
  ) {
    return runInTx(this.db, async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "orders.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "orders.write");
      const current = await tx
        .selectFrom("order")
        .selectAll()
        .where("business_id", "=", b.id)
        .where("id", "=", id(orderId))
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");
      const next = String(body.status ?? body.to_status);
      if (!ORDER_STATUSES.includes(next as OrderStatus))
        throw fail("Проверьте статус.");
      const to = next as OrderStatus;
      const allowed = STATUS_FLOW[current.status];
      if (!allowed.includes(to))
        throw new AppError(
          409,
          "INVALID_STATUS_TRANSITION",
          "Этот статус недоступен для текущего заказа.",
        );
      const note = optionalText(body.note, 2000);
      let inventoryRestoredAt = current.inventory_restored_at;
      if (to === "cancelled" && !current.inventory_restored_at) {
        await restoreOrderInventory(tx, b.id, current.id);
        inventoryRestoredAt = new Date();
      }
      await tx
        .updateTable("order")
        .set({
          status: to,
          updated_at: new Date(),
          ...(inventoryRestoredAt && !current.inventory_restored_at
            ? { inventory_restored_at: inventoryRestoredAt }
            : {}),
        })
        .where("business_id", "=", b.id)
        .where("id", "=", current.id)
        .execute();
      await writeStatusHistory(
        tx,
        b.id,
        current.id,
        current.status,
        to,
        userId,
        note,
      );
      await clientActivity(
        tx,
        b.id,
        current.client_id,
        "order.status",
        "order:" + current.id + ":" + to + ":" + randomUUID(),
        current.id,
        userId,
      );
      await audit(tx, b.id, userId, "order_status_changed", current.id, {
        from: current.status,
        to,
        inventory_restored: !!(
          inventoryRestoredAt && !current.inventory_restored_at
        ),
        ...(typeof body.channel === "string" &&
        (body.channel === "telegram" ||
          body.channel === "vk" ||
          body.channel === "web")
          ? { channel: body.channel }
          : {}),
      });
      if (to === "cancelled" || to === "completed")
        await resolveByEventKey(tx, b.id, "order:" + current.id);
      return { id: current.id, status: to };
    });
  }

  async getOrderSettings(userId: string, publicId: string) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    const row = await this.db
      .selectFrom("order_settings")
      .selectAll()
      .where("business_id", "=", b.id)
      .executeTakeFirst();
    const statuses = Array.isArray(row?.customer_cancel_statuses)
      ? (row!.customer_cancel_statuses as string[])
      : typeof row?.customer_cancel_statuses === "string"
        ? (JSON.parse(row.customer_cancel_statuses as string) as string[])
        : ["new", "accepted"];
    return {
      customer_cancel_statuses: statuses.filter((s) =>
        ORDER_STATUSES.includes(s as OrderStatus),
      ),
    };
  }

  async saveOrderSettings(
    userId: string,
    publicId: string,
    body: Record<string, unknown>,
  ) {
    const b = await requireBusiness(this.db, userId, publicId, "orders.write");
    const raw = Array.isArray(body.customer_cancel_statuses)
      ? body.customer_cancel_statuses.map(String)
      : ["new", "accepted"];
    const statuses = [
      ...new Set(
        raw.filter((s) =>
          ["new", "accepted", "assembling", "ready"].includes(s),
        ),
      ),
    ];
    await this.db
      .insertInto("order_settings")
      .values({
        business_id: b.id,
        customer_cancel_statuses: statuses,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.column("business_id").doUpdateSet({
          customer_cancel_statuses: statuses,
          updated_at: new Date(),
        }),
      )
      .execute();
    return { customer_cancel_statuses: statuses };
  }

  async listForCustomer(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
  ) {
    const identity = normalizeIdentity({
      kind: platform === "web" ? "phone" : platform,
      value: externalUserId,
    });
    const link = await this.db
      .selectFrom("client_identity")
      .select("client_id")
      .where("business_id", "=", businessId)
      .where("kind", "=", identity.kind)
      .where("value", "=", identity.value)
      .executeTakeFirst();
    if (!link) return [];
    return this.db
      .selectFrom("order")
      .select([
        "id",
        "order_number",
        "status",
        "total",
        "currency",
        "items_snapshot",
        "created_at",
      ])
      .where("business_id", "=", businessId)
      .where("client_id", "=", link.client_id)
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();
  }

  async cancelForCustomer(
    businessId: string,
    platform: CartPlatform,
    externalUserId: string,
    orderId: string,
  ) {
    return runInTx(this.db, async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const identity = normalizeIdentity({
        kind: platform === "web" ? "phone" : platform,
        value: externalUserId,
      });
      const link = await tx
        .selectFrom("client_identity")
        .select("client_id")
        .where("business_id", "=", businessId)
        .where("kind", "=", identity.kind)
        .where("value", "=", identity.value)
        .executeTakeFirst();
      if (!link)
        throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");
      const current = await tx
        .selectFrom("order")
        .selectAll()
        .where("business_id", "=", businessId)
        .where("id", "=", id(orderId))
        .where("client_id", "=", link.client_id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");
      const settings = await tx
        .selectFrom("order_settings")
        .select("customer_cancel_statuses")
        .where("business_id", "=", businessId)
        .executeTakeFirst();
      let allowed = ["new", "accepted"];
      if (Array.isArray(settings?.customer_cancel_statuses))
        allowed = settings!.customer_cancel_statuses as string[];
      else if (typeof settings?.customer_cancel_statuses === "string") {
        try {
          allowed = JSON.parse(settings.customer_cancel_statuses) as string[];
        } catch {
          allowed = ["new", "accepted"];
        }
      }
      if (!allowed.includes(current.status))
        throw new AppError(
          403,
          "ORDER_CANCEL_DENIED",
          "Этот заказ уже нельзя отменить.",
        );
      if (current.status === "cancelled")
        return { id: current.id, status: "cancelled" as const };
      let inventoryRestoredAt = current.inventory_restored_at;
      if (!current.inventory_restored_at) {
        await restoreOrderInventory(tx, businessId, current.id);
        inventoryRestoredAt = new Date();
      }
      await tx
        .updateTable("order")
        .set({
          status: "cancelled",
          updated_at: new Date(),
          ...(inventoryRestoredAt && !current.inventory_restored_at
            ? { inventory_restored_at: inventoryRestoredAt }
            : {}),
        })
        .where("business_id", "=", businessId)
        .where("id", "=", current.id)
        .execute();
      await writeStatusHistory(
        tx,
        businessId,
        current.id,
        current.status,
        "cancelled",
        null,
        "Отмена клиентом",
      );
      await clientActivity(
        tx,
        businessId,
        current.client_id,
        "order.status",
        "order:" + current.id + ":cancelled:customer:" + randomUUID(),
        current.id,
        null,
      );
      await audit(
        tx,
        businessId,
        null,
        "order_status_changed",
        current.id,
        {
          from: current.status,
          to: "cancelled",
          channel: platform,
          by: "customer",
          inventory_restored: !!(
            inventoryRestoredAt && !current.inventory_restored_at
          ),
        },
        "client",
      );
      return { id: current.id, status: "cancelled" as const };
    });
  }
}
