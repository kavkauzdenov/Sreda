import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { normalizeSolutionCode } from "../solutions/catalog.ts";
import type { EntitlementStatus, SolutionEntitlement } from "./types.ts";

type Db = Kysely<Database> | Transaction<Database>;

function mapStatus(
  status: Database["business_solution"]["status"] | undefined,
  expiresAt: Date | null | undefined,
  now: Date,
): { status: EntitlementStatus; entitled: boolean } {
  if (!status) return { status: "absent", entitled: false };
  if (status === "disabled") return { status: "disabled", entitled: false };
  if (status === "paused") return { status: "paused", entitled: false };
  if (status === "expired") return { status: "expired", entitled: false };
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return { status: "expired", entitled: false };
  }
  if (status === "trial") return { status: "trial", entitled: true };
  if (status === "active") return { status: "active", entitled: true };
  return { status: "absent", entitled: false };
}

/**
 * Entitlement source of truth: business_solution.
 * Billing providers may later upsert this row after confirmed payment events.
 */
export async function getEntitlement(
  db: Db,
  businessId: string,
  solutionCode: string,
  at: Date = new Date(),
): Promise<SolutionEntitlement> {
  const code = normalizeSolutionCode(solutionCode);
  const rows = await db
    .selectFrom("business_solution")
    .select(["business_id", "solution_code", "status", "starts_at", "expires_at"])
    .where("business_id", "=", businessId)
    .where("solution_code", "in", code === "orders" ? ["orders", "sales"] : [code])
    .execute();

  let best = rows[0];
  for (const row of rows) {
    const mapped = mapStatus(row.status, row.expires_at, at);
    if (!best) {
      best = row;
      continue;
    }
    const bestMapped = mapStatus(best.status, best.expires_at, at);
    if (mapped.entitled && !bestMapped.entitled) best = row;
    else if (row.solution_code === code && best.solution_code !== code) best = row;
  }

  const mapped = mapStatus(best?.status, best?.expires_at ?? null, at);
  return {
    businessId,
    solutionCode: code,
    status: mapped.status,
    entitled: mapped.entitled,
    startsAt: best?.starts_at ?? null,
    expiresAt: best?.expires_at ?? null,
    validFrom: best?.starts_at ?? null,
    validUntil: best?.expires_at ?? null,
  };
}

export async function listEntitlements(
  db: Db,
  businessId: string,
  at: Date = new Date(),
): Promise<SolutionEntitlement[]> {
  const rows = await db
    .selectFrom("business_solution")
    .select(["business_id", "solution_code", "status", "starts_at", "expires_at"])
    .where("business_id", "=", businessId)
    .execute();

  const byCode = new Map<string, SolutionEntitlement>();
  for (const row of rows) {
    const code = normalizeSolutionCode(row.solution_code);
    const mapped = mapStatus(row.status, row.expires_at, at);
    const existing = byCode.get(code);
    // Prefer entitled row when both sales+orders legacy duplicates exist.
    if (existing?.entitled && !mapped.entitled) continue;
    byCode.set(code, {
      businessId,
      solutionCode: code,
      status: mapped.status,
      entitled: mapped.entitled,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      validFrom: row.starts_at,
      validUntil: row.expires_at,
    });
  }
  return [...byCode.values()];
}

export function isEntitled(entitlement: SolutionEntitlement): boolean {
  return entitlement.entitled;
}

/**
 * Critical-path guard: throw if the business may not use the solution.
 * Hook points documented in docs/BILLING.md (bots, workers, activate).
 */
export async function assertEntitlement(
  db: Db,
  businessId: string,
  solutionCode: string,
  at: Date = new Date(),
): Promise<SolutionEntitlement> {
  const entitlement = await getEntitlement(db, businessId, solutionCode, at);
  if (!entitlement.entitled) {
    throw new AppError(
      403,
      "ENTITLEMENT_REQUIRED",
      "Решение не подключено или срок доступа истёк.",
    );
  }
  return entitlement;
}

/**
 * Closed Beta: owners may grant entitlement without a payment provider.
 * When YooKassa/Stripe is confirmed, replace this with a check that a
 * confirmed provider event (or active subscription item) authorizes the grant.
 */
export async function assertCanGrantEntitlement(input: {
  db: Db;
  businessId: string;
  solutionCode: string;
  at?: Date;
}): Promise<void> {
  const mode = (process.env.BILLING_MODE || "closed_beta").trim();

  if (mode === "closed_beta") return;
  if (mode !== "paid") {
    throw new AppError(
      503,
      "BILLING_MODE_INVALID",
      "Режим оплаты настроен некорректно.",
    );
  }

  const code = normalizeSolutionCode(input.solutionCode);
  const at = input.at ?? new Date();
  const subscription = await input.db
    .selectFrom("business_subscription as s")
    .innerJoin(
      "business_subscription_item as i",
      "i.subscription_id",
      "s.id",
    )
    .select([
      "s.status",
      "s.provider",
      "s.current_period_end",
      "i.solution_code",
    ])
    .where("s.business_id", "=", input.businessId)
    .where("i.business_id", "=", input.businessId)
    .where("i.solution_code", "in", code === "orders" ? ["orders", "sales"] : [code])
    .where("s.status", "in", ["trialing", "active"])
    .where("s.provider", "in", ["yookassa", "stripe"])
    .executeTakeFirst();

  const active =
    !!subscription &&
    (!subscription.current_period_end ||
      subscription.current_period_end.getTime() > at.getTime());

  if (!active) {
    throw new AppError(
      402,
      "PAYMENT_REQUIRED",
      "Для подключения решения требуется активная оплаченная подписка.",
    );
  }
}
