import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  ClientService,
  clientActivity,
} from "../src/server/clients/service.ts";
import { listClientsV2 } from "../src/server/clients/list.ts";
import { getClientSummary } from "../src/server/clients/summary.ts";
import { getClientDetailV2 } from "../src/server/clients/detail.ts";
import { getClientTimeline } from "../src/server/clients/timeline.ts";
import {
  attachTag,
  createTag,
  detachTag,
  assignClient,
  claimClient,
  listBusinessTags,
  setProfileNote,
} from "../src/server/clients/tags.ts";
import {
  decideDuplicate,
  findDuplicateCandidates,
} from "../src/server/clients/duplicates.ts";
import { mergeClients } from "../src/server/clients/merge.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function user(name = "User") {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

async function fixture(role = "owner") {
  const uid = await user(role === "owner" ? "Owner" : role);
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Biz",
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: b.id,
      user_id: uid,
      role,
      status: "active",
    })
    .execute();
  return { uid, b, publicId: b.public_id };
}

async function addMember(businessId, role = "operator") {
  const uid = await user(role);
  await db
    .insertInto("business_member")
    .values({
      business_id: businessId,
      user_id: uid,
      role,
      status: "active",
    })
    .execute();
  return uid;
}

async function makeClient(businessId, patch = {}) {
  const id = randomUUID();
  const now = new Date();
  await db
    .insertInto("client")
    .values({
      id,
      business_id: businessId,
      name: patch.name ?? "Клиент",
      phone: patch.phone ?? null,
      email: patch.email ?? null,
      first_seen_at: patch.first_seen_at ?? now,
      last_seen_at: patch.last_seen_at ?? now,
      profile_note: patch.profile_note ?? null,
      assigned_user_id: patch.assigned_user_id ?? null,
      assigned_at: patch.assigned_user_id ? now : null,
    })
    .execute();
  return id;
}

test("clients v2: tenant isolation on list and detail", async () => {
  const a = await fixture();
  const other = await fixture();
  const id = await makeClient(a.b.id, { name: "Secret" });
  const list = await listClientsV2(db, other.uid, other.publicId, { limit: 50 });
  assert.equal(list.items.some((c) => c.id === id), false);
  await assert.rejects(
    () => getClientDetailV2(db, other.uid, other.publicId, id),
    (e) => e.code === "CLIENT_NOT_FOUND",
  );
});

test("clients v2: search by name phone email telegram username", async () => {
  const { uid, b, publicId } = await fixture();
  const id = await makeClient(b.id, {
    name: "Анна Поиск",
    phone: "+79991112233",
    email: "anna@example.com",
  });
  await db
    .insertInto("client_identity")
    .values({
      business_id: b.id,
      client_id: id,
      kind: "telegram",
      value: "555",
      username: "anna_tg",
    })
    .execute();
  for (const search of ["Анна", "79991112233", "anna@example.com", "anna_tg"]) {
    const page = await listClientsV2(db, uid, publicId, { search, limit: 50 });
    assert.ok(
      page.items.some((c) => c.id === id),
      `search missed for ${search}`,
    );
  }
});

test("clients v2: combined filters", async () => {
  const { uid, b, publicId } = await fixture();
  const match = await makeClient(b.id, {
    name: "Filter Match",
    last_seen_at: new Date(),
  });
  await db
    .insertInto("client_identity")
    .values({
      business_id: b.id,
      client_id: match,
      kind: "telegram",
      value: "777",
      username: null,
    })
    .execute();
  const orderId = randomUUID();
  await db
    .insertInto("order")
    .values({
      id: orderId,
      business_id: b.id,
      client_id: match,
      status: "new",
      fulfillment: "pickup",
      customer_name: "Filter Match",
      customer_phone: "+79990000000",
      currency: "RUB",
      total: "100.00",
      items_snapshot: JSON.stringify([]),
      source: "web",
      request_key: "rk-" + orderId,
      request_hash: "hash-" + orderId,
    })
    .execute();
  const other = await makeClient(b.id, { name: "No Match" });
  void other;
  const page = await listClientsV2(db, uid, publicId, {
    channel: "telegram",
    hasOrders: true,
    activity: "30d",
    limit: 50,
  });
  assert.ok(page.items.some((c) => c.id === match));
  assert.equal(
    page.items.every((c) => c.orderCount > 0),
    true,
  );
});

