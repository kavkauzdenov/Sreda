import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import {
  activityTitle,
  type ClientAssigneeDto,
  type ClientIdentityDto,
  type ClientLastActivityDto,
  type ClientTagDto,
} from "./types.ts";
import { findDuplicateCandidates } from "./duplicates.ts";

type Db = Kysely<Database>;

export type ClientDetailV2 = {
  client: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    profileNote: string | null;
    assignedAt: string | null;
    updatedAt: string;
  };
  identities: ClientIdentityDto[];
  tags: ClientTagDto[];
  assignedUser: ClientAssigneeDto;
  stats: {
    leadCount: number;
    orderCount: number;
    bookingCount: number;
    noteCount: number;
    conversationCount: number;
    openConversation: boolean;
    orderTotals: { currency: string; amount: string }[];
  };
  latestActivity: ClientLastActivityDto;
  latestNote: {
    id: string;
    text: string;
    createdAt: string;
    author: string | null;
  } | null;
  duplicateSummary: {
    count: number;
    candidates: {
      id: string;
      name: string;
      matches: string[];
    }[];
  };
  writeChannels: {
    platform: string;
    conversationId: string;
    username: string | null;
  }[];
};

export async function getClientDetailV2(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
): Promise<ClientDetailV2> {
  requireUuid(clientId);
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const client = await db
    .selectFrom("client")
    .selectAll()
    .where("business_id", "=", b.id)
    .where("id", "=", clientId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!client)
    throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");

  const [
    identities,
    tags,
    assignee,
    stats,
    latestActivity,
    latestNote,
    duplicates,
    writeChannels,
  ] = await Promise.all([
    db
      .selectFrom("client_identity")
      .select(["kind", "value", "username"])
      .where("business_id", "=", b.id)
      .where("client_id", "=", clientId)
      .execute(),
    db
      .selectFrom("client_tag_link as tl")
      .innerJoin("client_tag as t", "t.id", "tl.tag_id")
      .select(["t.id", "t.name", "t.color_key"])
      .where("tl.business_id", "=", b.id)
      .where("tl.client_id", "=", clientId)
      .orderBy("t.name")
      .execute(),
    client.assigned_user_id
      ? db
          .selectFrom("user as u")
          .innerJoin("business_member as m", (join) =>
            join
              .onRef("m.user_id", "=", "u.id")
              .on("m.business_id", "=", b.id),
          )
          .select(["u.id", "u.name", "m.role"])
          .where("u.id", "=", client.assigned_user_id)
          .where("m.status", "=", "active")
          .executeTakeFirst()
      : Promise.resolve(undefined),
    db
      .selectFrom("client as c")
      .select([
        sql<number>`(
          select count(*)::int from lead l
          where l.business_id = c.business_id and l.client_id = c.id
        )`.as("lead_count"),
        sql<number>`(
          select count(*)::int from "order" o
          where o.business_id = c.business_id and o.client_id = c.id
        )`.as("order_count"),
        sql<number>`(
          select count(*)::int from booking bk
          where bk.business_id = c.business_id and bk.client_id = c.id
        )`.as("booking_count"),
        sql<number>`(
          select count(*)::int from client_note n
          where n.business_id = c.business_id and n.client_id = c.id
        )`.as("note_count"),
        sql<number>`(
          select count(*)::int from communication_conversation cc
          where cc.business_id = c.business_id and cc.client_id = c.id
        )`.as("conversation_count"),
        sql<boolean>`exists (
          select 1 from communication_conversation cc
          where cc.business_id = c.business_id
            and cc.client_id = c.id
            and cc.status in ('open', 'assigned')
        )`.as("open_conversation"),
      ])
      .where("c.business_id", "=", b.id)
      .where("c.id", "=", clientId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("client_activity")
      .select(["type", "created_at", "metadata"])
      .where("business_id", "=", b.id)
      .where("client_id", "=", clientId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst(),
    db
      .selectFrom("client_note as n")
      .leftJoin("user as u", "u.id", "n.actor_user_id")
      .select(["n.id", "n.text", "n.created_at", "u.name as author"])
      .where("n.business_id", "=", b.id)
      .where("n.client_id", "=", clientId)
      .orderBy("n.created_at", "desc")
      .orderBy("n.id", "desc")
      .limit(1)
      .executeTakeFirst(),
    findDuplicateCandidates(db, b.id, clientId),
    db
      .selectFrom("communication_conversation as cc")
      .leftJoin("client_identity as i", (join) =>
        join
          .onRef("i.client_id", "=", "cc.client_id")
          .onRef("i.business_id", "=", "cc.business_id")
          .onRef("i.kind", "=", "cc.platform"),
      )
      .select(["cc.id", "cc.platform", "i.username", "cc.external_username"])
      .where("cc.business_id", "=", b.id)
      .where("cc.client_id", "=", clientId)
      .where("cc.status", "in", ["open", "assigned", "closed"])
      .orderBy("cc.last_message_at", "desc")
      .execute(),
  ]);

  const orderTotals = await db
    .selectFrom("order")
    .select(["currency", sql<string>`coalesce(sum(total::numeric), 0)::text`.as("amount")])
    .where("business_id", "=", b.id)
    .where("client_id", "=", clientId)
    .groupBy("currency")
    .execute();

  const channelMap = new Map<
    string,
    { platform: string; conversationId: string; username: string | null }
  >();
  for (const row of writeChannels) {
    if (channelMap.has(row.platform)) continue;
    channelMap.set(row.platform, {
      platform: row.platform,
      conversationId: row.id,
      username: row.username ?? row.external_username,
    });
  }

  return {
    client: {
      id: client.id,
      name: client.name,
      phone: client.phone,
      email: client.email,
      firstSeenAt: client.first_seen_at.toISOString(),
      lastSeenAt: client.last_seen_at.toISOString(),
      profileNote: client.profile_note,
      assignedAt: client.assigned_at?.toISOString() ?? null,
      updatedAt: client.updated_at.toISOString(),
    },
    identities: identities.map((i) => ({
      kind: i.kind,
      value: i.value,
      username: i.username,
    })),
    tags: tags.map((t) => ({
      id: t.id,
      name: t.name,
      colorKey: t.color_key,
    })),
    assignedUser: assignee
      ? { id: assignee.id, name: assignee.name, role: assignee.role }
      : null,
    stats: {
      leadCount: Number(stats.lead_count) || 0,
      orderCount: Number(stats.order_count) || 0,
      bookingCount: Number(stats.booking_count) || 0,
      noteCount: Number(stats.note_count) || 0,
      conversationCount: Number(stats.conversation_count) || 0,
      openConversation: Boolean(stats.open_conversation),
      orderTotals: orderTotals.map((row) => ({
        currency: row.currency,
        amount: row.amount,
      })),
    },
    latestActivity: latestActivity
      ? {
          type: latestActivity.type,
          title: activityTitle(latestActivity.type, latestActivity.metadata),
          createdAt: latestActivity.created_at.toISOString(),
        }
      : null,
    latestNote: latestNote
      ? {
          id: latestNote.id,
          text: latestNote.text,
          createdAt: latestNote.created_at.toISOString(),
          author: latestNote.author,
        }
      : null,
    duplicateSummary: {
      count: duplicates.length,
      candidates: duplicates.map((d) => ({
        id: d.id,
        name: d.name,
        matches: d.matches,
      })),
    },
    writeChannels: [...channelMap.values()],
  };
}

export async function listClientTab(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  view: "leads" | "orders" | "bookings" | "conversations" | "notes",
  cursor?: string,
  limit = 30,
) {
  requireUuid(clientId);
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const exists = await db
    .selectFrom("client")
    .select("id")
    .where("business_id", "=", b.id)
    .where("id", "=", clientId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!exists)
    throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");

  const take = Math.min(100, Math.max(1, limit));

  if (view === "leads") {
    let q = db
      .selectFrom("lead")
      .select(["id", "name", "status", "source", "created_at", "phone"])
      .where("business_id", "=", b.id)
      .where("client_id", "=", clientId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(take + 1);
    if (cursor) {
      const [t, id] = decodeSimpleCursor(cursor);
      q = q.where((eb) =>
        eb.or([
          eb("created_at", "<", t),
          eb.and([eb("created_at", "=", t), eb("id", "<", id)]),
        ]),
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status,
        source: row.source,
        phone: row.phone,
        createdAt: row.created_at.toISOString(),
        targetPath: `/leads?lead=${row.id}`,
      })),
      nextCursor:
        rows.length > take && last
          ? encodeSimpleCursor(last.created_at, last.id)
          : null,
      hasMore: rows.length > take,
    };
  }

  if (view === "orders") {
    let q = db
      .selectFrom("order")
      .select(["id", "status", "total", "currency", "created_at", "order_number"])
      .where("business_id", "=", b.id)
      .where("client_id", "=", clientId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(take + 1);
    if (cursor) {
      const [t, id] = decodeSimpleCursor(cursor);
      q = q.where((eb) =>
        eb.or([
          eb("created_at", "<", t),
          eb.and([eb("created_at", "=", t), eb("id", "<", id)]),
        ]),
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        status: row.status,
        total: row.total,
        currency: row.currency,
        number: row.order_number,
        createdAt: row.created_at.toISOString(),
        targetPath: `/orders?order=${row.id}`,
      })),
      nextCursor:
        rows.length > take && last
          ? encodeSimpleCursor(last.created_at, last.id)
          : null,
      hasMore: rows.length > take,
    };
  }

  if (view === "bookings") {
    let q = db
      .selectFrom("booking as k")
      .innerJoin("booking_service as s", "s.id", "k.service_id")
      .innerJoin("booking_specialist as r", "r.id", "k.specialist_id")
      .select([
        "k.id",
        "k.starts_at",
        "k.status",
        "s.name as service_name",
        "r.name as specialist_name",
      ])
      .where("k.business_id", "=", b.id)
      .where("k.client_id", "=", clientId)
      .orderBy("k.starts_at", "desc")
      .orderBy("k.id", "desc")
      .limit(take + 1);
    if (cursor) {
      const [t, id] = decodeSimpleCursor(cursor);
      q = q.where((eb) =>
        eb.or([
          eb("k.starts_at", "<", t),
          eb.and([eb("k.starts_at", "=", t), eb("k.id", "<", id)]),
        ]),
      );
    }
    const rows = await q.execute();
    const page = rows.slice(0, take);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        id: row.id,
        startsAt: row.starts_at.toISOString(),
        status: row.status,
        serviceName: row.service_name,
        specialistName: row.specialist_name,
        targetPath: `/bookings?booking=${row.id}`,
      })),
      nextCursor:
        rows.length > take && last
          ? encodeSimpleCursor(last.starts_at, last.id)
          : null,
      hasMore: rows.length > take,
    };
  }

  if (view === "conversations") {
    const rows = await db
      .selectFrom("communication_conversation")
      .select(["id", "platform", "status", "last_message_at"])
      .where("business_id", "=", b.id)
      .where("client_id", "=", clientId)
      .orderBy("last_message_at", "desc")
      .limit(take)
      .execute();
    return {
      items: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
        status: row.status,
        updatedAt: row.last_message_at.toISOString(),
        targetPath: `/messages?conversation=${row.id}`,
      })),
      nextCursor: null,
      hasMore: false,
    };
  }

  // notes
  let q = db
    .selectFrom("client_note as n")
    .leftJoin("user as u", "u.id", "n.actor_user_id")
    .select(["n.id", "n.text", "n.created_at", "u.name as author"])
    .where("n.business_id", "=", b.id)
    .where("n.client_id", "=", clientId)
    .orderBy("n.created_at", "desc")
    .orderBy("n.id", "desc")
    .limit(take + 1);
  if (cursor) {
    const [t, id] = decodeSimpleCursor(cursor);
    q = q.where((eb) =>
      eb.or([
        eb("n.created_at", "<", t),
        eb.and([eb("n.created_at", "=", t), eb("n.id", "<", id)]),
      ]),
    );
  }
  const rows = await q.execute();
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({
      id: row.id,
      text: row.text,
      createdAt: row.created_at.toISOString(),
      author: row.author,
    })),
    nextCursor:
      rows.length > take && last
        ? encodeSimpleCursor(last.created_at, last.id)
        : null,
    hasMore: rows.length > take,
  };
}

function encodeSimpleCursor(at: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: at.toISOString(), id }),
    "utf8",
  ).toString("base64url");
}

function decodeSimpleCursor(raw: string): [Date, string] {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { t?: string; id?: string };
    if (
      typeof parsed.t !== "string" ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    )
      throw new Error("bad");
    const t = new Date(parsed.t);
    if (Number.isNaN(t.getTime())) throw new Error("bad");
    return [t, parsed.id];
  } catch {
    throw new AppError(400, "INVALID_CURSOR", "Обновите список.");
  }
}
