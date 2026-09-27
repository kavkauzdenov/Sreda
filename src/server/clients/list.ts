import { sql } from "kysely";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { localDay, localInstants } from "../booking/time.ts";
import {
  type ClientListFilters,
  type ClientListItemDto,
  type ClientListResponse,
  activityTitle,
  decodeClientCursor,
  encodeClientCursor,
} from "./types.ts";

type Db = Kysely<Database>;

const CHANNELS = new Set<string>(["telegram", "vk", "whatsapp", "instagram", ""]);
const ACTIVITIES = new Set<string>(["today", "7d", "30d", "inactive", ""]);

function parseBool(value: unknown): boolean {
  return value === true || value === "1" || value === "true";
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

export function parseListFilters(
  params: URLSearchParams,
): ClientListFilters {
  const limitRaw = params.get("limit");
  let limit = 50;
  if (limitRaw != null && limitRaw !== "") {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 100)
      throw new AppError(400, "INVALID_FILTER", "Лимит должен быть от 1 до 100.");
    limit = n;
  }

  const channelRaw = params.get("channel") ?? "";
  if (!CHANNELS.has(channelRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте канал.");
  const channel = channelRaw as ClientListFilters["channel"];

  const activityRaw = params.get("activity") ?? "";
  if (!ACTIVITIES.has(activityRaw))
    throw new AppError(400, "INVALID_FILTER", "Проверьте фильтр активности.");
  const activity = activityRaw as ClientListFilters["activity"];

  const cursor = params.get("cursor") ?? undefined;
  if (cursor) {
    try {
      const decoded = decodeClientCursor(cursor);
      requireUuid(decoded.id);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, "INVALID_CURSOR", "Обновите список клиентов.");
    }
  }

  return {
    search: (params.get("search") ?? "").trim().slice(0, 100),
    channel,
    activity,
    hasLeads: parseBool(params.get("hasLeads")),
    hasOrders: parseBool(params.get("hasOrders")),
    hasBookings: parseBool(params.get("hasBookings")),
    hasOpenConversation: parseBool(params.get("hasOpenConversation")),
    hasNotes: parseBool(params.get("hasNotes")),
    tagId: optionalUuidParam(params.get("tagId"), "тег"),
    assignedUserId: optionalUuidParam(
      params.get("assignedUserId"),
      "ответственный",
    ),
    newOnly: parseBool(params.get("newOnly")),
    cursor,
    limit,
  };
}

function searchNeedle(search: string): string {
  return search.replace(/[%_\\]/g, "\\$&");
}

/** Digits-only needle for phone search (E.164 stored form). */
function normalizePhoneSearch(search: string): string | null {
  const digits = search.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits;
}

export async function listClientsV2(
  db: Db,
  userId: string,
  publicId: string,
  filters: ClientListFilters,
): Promise<ClientListResponse> {
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const business = await db
    .selectFrom("business")
    .select("timezone")
    .where("id", "=", b.id)
    .executeTakeFirstOrThrow();
  const limit = filters.limit ?? 50;
  const now = Date.now();

  let q = db
    .selectFrom("client as c")
    .select([
      "c.id",
      "c.name",
      "c.phone",
      "c.email",
      "c.first_seen_at",
      "c.last_seen_at",
      "c.assigned_user_id",
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
      sql<boolean>`exists (
        select 1 from communication_conversation cc
        where cc.business_id = c.business_id
          and cc.client_id = c.id
          and cc.status in ('open', 'assigned')
      )`.as("open_conversation"),
    ])
    .where("c.business_id", "=", b.id)
    .where("c.archived_at", "is", null);

  if (filters.search) {
    const like = "%" + searchNeedle(filters.search) + "%";
    const phone = normalizePhoneSearch(filters.search);
    q = q.where((eb) => {
      const parts = [
        eb("c.name", "ilike", like),
        eb("c.email", "ilike", like),
        eb.exists(
          eb
            .selectFrom("client_identity as i")
            .select("i.client_id")
            .whereRef("i.client_id", "=", "c.id")
            .whereRef("i.business_id", "=", "c.business_id")
            .where((inner) =>
              inner.or([
                inner("i.username", "ilike", like),
                inner("i.value", "ilike", like),
              ]),
            ),
        ),
      ];
      if (phone) {
        parts.push(
          eb(
            sql<string>`regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g')`,
            "like",
            "%" + phone + "%",
          ),
        );
        parts.push(eb("c.phone", "ilike", "%" + phone + "%"));
      } else {
        parts.push(eb("c.phone", "ilike", like));
      }
      return eb.or(parts);
    });
  }

  if (filters.channel) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("client_identity as i")
          .select("i.client_id")
          .whereRef("i.client_id", "=", "c.id")
          .whereRef("i.business_id", "=", "c.business_id")
          .where("i.kind", "=", filters.channel as "telegram" | "vk" | "whatsapp" | "instagram"),
      ),
    );
  }

  if (filters.activity === "today") {
    const day = localDay(new Date(), business.timezone);
    const start = localInstants(day, 0, business.timezone)[0];
    if (!start)
      throw new AppError(500, "TIMEZONE_ERROR", "Не удалось вычислить локальную полночь.");
    q = q.where("c.last_seen_at", ">=", start);
  } else if (filters.activity === "7d") {
    q = q.where("c.last_seen_at", ">=", new Date(now - 7 * 86400000));
  } else if (filters.activity === "30d") {
    q = q.where("c.last_seen_at", ">=", new Date(now - 30 * 86400000));
  } else if (filters.activity === "inactive") {
    q = q.where("c.last_seen_at", "<", new Date(now - 30 * 86400000));
  }

  if (filters.hasLeads)
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("lead")
          .select("id")
          .whereRef("client_id", "=", "c.id")
          .whereRef("business_id", "=", "c.business_id"),
      ),
    );
  if (filters.hasOrders)
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("order")
          .select("id")
          .whereRef("client_id", "=", "c.id")
          .whereRef("business_id", "=", "c.business_id"),
      ),
    );
  if (filters.hasBookings)
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("booking")
          .select("id")
          .whereRef("client_id", "=", "c.id")
          .whereRef("business_id", "=", "c.business_id"),
      ),
    );
  if (filters.hasOpenConversation)
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("communication_conversation")
          .select("id")
          .whereRef("client_id", "=", "c.id")
          .whereRef("business_id", "=", "c.business_id")
          .where("status", "in", ["open", "assigned"]),
      ),
    );
  if (filters.hasNotes)
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("client_note")
          .select("id")
          .whereRef("client_id", "=", "c.id")
          .whereRef("business_id", "=", "c.business_id"),
      ),
    );
  if (filters.tagId) {
    q = q.where((eb) =>
      eb.exists(
        eb
          .selectFrom("client_tag_link as tl")
          .select("tl.tag_id")
          .whereRef("tl.client_id", "=", "c.id")
          .whereRef("tl.business_id", "=", "c.business_id")
          .where("tl.tag_id", "=", filters.tagId!),
      ),
    );
  }
  if (filters.assignedUserId)
    q = q.where("c.assigned_user_id", "=", filters.assignedUserId);
  if (filters.newOnly)
    q = q.where("c.first_seen_at", ">=", new Date(now - 30 * 86400000));

  if (filters.cursor) {
    let cursor;
    try {
      cursor = decodeClientCursor(filters.cursor);
      requireUuid(cursor.id);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(400, "INVALID_CURSOR", "Обновите список клиентов.");
    }
    q = q.where((eb) =>
      eb.or([
        eb("c.last_seen_at", "<", cursor.t),
        eb.and([
          eb("c.last_seen_at", "=", cursor.t),
          eb("c.id", "<", cursor.id),
        ]),
      ]),
    );
  }

  const rows = await q
    .orderBy("c.last_seen_at", "desc")
    .orderBy("c.id", "desc")
    .limit(limit + 1)
    .execute();

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const ids = page.map((r) => r.id);

  const [identities, tags, assignees, activities] = await Promise.all([
    ids.length
      ? db
          .selectFrom("client_identity")
          .select(["client_id", "kind", "value", "username"])
          .where("business_id", "=", b.id)
          .where("client_id", "in", ids)
          .execute()
      : Promise.resolve([]),
    ids.length
      ? db
          .selectFrom("client_tag_link as tl")
          .innerJoin("client_tag as t", "t.id", "tl.tag_id")
          .select(["tl.client_id", "t.id", "t.name", "t.color_key"])
          .where("tl.business_id", "=", b.id)
          .where("tl.client_id", "in", ids)
          .execute()
      : Promise.resolve([]),
    ids.length
      ? db
          .selectFrom("client as c")
          .innerJoin("user as u", "u.id", "c.assigned_user_id")
          .innerJoin("business_member as m", (join) =>
            join
              .onRef("m.user_id", "=", "c.assigned_user_id")
              .onRef("m.business_id", "=", "c.business_id"),
          )
          .select(["c.id as client_id", "u.id", "u.name", "m.role"])
          .where("c.business_id", "=", b.id)
          .where("c.id", "in", ids)
          .where("c.assigned_user_id", "is not", null)
          .where("m.status", "=", "active")
          .execute()
      : Promise.resolve([]),
    ids.length
      ? db
          .selectFrom("client_activity as a")
          .distinctOn(["a.client_id"])
          .select([
            "a.client_id",
            "a.type",
            "a.created_at",
            "a.metadata",
          ])
          .where("a.business_id", "=", b.id)
          .where("a.client_id", "in", ids)
          .orderBy("a.client_id")
          .orderBy("a.created_at", "desc")
          .orderBy("a.id", "desc")
          .execute()
      : Promise.resolve([]),
  ]);

  const identityMap = new Map<string, typeof identities>();
  for (const row of identities) {
    const list = identityMap.get(row.client_id) ?? [];
    list.push(row);
    identityMap.set(row.client_id, list);
  }
  const tagMap = new Map<string, typeof tags>();
  for (const row of tags) {
    const list = tagMap.get(row.client_id) ?? [];
    list.push(row);
    tagMap.set(row.client_id, list);
  }
  const assigneeMap = new Map(
    assignees.map((row) => [
      row.client_id,
      { id: row.id, name: row.name, role: row.role },
    ]),
  );
  const activityMap = new Map(
    activities.map((row) => [
      row.client_id,
      {
        type: row.type,
        created_at: row.created_at,
        metadata: row.metadata,
      },
    ]),
  );

  const items: ClientListItemDto[] = page.map((row) => {
    const last = activityMap.get(row.id);
    return {
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      firstSeenAt: row.first_seen_at.toISOString(),
      lastSeenAt: row.last_seen_at.toISOString(),
      identities: (identityMap.get(row.id) ?? []).map((i) => ({
        kind: i.kind,
        value: i.value,
        username: i.username,
      })),
      tags: (tagMap.get(row.id) ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        colorKey: t.color_key,
      })),
      assignedUser: assigneeMap.get(row.id) ?? null,
      leadCount: Number(row.lead_count) || 0,
      orderCount: Number(row.order_count) || 0,
      bookingCount: Number(row.booking_count) || 0,
      openConversation: Boolean(row.open_conversation),
      lastActivity: last
        ? {
            type: last.type,
            title: activityTitle(last.type, last.metadata),
            createdAt: last.created_at.toISOString(),
          }
        : null,
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeClientCursor(last.last_seen_at, last.id)
        : null,
    hasMore,
  };
}