test("clients v2: keyset pagination stable with equal last_seen_at", async () => {
  const { uid, b, publicId } = await fixture();
  const stamp = new Date("2024-01-15T12:00:00.000Z");
  const ids = [];
  for (let i = 0; i < 5; i++) {
    ids.push(
      await makeClient(b.id, {
        name: `P${i}`,
        last_seen_at: stamp,
      }),
    );
  }
  const first = await listClientsV2(db, uid, publicId, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);
  const second = await listClientsV2(db, uid, publicId, {
    limit: 2,
    cursor: first.nextCursor,
  });
  const seen = new Set([
    ...first.items.map((i) => i.id),
    ...second.items.map((i) => i.id),
  ]);
  assert.equal(seen.size, first.items.length + second.items.length);
  const third = await listClientsV2(db, uid, publicId, {
    limit: 2,
    cursor: second.nextCursor,
  });
  for (const row of third.items) assert.equal(seen.has(row.id), false);
});

test("clients v2: summary KPI", async () => {
  const { uid, b, publicId } = await fixture();
  const recent = new Date();
  const old = new Date(Date.now() - 60 * 86400000);
  await makeClient(b.id, {
    name: "New",
    first_seen_at: recent,
    last_seen_at: recent,
  });
  await makeClient(b.id, {
    name: "Old",
    first_seen_at: old,
    last_seen_at: old,
  });
  const openClient = await makeClient(b.id, {
    name: "Open",
    last_seen_at: recent,
  });
  await db
    .insertInto("communication_conversation")
    .values({
      id: randomUUID(),
      business_id: b.id,
      client_id: openClient,
      platform: "telegram",
      external_user_id: "1",
      status: "open",
    })
    .execute();
  const summary = await getClientSummary(db, uid, publicId);
  assert.ok(summary.total >= 3);
  assert.ok(summary.new30d >= 1);
  assert.ok(summary.active30d >= 2);
  assert.ok(summary.openConversations >= 1);
});

test("clients v2: assignment permissions", async () => {
  const owner = await fixture("owner");
  const admin = await addMember(owner.b.id, "admin");
  const operator = await addMember(owner.b.id, "operator");
  const otherOp = await addMember(owner.b.id, "operator");
  const clientId = await makeClient(owner.b.id, { name: "Assign me" });

  await assignClient(db, operator, owner.publicId, clientId, operator);
  await assert.rejects(
    () => assignClient(db, operator, owner.publicId, clientId, otherOp),
    (e) => e.code === "FORBIDDEN",
  );
  await assignClient(db, admin, owner.publicId, clientId, otherOp);
  await assignClient(db, owner.uid, owner.publicId, clientId, owner.uid);

  const foreign = await fixture();
  await assert.rejects(
    () => assignClient(db, foreign.uid, foreign.publicId, clientId, foreign.uid),
    (e) => e.code === "CLIENT_NOT_FOUND",
  );
});

test("clients v2: tags CRUD and tenant scope", async () => {
  const a = await fixture();
  const other = await fixture();
  const tag = await createTag(db, a.uid, a.publicId, { name: "VIP" });
  const clientId = await makeClient(a.b.id, { name: "Tagged" });
  await attachTag(db, a.uid, a.publicId, clientId, tag.id);
  const tags = await listBusinessTags(db, a.uid, a.publicId);
  assert.ok(tags.some((t) => t.id === tag.id));
  await assert.rejects(
    () => createTag(db, a.uid, a.publicId, { name: "vip" }),
    (e) => e.code === "TAG_EXISTS",
  );
  await assert.rejects(
    () => attachTag(db, other.uid, other.publicId, clientId, tag.id),
    (e) => e.code === "CLIENT_NOT_FOUND" || e.code === "FORBIDDEN" || e.code === "BUSINESS_NOT_FOUND",
  );
  await detachTag(db, a.uid, a.publicId, clientId, tag.id);
});

test("clients v2: profile note", async () => {
  const { uid, b, publicId } = await fixture();
  const clientId = await makeClient(b.id);
  await setProfileNote(db, uid, publicId, clientId, "Важный клиент");
  const detail = await getClientDetailV2(db, uid, publicId, clientId);
  assert.equal(detail.client.profileNote, "Важный клиент");
});

