import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { pairClients } from "./types.ts";

type Db = Kysely<Database>;

export type DuplicateCandidate = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  leadCount: number;
  orderCount: number;
  bookingCount: number;
  matches: string[];
  identities: { kind: string; username: string | null }[];
};

/**
 * Strong-signal duplicate detection only.
 * Name-only matches are intentionally excluded.
 */
export async function findDuplicateCandidates(
  db: Db,
  businessId: string,
  clientId: string,
): Promise<DuplicateCandidate[]> {
  const client = await db
    .selectFrom("client")
    .select(["id", "phone", "email"])
    .where("business_id", "=", businessId)
    .where("id", "=", clientId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!client) return [];

  const identities = await db
    .selectFrom("client_identity")
    .select(["kind", "value"])
    .where("business_id", "=", businessId)
    .where("client_id", "=", clientId)
    .execute();

  const candidateScores = new Map<string, Set<string>>();

  const add = (id: string, match: string) => {
    if (id === clientId) return;
    const set = candidateScores.get(id) ?? new Set();
    set.add(match);
    candidateScores.set(id, set);
  };

  if (client.phone) {
    const rows = await db
      .selectFrom("client")
      .select("id")
      .where("business_id", "=", businessId)
      .where("archived_at", "is", null)
      .where("phone", "=", client.phone)
      .where("id", "<>", clientId)
      .execute();
    for (const row of rows) add(row.id, "phone");
  }

  if (client.email) {
    const rows = await db
      .selectFrom("client")
      .select("id")
      .where("business_id", "=", businessId)
      .where("archived_at", "is", null)
      .where(({ eb, fn }) =>
        eb(fn("lower", ["email"]), "=", client.email!.toLowerCase()),
      )
      .where("id", "<>", clientId)
      .execute();
    for (const row of rows) add(row.id, "email");
  }

  for (const identity of identities) {
    if (!["telegram", "vk", "whatsapp", "instagram"].includes(identity.kind))
      continue;
    const rows = await db
      .selectFrom("client_identity as i")
      .innerJoin("client as c", (join) =>
        join
          .onRef("c.id", "=", "i.client_id")
          .onRef("c.business_id", "=", "i.business_id"),
      )
      .select("i.client_id")
      .where("i.business_id", "=", businessId)
      .where("i.kind", "=", identity.kind)
      .where("i.value", "=", identity.value)
      .where("c.archived_at", "is", null)
      .where("i.client_id", "<>", clientId)
      .execute();
    for (const row of rows) add(row.client_id, identity.kind);
  }

  const ids = [...candidateScores.keys()];
  if (!ids.length) return [];

  // Hide pairs already marked as separate (or merged).
  const decisions = await db
    .selectFrom("client_duplicate_decision")
    .select(["client_a_id", "client_b_id"])
    .where("business_id", "=", businessId)
    .where((eb) =>
      eb.or(
        ids.map((other) => {
          const [a, b] = pairClients(clientId, other);
          return eb.and([
            eb("client_a_id", "=", a),
            eb("client_b_id", "=", b),
          ]);
        }),
      ),
    )
    .execute();
  const hidden = new Set(
    decisions.map((d) =>
      d.client_a_id === clientId ? d.client_b_id : d.client_a_id,
    ),
  );

  const visibleIds = ids.filter((id) => !hidden.has(id));
  if (!visibleIds.length) return [];

  const rows = await db
    .selectFrom("client as c")
    .select([
      "c.id",
      "c.name",
      "c.phone",
      "c.email",
      "c.first_seen_at",
      "c.last_seen_at",
    ])
    .where("c.business_id", "=", businessId)
    .where("c.id", "in", visibleIds)
    .where("c.archived_at", "is", null)
    .execute();

  const [leads, orders, bookings, otherIdentities] = await Promise.all([
    db
      .selectFrom("lead")
      .select(["client_id"])
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("business_id", "=", businessId)
      .where("client_id", "in", visibleIds)
      .groupBy("client_id")
      .execute(),
    db
      .selectFrom("order")
      .select(["client_id"])
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("business_id", "=", businessId)
      .where("client_id", "in", visibleIds)
      .groupBy("client_id")
      .execute(),
    db
      .selectFrom("booking")
      .select(["client_id"])
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("business_id", "=", businessId)
      .where("client_id", "in", visibleIds)
      .groupBy("client_id")
      .execute(),
    db
      .selectFrom("client_identity")
      .select(["client_id", "kind", "username"])
      .where("business_id", "=", businessId)
      .where("client_id", "in", visibleIds)
      .execute(),
  ]);

  const leadMap = new Map(leads.map((r) => [r.client_id, Number(r.n)]));
  const orderMap = new Map(orders.map((r) => [r.client_id, Number(r.n)]));
  const bookingMap = new Map(bookings.map((r) => [r.client_id, Number(r.n)]));
  const identityMap = new Map<string, { kind: string; username: string | null }[]>();
  for (const row of otherIdentities) {
    const list = identityMap.get(row.client_id) ?? [];
    list.push({ kind: row.kind, username: row.username });
    identityMap.set(row.client_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    firstSeenAt: row.first_seen_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    leadCount: leadMap.get(row.id) ?? 0,
    orderCount: orderMap.get(row.id) ?? 0,
    bookingCount: bookingMap.get(row.id) ?? 0,
    matches: [...(candidateScores.get(row.id) ?? [])],
    identities: identityMap.get(row.id) ?? [],
  }));
}

