import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { sql } from "kysely";

type Db = Kysely<Database> | Transaction<Database>;

export type LeadAnalyticsSummary = {
  periodDays: number;
  total: number;
  byStatus: {
    new: number;
    processing: number;
    waiting_customer: number;
    completed: number;
    rejected: number;
    closed: number;
  };
  taken: number;
  completed: number;
  avgMinutesToTake: number | null;
  sources: { telegram: number; vk: number; other: number };
};

/**
 * Compact lead aggregates for the period. Real SQL — no fake metrics.
 */
export async function getLeadAnalytics(
  db: Db,
  businessId: string,
  periodDays: 1 | 7 | 30 = 7,
): Promise<LeadAnalyticsSummary> {
  const since = new Date(Date.now() - periodDays * 86400000);
  const rows = await db
    .selectFrom("lead")
    .select(["status", "source", "created_at", "processing_at"])
    .where("business_id", "=", businessId)
    .where("created_at", ">=", since)
    .execute();

  const byStatus = {
    new: 0,
    processing: 0,
    waiting_customer: 0,
    completed: 0,
    rejected: 0,
    closed: 0,
  };
  const sources = { telegram: 0, vk: 0, other: 0 };
  let taken = 0;
  let takeSum = 0;
  let takeCount = 0;

  for (const row of rows) {
    if (row.status in byStatus) {
      byStatus[row.status as keyof typeof byStatus] += 1;
    }
    if (row.source === "telegram") sources.telegram += 1;
    else if (row.source === "vk") sources.vk += 1;
    else sources.other += 1;
    if (row.processing_at) {
      taken += 1;
      const mins =
        (row.processing_at.getTime() - row.created_at.getTime()) / 60000;
      if (Number.isFinite(mins) && mins >= 0) {
        takeSum += mins;
        takeCount += 1;
      }
    }
  }

  return {
    periodDays,
    total: rows.length,
    byStatus,
    taken,
    completed: byStatus.completed,
    avgMinutesToTake:
      takeCount > 0 ? Math.round((takeSum / takeCount) * 10) / 10 : null,
    sources,
  };
}

/** Count leads by status for summary cards (optionally period-scoped). */
export async function getLeadStatusCounts(
  db: Db,
  businessId: string,
  since?: Date,
) {
  let query = db
    .selectFrom("lead")
    .select(["status", sql<number>`count(*)::int`.as("n")])
    .where("business_id", "=", businessId)
    .groupBy("status");
  if (since) query = query.where("created_at", ">=", since);
  const rows = await query.execute();
  const out: Record<string, number> = {
    new: 0,
    processing: 0,
    waiting_customer: 0,
    completed: 0,
    rejected: 0,
    closed: 0,
  };
  for (const row of rows) out[row.status] = Number(row.n);
  out.total = Object.values(out).reduce((a, b) => a + b, 0);
  return out;
}
