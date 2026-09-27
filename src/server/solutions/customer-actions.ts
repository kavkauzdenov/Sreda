import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { normalizeSolutionCode } from "./catalog.ts";
import { isLeadCustomerReady } from "../leads/readiness.ts";

export type CustomerActionCode =
  | "leads"
  | "orders"
  | "booking"
  | "admin_messages";

export type CustomerAction = {
  code: CustomerActionCode;
  /** Reply-keyboard labels that open this action. */
  labels: string[];
};

export type AvailableCustomerActions = {
  actions: CustomerAction[];
  /** Flat ordered keyboard for the customer bot. */
  labels: string[];
  leadTitle: string | null;
  has(code: CustomerActionCode): boolean;
  /** Resolve which action a customer message intends, if any. */
  match(text: string): CustomerActionCode | null;
};

type Db = Kysely<Database> | Transaction<Database>;

const ORDER_LABELS = ["Каталог", "Корзина", "Мои заказы", "Профиль"] as const;
/** Menu buttons shown when booking is customer-ready. */
const BOOKING_MENU_LABELS = ["Записаться", "Мои записи"] as const;
/** Accepted aliases (including legacy reply labels) for booking. */
const BOOKING_MATCH_LABELS = [
  "Записаться",
  "Мои записи",
  "Онлайн-запись",
] as const;
const ADMIN_LABELS = [
  "Связаться с администратором",
  "Связаться с администрацией",
  "Связаться с магазином",
] as const;

/**
 * Single source of truth for customer-facing Telegram/VK menus.
 * Only returns actions that are activated AND customer-ready for this platform.
 * setup_required / paused / inactive / unavailable → omitted.
 */
export async function getAvailableCustomerActions(
  db: Db,
  businessId: string,
  platform: "telegram" | "vk",
): Promise<AvailableCustomerActions> {
  const business = await db
    .selectFrom("business")
    .select(["id", "archived_at"])
    .where("id", "=", businessId)
    .executeTakeFirst();
  if (!business || business.archived_at != null) {
    return emptyActions();
  }

  const now = new Date();
  const enabled = await db
    .selectFrom("business_solution")
    .select(["solution_code", "status", "expires_at"])
    .where("business_id", "=", businessId)
    .where("status", "in", ["active", "trial"])
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
    )
    .execute();
  const codes = new Set(
    enabled.map((row) => normalizeSolutionCode(row.solution_code)),
  );

  const platformConnected = await db
    .selectFrom("business_connection")
    .select("id")
    .where("business_id", "=", businessId)
    .where("platform", "=", platform)
    .where("status", "=", "connected")
    .executeTakeFirst();

  const [productCount, serviceCount] = await Promise.all([
    db
      .selectFrom("product")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("business_id", "=", businessId)
      .where("active", "=", true)
      .executeTakeFirst()
      .then((row) => Number(row?.n ?? 0)),
    db
      .selectFrom("booking_service")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("business_id", "=", businessId)
      .where("active", "=", true)
      .executeTakeFirst()
      .then((row) => Number(row?.n ?? 0)),
  ]);

  const actions: CustomerAction[] = [];
  let leadTitle: string | null = null;

  if (codes.has("leads")) {
    const leadReady = await isLeadCustomerReady(db, businessId, platform);
    if (leadReady.ready) {
      leadTitle = leadReady.buttonLabel?.trim() || "Оставить заявку";
      actions.push({ code: "leads", labels: [leadTitle] });
    }
  }

  if (codes.has("orders") && productCount > 0) {
    actions.push({ code: "orders", labels: [...ORDER_LABELS] });
  }

  if (codes.has("admin_messages") && platformConnected) {
    actions.push({
      code: "admin_messages",
      labels: ["Связаться с администратором"],
    });
  }

  if (codes.has("booking") && serviceCount > 0) {
    actions.push({ code: "booking", labels: [...BOOKING_MENU_LABELS] });
  }

  const labels = actions.flatMap((action) => action.labels);
  const byCode = new Set(actions.map((action) => action.code));

  return {
    actions,
    labels,
    leadTitle,
    has: (code) => byCode.has(code),
    match: (text) => {
      const value = text.trim();
      if (!value) return null;
      if (leadTitle && (value === leadTitle || value === "/lead")) {
        return byCode.has("leads") ? "leads" : null;
      }
      if ((ADMIN_LABELS as readonly string[]).includes(value)) {
        return byCode.has("admin_messages") ? "admin_messages" : null;
      }
      if ((ORDER_LABELS as readonly string[]).includes(value)) {
        return byCode.has("orders") ? "orders" : null;
      }
      if ((BOOKING_MATCH_LABELS as readonly string[]).includes(value)) {
        return byCode.has("booking") ? "booking" : null;
      }
      return null;
    },
  };
}

function emptyActions(): AvailableCustomerActions {
  return {
    actions: [],
    labels: [],
    leadTitle: null,
    has: () => false,
    match: () => null,
  };
}

/** Re-check a single action mid-flow (stale callback / deep link). */
export async function assertCustomerActionAvailable(
  db: Db,
  businessId: string,
  platform: "telegram" | "vk",
  code: CustomerActionCode,
) {
  const available = await getAvailableCustomerActions(db, businessId, platform);
  return available.has(code);
}
