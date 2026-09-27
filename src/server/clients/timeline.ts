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
    } catch {
      throw new AppError(400, "INVALID_CURSOR", "Обновите историю.");
    }
  }

  // Unified stream: client_activity + client_note (as client.note_added).
  // Two queries + merge keeps query count O(1).
  let activityQ = db
    .selectFrom("client_activity as a")
    .leftJoin("user as u", "u.id", "a.actor_user_id")
    .select([
      "a.id",
      "a.type",
      "a.created_at",
      "a.target_id",
      "a.metadata",
      "u.name as actor",
    ])
    .where("a.business_id", "=", b.id)
    .where("a.client_id", "=", clientId)
    .orderBy("a.created_at", "desc")
    .orderBy("a.id", "desc")
    .limit(take + 1);
  if (cursorAt && cursorId) {
    activityQ = activityQ.where((eb) =>
      eb.or([
        eb("a.created_at", "<", cursorAt!),
        eb.and([
          eb("a.created_at", "=", cursorAt!),
          eb("a.id", "<", cursorId!),
        ]),
      ]),
    );
  }

  let noteQ = db
    .selectFrom("client_note as n")
    .leftJoin("user as u", "u.id", "n.actor_user_id")
    .select([
      "n.id",
      "n.text",
      "n.created_at",
      "u.name as actor",
    ])
    .where("n.business_id", "=", b.id)
    .where("n.client_id", "=", clientId)
    .orderBy("n.created_at", "desc")
    .orderBy("n.id", "desc")
    .limit(take + 1);
  if (cursorAt && cursorId) {
    noteQ = noteQ.where((eb) =>
      eb.or([
        eb("n.created_at", "<", cursorAt!),
        eb.and([
          eb("n.created_at", "=", cursorAt!),
          eb("n.id", "<", cursorId!),
        ]),
      ]),
    );
  }

  const [activities, notes] = await Promise.all([
    activityQ.execute(),
    noteQ.execute(),
  ]);

  type Row = {
    id: string;
    type: string;
    createdAt: Date;
    title: string;
    description: string | null;
    actor: string | null;
    entityType: string | null;
    entityId: string | null;
    metadata: Record<string, unknown> | null;
  };

  const merged: Row[] = [
    ...activities.map((a) => ({
      id: a.id,
      type: a.type,
      createdAt: a.created_at,
      title: activityTitle(a.type, a.metadata),
      description: null as string | null,
      actor: a.actor,
      entityType: inferEntityType(a.type, a.target_id),
      entityId: a.target_id,
      metadata:
        a.metadata && typeof a.metadata === "object"
          ? (a.metadata as Record<string, unknown>)
          : null,
    })),
    ...notes.map((n) => ({
      id: n.id,
      type: "client.note_added",
      createdAt: n.created_at,
      title: activityTitle("client.note_added"),
      description: n.text,
      actor: n.actor,
      entityType: "note" as string | null,
      entityId: n.id,
      metadata: null as Record<string, unknown> | null,
    })),
  ];

  merged.sort((a, b) => {
    const d = b.createdAt.getTime() - a.createdAt.getTime();
    if (d !== 0) return d;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });

  const page = merged.slice(0, take);
  const hasMore = merged.length > take;
  const last = page[page.length - 1];

  const items: TimelineItemDto[] = page.map((row) => ({
    id: row.id,
    type: row.type,
    createdAt: row.createdAt.toISOString(),
    title: row.title,
    description: row.description,
    actor: row.actor,
    entityType: row.entityType,
    entityId: row.entityId,
    targetPath: targetPath(row.type, row.entityType, row.entityId),
    metadata: row.metadata,
  }));

  return {
    items,
    nextCursor:
      hasMore && last ? encodeTimelineCursor(last.createdAt, last.id) : null,
    hasMore,
  };
}
