import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import {
  activityTitle,
  decodeTimelineCursor,
  encodeTimelineCursor,
  type TimelineItemDto,
} from "./types.ts";

type Db = Kysely<Database>;

export type TimelineResponse = {
  items: TimelineItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

function targetPath(
  type: string,
  entityType: string | null,
  entityId: string | null,
): string | null {
  if (!entityId) return null;
  if (entityType === "lead" || type.startsWith("lead."))
    return `/leads?lead=${entityId}`;
  if (entityType === "order" || type.startsWith("order."))
    return `/orders?order=${entityId}`;
  if (entityType === "booking" || type.startsWith("booking."))
    return `/bookings?booking=${entityId}`;
  if (entityType === "conversation" || type.startsWith("message."))
    return `/messages?conversation=${entityId}`;
  return null;
}

function inferEntityType(type: string, targetId: string | null): string | null {
  if (!targetId) return null;
  if (type.startsWith("lead.")) return "lead";
  if (type.startsWith("order.")) return "order";
  if (type.startsWith("booking.")) return "booking";
  if (type.startsWith("message.")) return "conversation";
  if (type === "client.note_added") return "note";
  return null;
}

/**
 * Unified timeline via SQL UNION ALL.
 * client_note is the canonical content for notes;
 * client_activity type=client.note_added is excluded to avoid duplicates.
 */
export async function getClientTimeline(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  cursor?: string,
  limit = 30,
): Promise<TimelineResponse> {
  requireUuid(clientId);
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const client = await db
    .selectFrom("client")
    .select("id")
    .where("business_id", "=", b.id)
    .where("id", "=", clientId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!client)
    throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");

  const take = Math.min(50, Math.max(1, limit));
  let cursorAt: Date | undefined;
  let cursorId: string | undefined;
  if (cursor) {
    try {
      const decoded = decodeTimelineCursor(cursor);
      cursorAt = decoded.t;
      cursorId = decoded.id;
      requireUuid(cursorId);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, "INVALID_CURSOR", "Обновите историю.");
    }
  }

  const cursorClause = cursorAt && cursorId
    ? sql`AND (u.created_at, u.id) < (${cursorAt}, ${cursorId})`
    : sql``;

  const result = await sql<{
    id: string;
    type: string;
    created_at: Date;
    target_id: string | null;
    metadata: unknown;
    actor: string | null;
    note_text: string | null;
  }>`
    SELECT * FROM (
      SELECT
        a.id::text AS id,
        a.type,
        a.created_at,
        a.target_id::text AS target_id,
        a.metadata,
        u.name AS actor,
        NULL::text AS note_text
      FROM client_activity AS a
      LEFT JOIN "user" AS u ON u.id = a.actor_user_id
      WHERE a.business_id = ${b.id}::uuid
        AND a.client_id = ${clientId}::uuid
        AND a.type <> 'client.note_added'
      UNION ALL
      SELECT
        n.id::text AS id,
        'client.note_added'::text AS type,
        n.created_at,
        n.id::text AS target_id,
        NULL::jsonb AS metadata,
        u.name AS actor,
        n.text AS note_text
      FROM client_note AS n
      LEFT JOIN "user" AS u ON u.id = n.actor_user_id
      WHERE n.business_id = ${b.id}::uuid
        AND n.client_id = ${clientId}::uuid
    ) AS u
    WHERE TRUE
    ${cursorClause}
    ORDER BY u.created_at DESC, u.id DESC
    LIMIT ${take + 1}
  `.execute(db);

  const rows = result.rows;
  const page = rows.slice(0, take);
  const hasMore = rows.length > take;
  const last = page[page.length - 1];

  const items: TimelineItemDto[] = page.map((row) => {
    const entityType = inferEntityType(row.type, row.target_id);
    const metadata =
      row.metadata && typeof row.metadata === "object"
        ? (row.metadata as Record<string, unknown>)
        : null;
    return {
      id: row.id,
      type: row.type,
      createdAt: new Date(row.created_at).toISOString(),
      title: activityTitle(row.type, metadata),
      description: row.note_text,
      actor: row.actor,
      entityType,
      entityId: row.target_id,
      targetPath: targetPath(row.type, entityType, row.target_id),
      metadata,
    };
  });

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeTimelineCursor(new Date(last.created_at), last.id)
        : null,
    hasMore,
  };
}