test("clients v2: timeline ordering and pagination", async () => {
  const { uid, b, publicId } = await fixture();
  const clientId = await makeClient(b.id);
  for (let i = 0; i < 5; i++) {
    await db.transaction().execute((tx) =>
      clientActivity(
        tx,
        b.id,
        clientId,
        "client.updated",
        `evt-${i}-${clientId}`,
        clientId,
        uid,
      ),
    );
  }
  await new ClientService(db).note(uid, publicId, clientId, "внутренняя");
  const page = await getClientTimeline(db, uid, publicId, clientId, undefined, 3);
  assert.equal(page.items.length, 3);
  assert.equal(page.hasMore, true);
  for (let i = 1; i < page.items.length; i++) {
    assert.ok(
      page.items[i - 1].createdAt >= page.items[i].createdAt,
    );
  }
  const next = await getClientTimeline(
    db,
    uid,
    publicId,
    clientId,
    page.nextCursor,
    10,
  );
  const ids = new Set([
    ...page.items.map((i) => i.id),
    ...next.items.map((i) => i.id),
  ]);
  assert.equal(ids.size, page.items.length + next.items.length);
  assert.ok(page.items.some((i) => i.actor === "Owner") || next.items.some((i) => i.actor));
});

test("clients v2: duplicate phone candidate; name-only not candidate", async () => {
  const { b } = await fixture();
  const a = await makeClient(b.id, {
    name: "Иван Иванов",
    phone: "+79990001122",
  });
  const samePhone = await makeClient(b.id, {
    name: "Другое имя",
    phone: "+79990001122",
  });
  const sameName = await makeClient(b.id, {
    name: "Иван Иванов",
    phone: "+79990009999",
  });
  const candidates = await findDuplicateCandidates(db, b.id, a);
  assert.ok(candidates.some((c) => c.id === samePhone));
  assert.equal(
    candidates.some((c) => c.id === sameName),
    false,
  );
});

test("clients v2: separate decision hides candidate", async () => {
  const { uid, b, publicId } = await fixture();
  const a = await makeClient(b.id, { phone: "+79995556677" });
  const twin = await makeClient(b.id, { phone: "+79995556677" });
  assert.ok(
    (await findDuplicateCandidates(db, b.id, a)).some((c) => c.id === twin),
  );
  await decideDuplicate(db, uid, publicId, {
    clientAId: a,
    clientBId: twin,
    decision: "separate",
  });
  assert.equal(
    (await findDuplicateCandidates(db, b.id, a)).some((c) => c.id === twin),
    false,
  );
});

test("clients v2: merge moves entities, unions tags, assignment, profile note; operator forbidden", async () => {
  const owner = await fixture("owner");
  const operator = await addMember(owner.b.id, "operator");
  const assignee = await addMember(owner.b.id, "admin");
  const target = await makeClient(owner.b.id, {
    name: "Target",
    phone: "+79991110001",
    profile_note: "Target note",
    assigned_user_id: assignee,
  });
  const source = await makeClient(owner.b.id, {
    name: "Source",
    email: "source@example.com",
    profile_note: "Source note",
    assigned_user_id: null,
  });
  const tag = await createTag(db, owner.uid, owner.publicId, { name: "Постоянный" });
  await attachTag(db, owner.uid, owner.publicId, source, tag.id);
  await db
    .insertInto("lead")
    .values({
      id: randomUUID(),
      business_id: owner.b.id,
      client_id: source,
      source: "telegram",
      name: "Lead",
      status: "new",
      answers: "{}",
    })
    .execute();
  await db
    .insertInto("client_identity")
    .values({
      business_id: owner.b.id,
      client_id: source,
      kind: "vk",
      value: "42",
      username: "vk_user",
    })
    .execute();

  await assert.rejects(
    () =>
      mergeClients(db, operator, owner.publicId, {
        source_client_id: source,
        target_client_id: target,
      }),
    (e) => e.code === "FORBIDDEN",
  );

  const foreign = await fixture();
  await assert.rejects(
    () =>
      mergeClients(db, foreign.uid, foreign.publicId, {
        source_client_id: source,
        target_client_id: target,
      }),
    (e) => e.code === "CLIENT_NOT_FOUND",
  );

  await mergeClients(db, owner.uid, owner.publicId, {
    source_client_id: source,
    target_client_id: target,
  });

  const src = await db
    .selectFrom("client")
    .selectAll()
    .where("id", "=", source)
    .executeTakeFirstOrThrow();
  assert.ok(src.archived_at);
  assert.equal(src.merged_into_id, target);

  const detail = await getClientDetailV2(db, owner.uid, owner.publicId, target);
  assert.equal(detail.client.email, "source@example.com");
  assert.equal(detail.client.profileNote, "Target note");
  assert.equal(detail.assignedUser?.id, assignee);
  assert.ok(detail.tags.some((t) => t.name === "Постоянный"));
  assert.ok(detail.stats.leadCount >= 1);
  assert.ok(detail.stats.noteCount >= 1); // source profile note preserved as note
  assert.ok(detail.identities.some((i) => i.kind === "vk"));
});

