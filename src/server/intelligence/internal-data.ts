import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { resolvePeriod } from "../analytics/periods.ts";
import {
  IN_PROGRESS_STATUSES,
  REVENUE_STATUSES,
} from "../orders/schema.ts";

const MS_HOUR = 3600000;
const STALE_ORDER_HOURS = 24;
const STALE_LEAD_HOURS = 48;
const INACTIVE_CLIENT_DAYS = 30;

export type InternalBusinessSnapshot = {
  businessId: string;
  timezone: string;
  hasAnyActivity: boolean;
  ordersOpen: number;
  ordersStale: number;
  leadsOpen: number;
  leadsStale: number;
  ordersCurrent7d: number;
  ordersPrevious7d: number;
  revenueCurrent7d: number;
  revenuePrevious7d: number;
  revenueCurrency: string;
  clientsTotal: number;
  clientsInactive: number;
  clientsNew30d: number;
  newOrdersToday: number;
};

export async function loadInternalSnapshot(
  db: Kysely<Database>,
  businessId: string,
  timezone: string,
): Promise<InternalBusinessSnapshot> {
  const range = resolvePeriod("7d", timezone, new Date());
  const inactiveSince = new Date(
    Date.now() - INACTIVE_CLIENT_DAYS * 86400000,
  );
  const orderStaleBefore = new Date(Date.now() - STALE_ORDER_HOURS * MS_HOUR);
  const leadStaleBefore = new Date(Date.now() - STALE_LEAD_HOURS * MS_HOUR);

  const openStatuses = ["new", ...IN_PROGRESS_STATUSES];

  const [
    orderStats,
    leadStats,
    periodOrders,
    periodRevenue,
    clientStats,
    activityProbe,
    todayNew,
  ] = await Promise.all([
    db
      .selectFrom("order")
      .select([
        sql<number>`count(*) filter (where status in (${sql.join(
          openStatuses.map((s) => sql.lit(s)),
        )}))::int`.as("open_count"),
        sql<number>`count(*) filter (
          where status in (${sql.join(openStatuses.map((s) => sql.lit(s)))})
            and coalesce(updated_at, created_at) < ${orderStaleBefore}
        )::int`.as("stale_count"),
      ])
      .where("business_id", "=", businessId)
      .executeTakeFirst(),
    db
      .selectFrom("lead")
      .select([
        sql<number>`count(*) filter (where status in ('new','processing'))::int`.as(
          "open_count",
        ),
        sql<number>`count(*) filter (
          where status in ('new','processing')
            and created_at < ${leadStaleBefore}
        )::int`.as("stale_count"),
      ])
      .where("business_id", "=", businessId)
      .executeTakeFirst(),
    db
      .selectFrom("order")
      .select([
        sql<number>`count(*) filter (where created_at >= ${range.from} and created_at < ${range.until})::int`.as(
          "current",
        ),
        sql<number>`count(*) filter (where created_at >= ${range.previous.from} and created_at < ${range.previous.until})::int`.as(
          "previous",
        ),
      ])
      .where("business_id", "=", businessId)
      .executeTakeFirst(),
    db
      .selectFrom("order")
      .select([
        "currency",
        sql<string>`coalesce(sum(total) filter (where created_at >= ${range.from} and created_at < ${range.until} and status in (${sql.join(
          REVENUE_STATUSES.map((s) => sql.lit(s)),
        )})), 0)::text`.as("current"),
        sql<string>`coalesce(sum(total) filter (where created_at >= ${range.previous.from} and created_at < ${range.previous.until} and status in (${sql.join(
          REVENUE_STATUSES.map((s) => sql.lit(s)),
        )})), 0)::text`.as("previous"),
      ])
      .where("business_id", "=", businessId)
      .groupBy("currency")
      .orderBy(sql`sum(total) desc`)
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom("client")
      .select([
        sql<number>`count(*)::int`.as("total"),
        sql<number>`count(*) filter (where last_seen_at < ${inactiveSince} or last_seen_at is null)::int`.as(
          "inactive",
        ),
        sql<number>`count(*) filter (where first_seen_at >= ${inactiveSince})::int`.as(
          "new30d",
        ),
      ])
      .where("business_id", "=", businessId)
      .where("archived_at", "is", null)
      .executeTakeFirst(),
    db
      .selectFrom("order")
      .select(sql<number>`count(*)::int`.as("c"))
      .where("business_id", "=", businessId)
      .limit(1)
      .executeTakeFirst()
      .then(async (orders) => {
        if (Number(orders?.c) > 0) return true;
        const leads = await db
          .selectFrom("lead")
          .select(sql<number>`count(*)::int`.as("c"))
          .where("business_id", "=", businessId)
          .executeTakeFirst();
        if (Number(leads?.c) > 0) return true;
        const clients = await db
          .selectFrom("client")
          .select(sql<number>`count(*)::int`.as("c"))
          .where("business_id", "=", businessId)
          .executeTakeFirst();
        return Number(clients?.c) > 0;
      }),
    db
      .selectFrom("order")
      .select(sql<number>`count(*) filter (where status = 'new')::int`.as("c"))
      .where("business_id", "=", businessId)
      .executeTakeFirst(),
  ]);

  return {
    businessId,
    timezone,
    hasAnyActivity: Boolean(activityProbe),
    ordersOpen: Number(orderStats?.open_count) || 0,
    ordersStale: Number(orderStats?.stale_count) || 0,
    leadsOpen: Number(leadStats?.open_count) || 0,
    leadsStale: Number(leadStats?.stale_count) || 0,
    ordersCurrent7d: Number(periodOrders?.current) || 0,
    ordersPrevious7d: Number(periodOrders?.previous) || 0,
    revenueCurrent7d: Number(periodRevenue?.current) || 0,
    revenuePrevious7d: Number(periodRevenue?.previous) || 0,
    revenueCurrency: periodRevenue?.currency || "RUB",
    clientsTotal: Number(clientStats?.total) || 0,
    clientsInactive: Number(clientStats?.inactive) || 0,
    clientsNew30d: Number(clientStats?.new30d) || 0,
    newOrdersToday: Number(todayNew?.c) || 0,
  };
}
