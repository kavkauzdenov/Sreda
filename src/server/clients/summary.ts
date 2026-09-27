import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { requireBusiness } from "../access/permissions.ts";
import type { ClientSummary } from "./types.ts";

export async function getClientSummary(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
): Promise<ClientSummary> {
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const since = new Date(Date.now() - 30 * 86400000);
  const row = await db
    .selectFrom("client as c")
    .select([
      sql<number>`count(*)::int`.as("total"),
      sql<number>`count(*) filter (where c.first_seen_at >= ${since})::int`.as(
        "new30d",
      ),
      sql<number>`count(*) filter (where c.last_seen_at >= ${since})::int`.as(
        "active30d",
      ),
      sql<number>`count(*) filter (
        where exists (
          select 1 from communication_conversation cc
          where cc.business_id = c.business_id
            and cc.client_id = c.id
            and cc.status in ('open', 'assigned')
        )
      )::int`.as("open_conversations"),
    ])
    .where("c.business_id", "=", b.id)
    .where("c.archived_at", "is", null)
    .executeTakeFirstOrThrow();

  return {
    total: Number(row.total) || 0,
    new30d: Number(row.new30d) || 0,
    active30d: Number(row.active30d) || 0,
    openConversations: Number(row.open_conversations) || 0,
  };
}