test("clients v2: archived excluded; v1 list still works", async () => {
  const { uid, b, publicId } = await fixture();
  const live = await makeClient(b.id, { name: "Live" });
  const archived = await makeClient(b.id, { name: "Archived" });
  await db
    .updateTable("client")
    .set({ archived_at: new Date() })
    .where("id", "=", archived)
    .execute();
  const v2 = await listClientsV2(db, uid, publicId, { limit: 50 });
  assert.ok(v2.items.some((c) => c.id === live));
  assert.equal(v2.items.some((c) => c.id === archived), false);
  const v1 = await new ClientService(db).list(uid, publicId);
  assert.ok(v1.some((c) => c.id === live));
  assert.equal(v1.some((c) => c.id === archived), false);
});

test("clients v2: invalid cursor rejected", async () => {
  const { uid, publicId } = await fixture();
  await assert.rejects(
    () => listClientsV2(db, uid, publicId, { cursor: "not-a-cursor", limit: 10 }),
    (e) => e.code === "INVALID_CURSOR",
  );
});

test("clients v2: PATCH assignment bypass blocked for operator", async () => {
  const owner = await fixture("owner");
  const operator = await addMember(owner.b.id, "operator");
  const other = await addMember(owner.b.id, "admin");
  const occupied = await makeClient(owner.b.id, {
    name: "Occupied",
    assigned_user_id: other,
  });
  const free = await makeClient(owner.b.id, { name: "Free" });
  const svc = new ClientService(db);

  await assert.rejects(
    () =>
      svc.save(
        operator,
        owner.publicId,
        { name: "Occupied", assignedUserId: null },
        occupied,
      ),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () =>
      svc.save(
        operator,
        owner.publicId,
        { name: "Occupied", assignedUserId: operator },
        occupied,
      ),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () =>
      svc.save(
        operator,
        owner.publicId,
        { name: "Occupied", assignedUserId: other },
        occupied,
      ),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () =>
      svc.save(
        operator,
        owner.publicId,
        { name: "Free", assignedUserId: other },
        free,
      ),
    (e) => e.code === "FORBIDDEN",
  );

  // Claim unassigned self via PATCH → OK
  await svc.save(
    operator,
    owner.publicId,
    { name: "Free", assignedUserId: operator },
    free,
  );
  const claimed = await db
    .selectFrom("client")
    .select("assigned_user_id")
    .where("id", "=", free)
    .executeTakeFirstOrThrow();
  assert.equal(claimed.assigned_user_id, operator);

  // Owner may reassign / unassign
  await svc.save(
    owner.uid,
    owner.publicId,
    { name: "Occupied", assignedUserId: operator },
    occupied,
  );
  await svc.save(
    owner.uid,
    owner.publicId,
    { name: "Occupied", assignedUserId: null },
    occupied,
  );
});

test("clients v2: operator claim unassigned; cannot unassign/reassign occupied", async () => {
  const owner = await fixture("owner");
  const operator = await addMember(owner.b.id, "operator");
  const other = await addMember(owner.b.id, "admin");
  const free = await makeClient(owner.b.id, { name: "Claim me" });
  const occupied = await makeClient(owner.b.id, {
    name: "Taken",
    assigned_user_id: other,
  });

  const result = await claimClient(db, operator, owner.publicId, free);
  assert.equal(result.assignedUser?.id, operator);

  await assert.rejects(
    () => assignClient(db, operator, owner.publicId, occupied, null),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () => assignClient(db, operator, owner.publicId, occupied, operator),
    (e) => e.code === "FORBIDDEN",
  );
  await assert.rejects(
    () => assignClient(db, operator, owner.publicId, occupied, other),
    (e) => e.code === "FORBIDDEN",
  );

  const timeline = await getClientTimeline(
    db,
    owner.uid,
    owner.publicId,
    free,
    undefined,
    20,
  );
  assert.ok(timeline.items.some((i) => i.type === "client.assigned"));
});

