import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { audit } from "../audit/service.ts";
import type { BusinessMode, OrderFulfillment } from "./schema.ts";

type Db = Kysely<Database>;

export type OrderSettingsDto = {
  customerCancelStatuses: string[];
  pickupEnabled: boolean;
  pickupAddress: string;
  pickupInstructions: string;
  deliveryEnabled: boolean;
  deliveryPrice: string;
  freeDeliveryFrom: string | null;
  minimumOrderAmount: string | null;
  deliveryDescription: string;
  businessMode: BusinessMode;
};

function money(raw: unknown, label: string): string {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? ""));
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000)
    throw new AppError(400, "INVALID_SETTINGS", `Проверьте ${label}.`);
  return n.toFixed(2);
}

function optionalMoney(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return money(raw, label);
}

/** Strict boolean — reject string "true"/"false" (Boolean("false") === true). */
function strictBoolean(raw: unknown, label: string): boolean {
  if (typeof raw === "boolean") return raw;
  throw new AppError(400, "INVALID_SETTINGS", `Проверьте ${label}.`);
}

function optionalStrictBoolean(
  raw: unknown,
  fallback: boolean,
  label: string,
): boolean {
  if (raw === undefined) return fallback;
  return strictBoolean(raw, label);
}

export async function ensureOrderSettings(db: Db, businessId: string) {
  await db
    .insertInto("order_settings")
    .values({ business_id: businessId })
    .onConflict((oc) => oc.column("business_id").doNothing())
    .execute();
}

export async function getOrderSettingsV2(
  db: Db,
  userId: string,
  publicId: string,
): Promise<OrderSettingsDto> {
  const b = await requireBusiness(db, userId, publicId, "orders.write");
  await ensureOrderSettings(db, b.id);
  const row = await db
    .selectFrom("order_settings")
    .selectAll()
    .where("business_id", "=", b.id)
    .executeTakeFirstOrThrow();
  return mapSettings(row);
}

function mapSettings(row: {
  customer_cancel_statuses: unknown;
  pickup_enabled: boolean;
  pickup_address: string;
  pickup_instructions: string;
  delivery_enabled: boolean;
  delivery_price: string;
  free_delivery_from: string | null;
  minimum_order_amount: string | null;
  delivery_description: string;
  business_mode: string;
}): OrderSettingsDto {
  const statuses = Array.isArray(row.customer_cancel_statuses)
    ? (row.customer_cancel_statuses as string[])
    : ["new", "accepted"];
  return {
    customerCancelStatuses: statuses,
    pickupEnabled: Boolean(row.pickup_enabled),
    pickupAddress: row.pickup_address ?? "",
    pickupInstructions: row.pickup_instructions ?? "",
    deliveryEnabled: Boolean(row.delivery_enabled),
    deliveryPrice: String(row.delivery_price ?? "0"),
    freeDeliveryFrom:
      row.free_delivery_from != null ? String(row.free_delivery_from) : null,
    minimumOrderAmount:
      row.minimum_order_amount != null
        ? String(row.minimum_order_amount)
        : null,
    deliveryDescription: row.delivery_description ?? "",
    businessMode: (row.business_mode as BusinessMode) || "store",
  };
}

