/**
 * Business Intelligence Day 1 — tenant isolation, metrics, insufficient data.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { BusinessBrainService } from "../src/server/intelligence/business-brain.ts";
import { buildSignals } from "../src/server/intelligence/signals.ts";
import { aggregateBusinessStatus } from "../src/server/intelligence/status.ts";
const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function makeUser(name = "User") {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      public_id: "usr_" + id.replaceAll("-", "").slice(0, 16),
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

async function makeBusiness(ownerId, name = "Intel Shop") {
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: b.id,
      user_id: ownerId,
      role: "owner",
      status: "active",
    })
    .execute();
  return b;
}

test("empty business returns insufficient data without fake insights", async () => {
  const uid = await makeUser();
  const b = await makeBusiness(uid);
  const brain = new BusinessBrainService(db);
  const overview = await brain.getOverview(uid, b.public_id);
  assert.equal(overview.dataMode, "insufficient");
  assert.equal(overview.insights.length, 0);
  assert.equal(overview.metrics.length, 0);
  assert.match(overview.summary.text, /Недостаточно данных/i);
});

test("business A cannot read intelligence of business B", async () => {
  const a = await makeUser("A");
  const bUser = await makeUser("B");
  const bizA = await makeBusiness(a, "A shop");
  const bizB = await makeBusiness(bUser, "B shop");
  const brain = new BusinessBrainService(db);
  await assert.rejects(brain.getOverview(a, bizB.public_id), {
    message: "Бизнес не найден.",
  });
  const ok = await brain.getOverview(bUser, bizB.public_id);
  assert.equal(ok.dataMode, "insufficient");
  assert.notEqual(bizA.public_id, bizB.public_id);
});

test("stale open order produces overdue_order insight", async () => {
  const uid = await makeUser();
  const b = await makeBusiness(uid);
  const staleAt = new Date(Date.now() - 48 * 3600000);
  const clientId = randomUUID();
  await db
    .insertInto("client")
    .values({
      id: clientId,
      business_id: b.id,
      name: "Buyer",
    })
    .execute();
  const rk = randomUUID();
  await db
    .insertInto("order")
    .values({
      id: randomUUID(),
      business_id: b.id,
      client_id: clientId,
      order_number: 1,
      status: "new",
      source: "web",
      currency: "RUB",
      total: "100.00",
      subtotal: "100.00",
      fulfillment: "pickup",
      customer_name: "Buyer",
      customer_phone: "+79990001122",
      request_key: rk,
      request_hash: rk,
      items_snapshot: "[]",
      created_at: staleAt,
      updated_at: staleAt,
    })
    .execute();

  const brain = new BusinessBrainService(db);
  const overview = await brain.getOverview(uid, b.public_id);
  assert.equal(overview.dataMode, "live");
  assert.ok(
    overview.insights.some((i) => i.type === "overdue_order"),
    "expected overdue_order insight",
  );
  assert.ok(overview.metrics.some((m) => m.id === "orders_open"));
});

test("sales_drop signal uses period comparison with evidence", () => {
  const snap = {
    businessId: "x",
    timezone: "UTC",
    hasAnyActivity: true,
    ordersOpen: 0,
    ordersStale: 0,
    leadsOpen: 0,
    leadsStale: 0,
    ordersCurrent7d: 4,
    ordersPrevious7d: 10,
    revenueCurrent7d: 0,
    revenuePrevious7d: 0,
    revenueCurrency: "RUB",
    clientsTotal: 0,
    clientsInactive: 0,
    clientsNew30d: 0,
    newOrdersToday: 0,
  };
  const signals = buildSignals(snap);
  const drop = signals.find((s) => s.type === "sales_drop");
  assert.ok(drop);
  assert.equal(drop.evidence[0].current, 4);
  assert.equal(drop.evidence[0].previous, 10);
  assert.equal(
    aggregateBusinessStatus(signals),
    "attention_required",
  );
});

test("overview writes intelligence audit log", async () => {
  const uid = await makeUser();
  const b = await makeBusiness(uid);
  await db
    .insertInto("client")
    .values({
      id: randomUUID(),
      business_id: b.id,
      name: "C",
      last_seen_at: new Date(),
    })
    .execute();
  const brain = new BusinessBrainService(db);
  await brain.getOverview(uid, b.public_id);
  const row = await db
    .selectFrom("intelligence_audit_log")
    .select(sql`count(*)::int`.as("c"))
    .where("business_id", "=", b.id)
    .executeTakeFirst();
  assert.ok(Number(row?.c) >= 1);
});