test("clients v2: timeline note appears once; mixed keyset stable", async () => {
  const { uid, b, publicId } = await fixture();
  const clientId = await makeClient(b.id, { name: "Notes" });
  const svc = new ClientService(db);
  await svc.note(uid, publicId, clientId, "Единственная заметка");

  const stamp = new Date("2026-03-15T12:00:00.000Z");
  const actA = randomUUID();
  const actB = randomUUID();
  await db
    .insertInto("client_activity")
    .values([
      {
        id: actA,
        business_id: b.id,
        client_id: clientId,
        type: "lead.created",
        event_key: `lead:${actA}`,
        target_id: actA,
        actor_user_id: uid,
        created_at: stamp,
      },
      {
        id: actB,
        business_id: b.id,
        client_id: clientId,
        type: "order.created",
        event_key: `order:${actB}`,
        target_id: actB,
        actor_user_id: uid,
        created_at: stamp,
      },
    ])
    .execute();
  const noteId = randomUUID();
  await db
    .insertInto("client_note")
    .values({
      id: noteId,
      business_id: b.id,
      client_id: clientId,
      actor_user_id: uid,
      text: "Same stamp note",
      created_at: stamp,
    })
    .execute();
  // Audit activity that would otherwise duplicate the note stream
  await db
    .insertInto("client_activity")
    .values({
      id: randomUUID(),
      business_id: b.id,
      client_id: clientId,
      type: "client.note_added",
      event_key: `client-note:${noteId}`,
      target_id: noteId,
      actor_user_id: uid,
      created_at: stamp,
    })
    .execute();

  const full = await getClientTimeline(db, uid, publicId, clientId, undefined, 50);
  const noteItems = full.items.filter((i) => i.type === "client.note_added");
  assert.equal(noteItems.length, 2); // svc.note + same stamp note — each once
  assert.equal(
    full.items.filter((i) => i.description === "Единственная заметка").length,
    1,
  );
  assert.equal(
    full.items.filter((i) => i.description === "Same stamp note").length,
    1,
  );

  const page1 = await getClientTimeline(db, uid, publicId, clientId, undefined, 1);
  assert.equal(page1.items.length, 1);
  assert.equal(page1.hasMore, true);
  const page2 = await getClientTimeline(
    db,
    uid,
    publicId,
    clientId,
    page1.nextCursor,
    2,
  );
  const page3 = await getClientTimeline(
    db,
    uid,
    publicId,
    clientId,
    page2.nextCursor,
    10,
  );
  const allIds = [
    ...page1.items,
    ...page2.items,
    ...page3.items,
  ].map((i) => i.id);
  assert.equal(new Set(allIds).size, allIds.length);
  // Same-timestamp activity+note all appear exactly once across pages
  for (const id of [actA, actB, noteId]) {
    assert.equal(allIds.filter((x) => x === id).length, 1, id);
  }
});

test("clients v2: today filter uses business timezone", async () => {
  const { uid, b, publicId } = await fixture();
  await db
    .updateTable("business")
    .set({ timezone: "Europe/Kaliningrad" })
    .where("id", "=", b.id)
    .execute();

  // Kaliningrad is UTC+2. 22:30 UTC previous calendar day is already "today" in Kaliningrad
  // when UTC date rolled back but local day did not — pick a time that is after local midnight
  // but before UTC midnight when that situation applies. Safer: set last_seen to "now"
  // and also create a client just before local midnight that must be excluded.
  const { localDay, localInstants } = await import(
    "../src/server/booking/time.ts"
  );
  const now = new Date();
  const day = localDay(now, "Europe/Kaliningrad");
  const localMidnight = localInstants(day, 0, "Europe/Kaliningrad")[0];
  assert.ok(localMidnight);

  const activeToday = await makeClient(b.id, {
    name: "Today",
    last_seen_at: new Date(localMidnight.getTime() + 60_000),
  });
  const yesterday = await makeClient(b.id, {
    name: "Yesterday",
    last_seen_at: new Date(localMidnight.getTime() - 60_000),
  });

  const page = await listClientsV2(db, uid, publicId, {
    activity: "today",
    limit: 50,
  });
  assert.ok(page.items.some((c) => c.id === activeToday));
  assert.equal(page.items.some((c) => c.id === yesterday), false);
});