export async function saveOrderSettingsV2(
  db: Db,
  userId: string,
  publicId: string,
  raw: Record<string, unknown>,
): Promise<OrderSettingsDto> {
  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "orders.write");
    if (b.role !== "owner" && b.role !== "admin")
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав для настроек.");

    await ensureOrderSettings(tx, b.id);
    const current = await tx
      .selectFrom("order_settings")
      .selectAll()
      .where("business_id", "=", b.id)
      .executeTakeFirstOrThrow();

    const allowedCancel = new Set(["new", "accepted", "assembling", "ready"]);
    let cancelStatuses = current.customer_cancel_statuses;
    if (
      raw.customerCancelStatuses != null ||
      raw.customer_cancel_statuses != null
    ) {
      const list = (raw.customerCancelStatuses ??
        raw.customer_cancel_statuses) as unknown;
      if (!Array.isArray(list))
        throw new AppError(400, "INVALID_SETTINGS", "Проверьте статусы отмены.");
      const next = list.map(String);
      if (next.some((s) => !allowedCancel.has(s)))
        throw new AppError(400, "INVALID_SETTINGS", "Проверьте статусы отмены.");
      cancelStatuses = next;
    }

    const modeRaw = raw.businessMode ?? raw.business_mode;
    let businessMode = current.business_mode as BusinessMode;
    if (modeRaw != null) {
      if (!["store", "service", "combined"].includes(String(modeRaw)))
        throw new AppError(400, "INVALID_SETTINGS", "Проверьте тип бизнеса.");
      businessMode = String(modeRaw) as BusinessMode;
    }

    const pickupEnabled = optionalStrictBoolean(
      raw.pickupEnabled !== undefined ? raw.pickupEnabled : raw.pickup_enabled,
      current.pickup_enabled,
      "самовывоз",
    );
    const deliveryEnabled = optionalStrictBoolean(
      raw.deliveryEnabled !== undefined
        ? raw.deliveryEnabled
        : raw.delivery_enabled,
      current.delivery_enabled,
      "доставку",
    );
    if (!pickupEnabled && !deliveryEnabled)
      throw new AppError(
        400,
        "INVALID_SETTINGS",
        "Включите доставку или самовывоз.",
      );

    const patch = {
      customer_cancel_statuses: cancelStatuses,
      pickup_enabled: pickupEnabled,
      pickup_address: String(
        raw.pickupAddress ?? raw.pickup_address ?? current.pickup_address ?? "",
      ).slice(0, 500),
      pickup_instructions: String(
        raw.pickupInstructions ??
          raw.pickup_instructions ??
          current.pickup_instructions ??
          "",
      ).slice(0, 2000),
      delivery_enabled: deliveryEnabled,
      delivery_price: money(
        raw.deliveryPrice ?? raw.delivery_price ?? current.delivery_price ?? 0,
        "стоимость доставки",
      ),
      free_delivery_from: optionalMoney(
        raw.freeDeliveryFrom !== undefined
          ? raw.freeDeliveryFrom
          : raw.free_delivery_from !== undefined
            ? raw.free_delivery_from
            : current.free_delivery_from,
        "порог бесплатной доставки",
      ),
      minimum_order_amount: optionalMoney(
        raw.minimumOrderAmount !== undefined
          ? raw.minimumOrderAmount
          : raw.minimum_order_amount !== undefined
            ? raw.minimum_order_amount
            : current.minimum_order_amount,
        "минимальную сумму",
      ),
      delivery_description: String(
        raw.deliveryDescription ??
          raw.delivery_description ??
          current.delivery_description ??
          "",
      ).slice(0, 2000),
      business_mode: businessMode,
      updated_at: new Date(),
    };

    await tx
      .updateTable("order_settings")
      .set(patch)
      .where("business_id", "=", b.id)
      .execute();

    await audit(tx, b.id, userId, "settings_changed", b.id, {
      scope: "order_settings",
      businessMode,
    });

    return mapSettings({ ...current, ...patch });
  });
}

/** Internal: load settings for checkout / bot without CRM user. */
export async function loadOrderSettingsForBusiness(db: Db, businessId: string) {
  await ensureOrderSettings(db, businessId);
  return db
    .selectFrom("order_settings")
    .selectAll()
    .where("business_id", "=", businessId)
    .executeTakeFirstOrThrow();
}

export function calculateDeliveryFee(
  settings: {
    pickup_enabled: boolean;
    delivery_enabled: boolean;
    delivery_price: string;
    free_delivery_from: string | null;
  },
  fulfillment: OrderFulfillment,
  subtotal: number,
): number {
  if (fulfillment === "pickup") {
    if (!settings.pickup_enabled)
      throw new AppError(400, "FULFILLMENT_DISABLED", "Самовывоз недоступен.");
    return 0;
  }
  if (!settings.delivery_enabled)
    throw new AppError(400, "FULFILLMENT_DISABLED", "Доставка недоступна.");
  const fee = Number(settings.delivery_price) || 0;
  const freeFrom =
    settings.free_delivery_from != null
      ? Number(settings.free_delivery_from)
      : null;
  if (freeFrom != null && Number.isFinite(freeFrom) && subtotal >= freeFrom)
    return 0;
  return fee;
}

export function assertMinimumOrderAmount(
  settings: { minimum_order_amount: string | null },
  subtotal: number,
) {
  if (settings.minimum_order_amount == null) return;
  const min = Number(settings.minimum_order_amount);
  if (Number.isFinite(min) && subtotal < min)
    throw new AppError(
      400,
      "MINIMUM_ORDER",
      `Минимальная сумма заказа ${min.toFixed(2)}.`,
    );
}

export function availableFulfillments(settings: {
  pickup_enabled: boolean;
  delivery_enabled: boolean;
}): OrderFulfillment[] {
  const out: OrderFulfillment[] = [];
  if (settings.delivery_enabled) out.push("delivery");
  if (settings.pickup_enabled) out.push("pickup");
  return out;
}