export async function decideDuplicate(
  db: Db,
  userId: string,
  publicId: string,
  raw: Record<string, unknown>,
) {
  const a =
    typeof raw.clientAId === "string"
      ? raw.clientAId
      : typeof raw.client_a_id === "string"
        ? raw.client_a_id
        : "";
  const bId =
    typeof raw.clientBId === "string"
      ? raw.clientBId
      : typeof raw.client_b_id === "string"
        ? raw.client_b_id
        : "";
  const decision = raw.decision;
  requireUuid(a);
  requireUuid(bId);
  if (a === bId)
    throw new AppError(400, "INVALID_PAIR", "Выберите двух разных клиентов.");
  if (decision !== "separate")
    throw new AppError(
      400,
      "INVALID_DECISION",
      "Публично допускается только решение «разные клиенты». Объединение выполняется через merge.",
    );

  const [clientA, clientB] = pairClients(a, bId);
  return db.transaction().execute(async (tx) => {
    const business = await requireBusiness(
      tx,
      userId,
      publicId,
      "clients.write",
    );
    const rows = await tx
      .selectFrom("client")
      .select("id")
      .where("business_id", "=", business.id)
      .where("id", "in", [clientA, clientB])
      .where("archived_at", "is", null)
      .execute();
    if (rows.length !== 2)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");

    const now = new Date();
    await tx
      .insertInto("client_duplicate_decision")
      .values({
        id: randomUUID(),
        business_id: business.id,
        client_a_id: clientA,
        client_b_id: clientB,
        decision,
        actor_user_id: userId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "client_a_id", "client_b_id"]).doUpdateSet({
          decision,
          actor_user_id: userId,
          updated_at: now,
        }),
      )
      .execute();
    return { ok: true, decision };
  });
}

export async function getDuplicateCompare(
  db: Db,
  userId: string,
  publicId: string,
  clientAId: string,
  clientBId: string,
) {
  requireUuid(clientAId);
  requireUuid(clientBId);
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const load = async (id: string) => {
    const client = await db
      .selectFrom("client")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (!client)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    const [identities, leads, orders, bookings] = await Promise.all([
      db
        .selectFrom("client_identity")
        .select(["kind", "username"])
        .where("business_id", "=", b.id)
        .where("client_id", "=", id)
        .execute(),
      db
        .selectFrom("lead")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("business_id", "=", b.id)
        .where("client_id", "=", id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("order")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("business_id", "=", b.id)
        .where("client_id", "=", id)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("booking")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("business_id", "=", b.id)
        .where("client_id", "=", id)
        .executeTakeFirstOrThrow(),
    ]);
    return {
      id: client.id,
      name: client.name,
      phone: client.phone,
      email: client.email,
      firstSeenAt: client.first_seen_at.toISOString(),
      lastSeenAt: client.last_seen_at.toISOString(),
      identities,
      leadCount: Number(leads.n) || 0,
      orderCount: Number(orders.n) || 0,
      bookingCount: Number(bookings.n) || 0,
    };
  };
  const [left, right] = await Promise.all([
    load(clientAId),
    load(clientBId),
  ]);
  return { clientA: left, clientB: right };
}