test("clients v2: cross-business client_tag_link rejected", async () => {
  const a = await fixture();
  const b = await fixture();
  const clientA = await makeClient(a.b.id, { name: "A" });
  const tagB = await createTag(db, b.uid, b.publicId, { name: "Чужой" });
  await assert.rejects(async () => {
    await db
      .insertInto("client_tag_link")
      .values({
        business_id: a.b.id,
        client_id: clientA,
        tag_id: tagB.id,
      })
      .execute();
  });
});

test("clients v2: public duplicate merged decision blocked", async () => {
  const { uid, b, publicId } = await fixture();
  const a = await makeClient(b.id, { phone: "+79991110000" });
  const twin = await makeClient(b.id, { phone: "+79991110000" });
  await assert.rejects(
    () =>
      decideDuplicate(db, uid, publicId, {
        clientAId: a,
        clientBId: twin,
        decision: "merged",
      }),
    (e) => e.code === "INVALID_DECISION",
  );
});

test("clients v2: malformed filters rejected", async () => {
  const { parseListFilters } = await import("../src/server/clients/list.ts");
  assert.throws(
    () => parseListFilters(new URLSearchParams("tagId=abc")),
    (e) => e.code === "INVALID_FILTER",
  );
  assert.throws(
    () => parseListFilters(new URLSearchParams("assignedUserId=abc")),
    (e) => e.code === "INVALID_FILTER",
  );
  assert.throws(
    () => parseListFilters(new URLSearchParams("activity=hacker")),
    (e) => e.code === "INVALID_FILTER",
  );
  assert.throws(
    () => parseListFilters(new URLSearchParams("channel=test")),
    (e) => e.code === "INVALID_FILTER",
  );
  const badCursor = Buffer.from(
    JSON.stringify({ t: new Date().toISOString(), id: "not-a-uuid" }),
  ).toString("base64url");
  assert.throws(
    () => parseListFilters(new URLSearchParams("cursor=" + badCursor)),
    (e) => e.code === "INVALID_CURSOR" || e.code === "INVALID_ID",
  );
});

test("clients v2: phone search normalization variants", async () => {
  const { uid, b, publicId } = await fixture();
  const id = await makeClient(b.id, {
    name: "Phone Norm",
    phone: "+79991112233",
  });
  for (const search of [
    "79991112233",
    "+79991112233",
    "9991112233",
    "+7 999 111-22-33",
  ]) {
    const page = await listClientsV2(db, uid, publicId, { search, limit: 20 });
    assert.ok(
      page.items.some((c) => c.id === id),
      `phone search missed for ${search}`,
    );
  }
});

test("clients v2: optimistic concurrency conflict", async () => {
  const { uid, b, publicId } = await fixture();
  const id = await makeClient(b.id, { name: "Rev" });
  const detail = await getClientDetailV2(db, uid, publicId, id);
  const svc = new ClientService(db);
  await svc.save(uid, publicId, { name: "Rev 2" }, id);
  await assert.rejects(
    () =>
      svc.save(
        uid,
        publicId,
        { name: "Rev stale", updatedAt: detail.client.updatedAt },
        id,
      ),
    (e) => e.code === "CLIENT_CHANGED",
  );
});

test("clients v2: manual lead source not telegram", async () => {
  const { uid, b, publicId } = await fixture();
  await db
    .insertInto("business_solution")
    .values({
      business_id: b.id,
      solution_code: "leads",
      status: "active",
    })
    .execute();
  const clientId = await makeClient(b.id, {
    name: "Lead Client",
    phone: "+79992223344",
  });
  const { LeadService } = await import("../src/server/leads/service.ts");
  const leads = new LeadService(db);
  const lead = await leads.create(uid, publicId, {
    source: "manual",
    name: "Lead Client",
    phone: "+79992223344",
    clientId,
  });
  assert.equal(lead.source, "manual");
  assert.notEqual(lead.source, "telegram");
  assert.equal(lead.clientId, clientId);
});

