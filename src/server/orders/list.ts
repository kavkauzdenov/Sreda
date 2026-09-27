import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { localDay, localInstants } from "../booking/time.ts";
import {
  ORDER_STATUSES,
  IN_PROGRESS_STATUSES,
  REVENUE_STATUSES,
  type CartPlatform,
  type OrderFulfillment,
  type OrderStatus,
} from "./schema.ts";

type Db = Kysely<Database>;

export type OrderListFilters = {
  search: string;
  status: OrderStatus | "";
  source: CartPlatform | "";
  fulfillment: OrderFulfillment | "";
  date: "today" | "7d" | "30d" | "";
  assignedUserId: string | "none" | "";
  limit: number;
  cursor?: string;
};

export type OrderListItemDto = {
  id: string;
  orderNumber: number | null;
  status: OrderStatus;
  fulfillment: OrderFulfillment;
  source: CartPlatform;
  customerName: string;
  customerPhone: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  currency: string;
  total: string;
  subtotal: string | null;
  deliveryFee: string;
  itemCount: number;
  createdAt: string;
  assignedUser: { id: string; name: string } | null;
  conversationId: string | null;
};

export type OrderListResponse = {
  items: OrderListItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type OrderSummary = {
  newCount: number;
  inProgressCount: number;
  todayRevenue: { currency: string; amount: string }[];
  averageCheck: { currency: string; amount: string }[];
  timezone: string;
};

const SOURCES = new Set(["telegram", "vk", "web", ""]);
const FULFILLMENTS = new Set(["delivery", "pickup", ""]);
const DATES = new Set(["today", "7d", "30d", ""]);

export function encodeOrderCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: createdAt.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

export function decodeOrderCursor(cursor: string): { t: string; id: string } {
  try {
    const raw = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { t?: unknown; id?: unknown };
    if (typeof raw.t !== "string" || typeof raw.id !== "string")
      throw new Error("bad");
    return { t: raw.t, id: raw.id };
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Обновите список заказов.");
  }
}

function optionalUuidParam(
  value: string | null,
  label: string,
): string | undefined {
  if (value == null || value === "") return undefined;
  try {
    requireUuid(value);
  } catch {
    throw new AppError(400, "INVALID_FILTER", `Некорректный ${label}.`);
  }
  return value;
}

export function parseOrderListFilters(
  params: URLSearchParams,
): OrderListFilters {
  const limitRaw = params.get("limit");
  let limit = 50;
  if (limitRaw != null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100)
      throw new AppError(400, "INVALID_FILTER", "Лимит должен быть от 1 до 100.");
    limit = n;
  }

  const statusRaw = params.get("status") ?? "";
  if (statusRaw && !ORDER_STATUSES.includes(statusRaw as OrderStatus))
    throw new AppError(400, "INVALID_FILTER", "Проверьте статус.");

  const sourceRaw = params.get("source") ?? params.get("channel") ?? "";
  if (!SOURCES.has(sourceRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте канал.");

  const fulfillmentRaw = params.get("fulfillment") ?? "";
  if (!FULFILLMENTS.has(fulfillmentRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте способ получения.");

  const dateRaw = params.get("date") ?? params.get("period") ?? "";
  if (!DATES.has(dateRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте период.");

  const assignedRaw = params.get("assignedUserId") ?? params.get("assigned") ?? "";
  let assignedUserId: OrderListFilters["assignedUserId"] = "";
  if (assignedRaw === "none" || assignedRaw === "unassigned")
    assignedUserId = "none";
  else if (assignedRaw)
    assignedUserId = optionalUuidParam(assignedRaw, "ответственный") ?? "";

  const cursor = params.get("cursor") ?? undefined;
  if (cursor) {
    const decoded = decodeOrderCursor(cursor);
    requireUuid(decoded.id);
  }

  return {
    search: (params.get("search") ?? params.get("q") ?? "").trim().slice(0, 100),
    status: statusRaw as OrderStatus | "",
    source: sourceRaw as CartPlatform | "",
    fulfillment: fulfillmentRaw as OrderFulfillment | "",
    date: dateRaw as OrderListFilters["date"],
    assignedUserId,
    limit,
    cursor,
  };
}

function normalizePhoneSearch(search: string): string | null {
  const digits = search.replace(/\D+/g, "");
  if (digits.length < 7) return null;
  let normalized = digits;
  if (normalized.length === 11 && normalized.startsWith("8"))
    normalized = "7" + normalized.slice(1);
  return normalized;
}

export async function listOrdersV2(
  db: Db,
  userId: string,
  publicId: string,
  filters: OrderListFilters,
): Promise<OrderListResponse> {
  const b = await requireBusiness(db, userId, publicId, "orders.write");
  const business = await db
    .selectFrom("business")
    .select("timezone")
    .where("id", "=", b.id)
    .executeTakeFirstOrThrow();
  const timezone = business.timezone || "UTC";

  let q = db
    .selectFrom("order as o")
    .innerJoin("client as c", (join) =>
      join
        .onRef("c.id", "=", "o.client_id")
        .onRef("c.business_id", "=", "o.business_id"),
    )
    .leftJoin("user as u", "u.id", "o.assigned_user_id")
    .select([
      "o.id",
      "o.order_number",
      "o.status",
      "o.fulfillment",
      "o.source",
      "o.customer_name",
      "o.customer_phone",
      "o.client_id",
      "o.currency",
      "o.total",
      "o.subtotal",
      "o.delivery_fee",
      "o.created_at",
      "o.conversation_id",
      "o.assigned_user_id",
      "c.name as client_name",
      "c.phone as client_phone",
      "u.name as assigned_name",
      sql<number>`coalesce(
        (select sum(oi.quantity)::int from order_item oi
         where oi.business_id = o.business_id and oi.order_id = o.id),
        0
      )`.as("item_count"),
    ])
    .where("o.business_id", "=", b.id);

  if (filters.status) q = q.where("o.status", "=", filters.status);
  if (filters.source) q = q.where("o.source", "=", filters.source);
  if (filters.fulfillment)
    q = q.where("o.fulfillment", "=", filters.fulfillment);
  if (filters.assignedUserId === "none")
    q = q.where("o.assigned_user_id", "is", null);
  else if (filters.assignedUserId)
    q = q.where("o.assigned_user_id", "=", filters.assignedUserId);

  if (filters.date === "today") {
    const day = localDay(new Date(), timezone);
    const start = localInstants(day, 0, timezone)[0];
    if (!start)
      throw new AppError(500, "TIMEZONE_ERROR", "Не удалось вычислить локальный день.");
    const nextDay = new Date(+start + 36 * 3600000);
    const nextDayStr = localDay(nextDay, timezone);
    const end = localInstants(nextDayStr, 0, timezone)[0];
    if (!end)
      throw new AppError(500, "TIMEZONE_ERROR", "Не удалось вычислить локальный день.");
    q = q.where("o.created_at", ">=", start).where("o.created_at", "<", end);
  } else if (filters.date === "7d") {
    q = q.where(
      "o.created_at",
      ">=",
      new Date(Date.now() - 7 * 86400000),
    );
  } else if (filters.date === "30d") {
    q = q.where(
      "o.created_at",
      ">=",
      new Date(Date.now() - 30 * 86400000),
    );
  }

  if (filters.search) {
    const term = filters.search;
    const phone = normalizePhoneSearch(term);
    const like = `%${term.replace(/[%_]/g, "\\$&")}%`;
    const numberMatch =
      /^\d{1,9}$/.test(term) && Number.isSafeInteger(Number(term))
        ? Number(term)
        : null;
    q = q.where((eb) => {
      const parts = [
        eb("o.customer_name", "ilike", like),
        eb("c.name", "ilike", like),
        eb("o.customer_phone", "ilike", like),
        sql<boolean>`exists (
          select 1 from order_item oi
          where oi.business_id = o.business_id
            and oi.order_id = o.id
            and (oi.name ilike ${like} or coalesce(oi.sku,'') ilike ${like})
        )`,
      ];
      if (numberMatch != null) parts.push(eb("o.order_number", "=", numberMatch));
      if (phone) {
        parts.push(
          sql<boolean>`regexp_replace(coalesce(o.customer_phone,''), '\\D', '', 'g') like ${"%" + phone}`,
        );
        parts.push(
          sql<boolean>`regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') like ${"%" + phone}`,
        );
      }
      return eb.or(parts);
    });
  }

  if (filters.cursor) {
    const decoded = decodeOrderCursor(filters.cursor);
    const at = new Date(decoded.t);
    if (Number.isNaN(at.getTime()))
      throw new AppError(400, "INVALID_CURSOR", "Обновите список заказов.");
    q = q.where((eb) =>
      eb.or([
        eb("o.created_at", "<", at),
        eb.and([eb("o.created_at", "=", at), eb("o.id", "<", decoded.id)]),
      ]),
    );
  }

  const rows = await q
    .orderBy("o.created_at", "desc")
    .orderBy("o.id", "desc")
    .limit(filters.limit + 1)
    .execute();

  const hasMore = rows.length > filters.limit;
  const page = hasMore ? rows.slice(0, filters.limit) : rows;
  const items: OrderListItemDto[] = page.map((row) => ({
    id: row.id,
    orderNumber: row.order_number,
    status: row.status as OrderStatus,
    fulfillment: row.fulfillment as OrderFulfillment,
    source: row.source as CartPlatform,
    customerName: row.customer_name,
    customerPhone: row.customer_phone,
    clientId: row.client_id,
    clientName: row.client_name,
    clientPhone: row.client_phone,
    currency: row.currency,
    total: String(row.total),
    subtotal: row.subtotal != null ? String(row.subtotal) : null,
    deliveryFee: String(row.delivery_fee ?? "0"),
    itemCount: Number(row.item_count) || 0,
    createdAt: row.created_at.toISOString(),
    assignedUser: row.assigned_user_id
      ? { id: row.assigned_user_id, name: row.assigned_name || "Сотрудник" }
      : null,
    conversationId: row.conversation_id,
  }));

  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeOrderCursor(last.created_at, last.id)
        : null,
    hasMore,
  };
}

export async function getOrderSummary(
  db: Db,
  userId: string,
  publicId: string,
): Promise<OrderSummary> {
  const b = await requireBusiness(db, userId, publicId, "orders.write");
  const business = await db
    .selectFrom("business")
    .select("timezone")
    .where("id", "=", b.id)
    .executeTakeFirstOrThrow();
  const timezone = business.timezone || "UTC";
  const day = localDay(new Date(), timezone);
  const start = localInstants(day, 0, timezone)[0];
  if (!start)
    throw new AppError(500, "TIMEZONE_ERROR", "Не удалось вычислить локальный день.");
  const nextDay = new Date(+start + 36 * 3600000);
  const nextDayStr = localDay(nextDay, timezone);
  const end = localInstants(nextDayStr, 0, timezone)[0];
  if (!end)
    throw new AppError(500, "TIMEZONE_ERROR", "Не удалось вычислить локальный день.");

  const counts = await db
    .selectFrom("order")
    .select([
      sql<number>`count(*) filter (where status = 'new')::int`.as("new_count"),
      sql<number>`count(*) filter (where status in (${sql.join(
        IN_PROGRESS_STATUSES.map((s) => sql.lit(s)),
      )}))::int`.as("in_progress"),
    ])
    .where("business_id", "=", b.id)
    .executeTakeFirstOrThrow();

  const revenueRows = await db
    .selectFrom("order")
    .select([
      "currency",
      sql<string>`coalesce(sum(total), 0)::text`.as("amount"),
      sql<number>`count(*)::int`.as("cnt"),
    ])
    .where("business_id", "=", b.id)
    .where("created_at", ">=", start)
    .where("created_at", "<", end)
    .where("status", "in", REVENUE_STATUSES)
    .groupBy("currency")
    .execute();

  const todayRevenue = revenueRows.map((r) => ({
    currency: r.currency,
    amount: String(r.amount),
  }));

  const averageCheck = revenueRows.map((r) => {
    const cnt = Number(r.cnt) || 0;
    const total = Number(r.amount) || 0;
    return {
      currency: r.currency,
      amount: cnt > 0 ? (total / cnt).toFixed(2) : "0",
    };
  });

  return {
    newCount: Number(counts.new_count) || 0,
    inProgressCount: Number(counts.in_progress) || 0,
    todayRevenue,
    averageCheck,
    timezone,
  };
}