test("clients v2: create order for existing client_id", async () => {
  const { uid, b, publicId } = await fixture();
  await db
    .insertInto("business_solution")
    .values({
      business_id: b.id,
      solution_code: "orders",
      status: "active",
    })
    .execute();
  const clientId = await makeClient(b.id, {
    name: "Order Client",
    phone: "+79993334455",
  });
  const { CatalogService, OrderService } = await import(
    "../src/server/orders/service.ts"
  );
  const catalog = new CatalogService(db);
  const orders = new OrderService(db);
  const product = await catalog.saveProduct(uid, publicId, {
    name: "Товар",
    price: "100",
    active: true,
  });
  const before = await getClientDetailV2(db, uid, publicId, clientId);
  const order = await orders.checkoutForBusiness(uid, publicId, {
    platform: "web",
    request_key: "rk-client-" + randomUUID(),
    client_id: clientId,
    customer_name: "Wrong Name",
    customer_phone: "+79990000000",
    fulfillment: "pickup",
    cart_items: [{ product_id: product.id, quantity: 1 }],
  });
  assert.equal(order.client_id, clientId);
  assert.equal(order.customer_name, "Order Client");
  const after = await getClientDetailV2(db, uid, publicId, clientId);
  assert.equal(after.stats.orderCount, before.stats.orderCount + 1);
  const timeline = await getClientTimeline(db, uid, publicId, clientId);
  assert.ok(timeline.items.some((i) => i.type === "order.created"));
  // No second client created for this phone mismatch
  const twins = await db
    .selectFrom("client")
    .select("id")
    .where("business_id", "=", b.id)
    .where("phone", "=", "+79990000000")
    .where("archived_at", "is", null)
    .execute();
  assert.equal(twins.length, 0);
});

test("clients v2: create booking for existing client", async () => {
  const { uid, b, publicId } = await fixture();
  await db
    .updateTable("business")
    .set({ timezone: "Europe/Kaliningrad" })
    .where("id", "=", b.id)
    .execute();
  await db
    .insertInto("business_solution")
    .values({
      business_id: b.id,
      solution_code: "booking",
      status: "active",
      starts_at: new Date(),
      expires_at: null,
    })
    .execute();
  const { BookingService } = await import("../src/server/booking/service.ts");
  const svc = new BookingService(db);
  const service = await svc.configure(uid, publicId, {
    kind: "service",
    name: "Стрижка",
    duration_minutes: 60,
    buffer_before_minutes: 0,
    buffer_after_minutes: 0,
  });
  const specialist = await svc.configure(uid, publicId, {
    kind: "specialist",
    name: "Мастер",
  });
  await svc.configure(uid, publicId, {
    kind: "links",
    specialist_id: specialist.id,
    service_ids: [service.id],
  });
  for (let weekday = 0; weekday < 7; weekday++)
    await svc.configure(uid, publicId, {
      kind: "schedule",
      specialist_id: specialist.id,
      weekday,
      intervals: [{ start: 0, end: 1440 }],
    });
  const clientId = await makeClient(b.id, {
    name: "Booking Client",
    phone: "+79994445566",
  });
  const { localDay, localInstants } = await import(
    "../src/server/booking/time.ts"
  );
  const day = localDay(
    new Date(Date.now() + 2 * 86400000),
    "Europe/Kaliningrad",
  );
  const starts = localInstants(day, 10 * 60, "Europe/Kaliningrad")[0];
  assert.ok(starts);
  const booking = await svc.create(uid, publicId, {
    client_id: clientId,
    service_id: service.id,
    specialist_id: specialist.id,
    starts_at: starts.toISOString(),
    request_key: "bk-" + randomUUID(),
  });
  assert.equal(booking.client_id, clientId);
  const after = await getClientDetailV2(db, uid, publicId, clientId);
  assert.ok(after.stats.bookingCount >= 1);
});

test("clients v2: operator creates client without assignee then claims", async () => {
  const owner = await fixture("owner");
  const operator = await addMember(owner.b.id, "operator");
  const svc = new ClientService(db);
  // No assignedUserId in payload — must succeed and stay unassigned.
  const created = await svc.save(operator, owner.publicId, {
    name: "Операторский клиент",
    phone: "+79995556600",
  });
  const row = await db
    .selectFrom("client")
    .select(["assigned_user_id", "name"])
    .where("id", "=", created.id)
    .executeTakeFirstOrThrow();
  assert.equal(row.assigned_user_id, null);
  assert.equal(row.name, "Операторский клиент");

  const claimed = await claimClient(db, operator, owner.publicId, created.id);
  assert.equal(claimed.assignedUser?.id, operator);
});
