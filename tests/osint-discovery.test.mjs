/**
 * OSINT discovery — PGlite: оркестратор, дедупликация, авто-accept,
 * tenant isolation, ошибки провайдеров, stale-релиз, аудит.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  releaseStaleDiscoveryRuns,
  runDiscovery,
} from "../src/server/intelligence/osint/discovery.ts";
import { createRegistry } from "../src/server/intelligence/osint/providers/registry.ts";
import { createMockProvider } from "../src/server/intelligence/osint/providers/mock.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description:
    "Кафе Ромашка — уютное кафе в Барнауле.\nГород: Барнаул\nул. Ленина, 10\nТелефон: 8 (3852) 55-10-10\nСайт: https://romashka.ru",
  contact_info: "8 (3852) 55-10-10",
  industry: "food",
});

const SEARCH_RESULTS = [
  {
    url: "https://romashka.ru/",
    title: "Кафе Ромашка — официальный сайт",
    snippet: "Кафе Ромашка в Барнауле, ул. Ленина, 10. Телефон 8 (3852) 55-10-10",
    position: 1,
  },
  {
    url: "https://2gis.ru/barnaul/firm/xyz",
    title: "Кафе Ромашка",
    snippet: "ул. Ленина, 10, телефон 8 (3852) 55-10-10, Барнаул",
    position: 2,
  },
  {
    url: "https://vk.com/romashka_club",
    title: "Кафе Ромашка Барнаул",
    snippet: "сообщество",
    position: 3,
  },
  {
    url: "https://barnaul-life.example.net/cafes",
    title: "Кафе Ромашка Барнаул",
    snippet: "список заведений города",
    position: 4,
  },
  {
    url: "https://blog.example.ru/digital",
    title: "Продвижение сайтов в Барнауле",
    snippet: "агентство",
    position: 5,
  },
  {
    url: "https://hh.ru/vacancy/99",
    title: "Официант",
    snippet: "вакансия",
    position: 6,
  },
];

function registryReturningResults() {
  return createRegistry([
    createMockProvider({
      id: "mock_search",
      respond: (input) =>
        input.query.templateId === "name_city" ? SEARCH_RESULTS : [],
    }),
  ]);
}

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

test("discovery run stores candidates, auto-accepts exact matches", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");

  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: registryReturningResults(),
    profile: PROFILE,
  });

  assert.equal(result.status, "completed", result.errors.join(" | "));
  assert.equal(result.errors.length, 0);
  assert.equal(result.resultsCount, 6);
  assert.equal(result.candidatesCount, 5);
  assert.equal(result.duplicatesCount, 0);
  assert.equal(result.acceptedCount, 2);
  assert.equal(result.reviewCount, 2);
  assert.equal(result.rejectedCount, 1);

  const candidates = await db
    .selectFrom("osint_source_candidates")
    .selectAll()
    .where("business_id", "=", biz.id)
    .execute();
  assert.equal(candidates.length, 5);
  const byStatus = (status) =>
    candidates.filter((row) => row.status === status).length;
  assert.equal(byStatus("accepted"), 2);
  assert.equal(byStatus("candidate"), 2);
  assert.equal(byStatus("rejected"), 1);
  // Доска вакансий не должна попасть в кандидаты вовсе.
  assert.ok(!candidates.some((row) => row.url.includes("hh.ru")));

  // Глобальная сущность доступна через тенантский мост (§4).
  const entities = await db
    .selectFrom("osint_business_entities")
    .innerJoin("osint_entities", "osint_entities.id", "osint_business_entities.entity_id")
    .selectAll("osint_entities")
    .where("osint_business_entities.business_id", "=", biz.id)
    .execute();
  assert.equal(entities.length, 1);
  assert.equal(entities[0].identity_key, "domain:romashka.ru");
  assert.equal(entities[0].city, "Барнаул");
  assert.equal(entities[0].phone, "73852551010");
  assert.equal(entities[0].business_id, undefined, "public entity has no tenant column");

  const entityId = entities[0].id;

  // Источники больше не тенантские — они глобальные, связь через entity_sources.
  const sources = await db
    .selectFrom("osint_entity_sources")
    .innerJoin("osint_sources", "osint_sources.id", "osint_entity_sources.source_id")
    .selectAll("osint_sources")
    .where("osint_entity_sources.entity_id", "=", entityId)
    .execute();
  assert.equal(sources.length, 2);
  for (const source of sources) {
    assert.equal(source.origin, "discovery");
    assert.equal(source.status, "active");
    assert.equal(source.auto_accepted, true);
    assert.equal(source.business_id, undefined, "public source has no tenant column");
  }
  const ownSite = sources.find((s) => s.normalized_url.includes("romashka.ru"));
  const mapListing = sources.find((s) => s.normalized_url.includes("2gis.ru"));
  assert.equal(ownSite?.type, "website");
  assert.equal(ownSite?.trust_level, "official");
  assert.equal(mapListing?.type, "maps");
  assert.equal(mapListing?.trust_level, "public_directory");

  const links = await db
    .selectFrom("osint_entity_sources")
    .selectAll()
    .where("entity_id", "=", entityId)
    .execute();
  assert.equal(links.length, 2);

  // Structured source memory (§1) заводится сразу при создании источника.
  const contexts = await db
    .selectFrom("osint_source_context")
    .selectAll()
    .execute();
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every((row) => !("business_id" in row)));
  const history = await db
    .selectFrom("osint_source_history")
    .selectAll()
    .execute();
  assert.equal(history.length, 2, "create writes one history row per source");
  assert.equal(history[0].change_kind, "create");

  const runs = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("business_id", "=", biz.id)
    .execute();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "completed");
  assert.equal(runs[0].accepted_count, 2);
  assert.ok(runs[0].finished_at);

  const audits = await db
    .selectFrom("intelligence_audit_log")
    .selectAll()
    .where("business_id", "=", biz.id)
    .where("operation", "=", "osint.discovery.run")
    .execute();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].source, "osint");
  assert.equal(audits[0].result, "completed");
});

test("second run deduplicates candidates and sources", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");

  const first = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: registryReturningResults(),
    profile: PROFILE,
  });
  const second = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: registryReturningResults(),
    profile: PROFILE,
  });

  assert.equal(first.status, "completed");
  assert.equal(second.status, "completed");
  assert.equal(second.candidatesCount, 0);
  assert.equal(second.duplicatesCount, 5);
  assert.equal(second.acceptedCount, 0);
  assert.equal(second.reviewCount, 0);
  assert.equal(second.rejectedCount, 0);

  const candidates = await db
    .selectFrom("osint_source_candidates")
    .selectAll()
    .where("business_id", "=", biz.id)
    .execute();
  assert.equal(candidates.length, 5, "no duplicated candidate rows");

  const entityIds = await db
    .selectFrom("osint_business_entities")
    .select("entity_id")
    .where("business_id", "=", biz.id)
    .execute();
  assert.equal(entityIds.length, 1, "single bridge row across runs");
  const entityId = entityIds[0].entity_id;

  const sources = await db
    .selectFrom("osint_entity_sources")
    .selectAll()
    .where("entity_id", "=", entityId)
    .execute();
  assert.equal(sources.length, 2, "no duplicated sources");

  const entities = await db
    .selectFrom("osint_entities")
    .selectAll()
    .where("id", "=", entityId)
    .execute();
  assert.equal(entities.length, 1, "entity is stable across runs");
  assert.equal(entities[0].business_id, undefined, "entity is global, not tenant-owned");
});

test("tenant isolation: another business gets its own candidates", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "A");
  const bizB = await makeBusiness(uid, "B");

  await runDiscovery(db, {
    businessId: bizA.id,
    userId: uid,
    registry: registryReturningResults(),
    profile: PROFILE,
  });
  await runDiscovery(db, {
    businessId: bizB.id,
    userId: uid,
    registry: registryReturningResults(),
    profile: PROFILE,
  });

  const rowsA = await db
    .selectFrom("osint_source_candidates")
    .select("id")
    .where("business_id", "=", bizA.id)
    .execute();
  const rowsB = await db
    .selectFrom("osint_source_candidates")
    .select("id")
    .where("business_id", "=", bizB.id)
    .execute();
  assert.equal(rowsA.length, 5);
  assert.equal(rowsB.length, 5);
  const idsA = new Set(rowsA.map((row) => row.id));
  assert.ok(rowsB.every((row) => !idsA.has(row.id)), "no shared rows");

  // §5: публичный evidence общий, тенант-состояние — раздельное.
  const bridges = await db
    .selectFrom("osint_business_entities")
    .selectAll()
    .where("business_id", "in", [bizA.id, bizB.id])
    .execute();
  assert.equal(bridges.length, 2);
  assert.equal(bridges[0].entity_id, bridges[1].entity_id, "same public entity shared");

  const runsA = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("business_id", "=", bizA.id)
    .execute();
  const runsB = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("business_id", "=", bizB.id)
    .execute();
  assert.notEqual(runsA[0].id, runsB[0].id, "runs never shared");

  // Глобальный слой не должен уметь фильтроваться по тенанту.
  const sourceRow = await db
    .selectFrom("osint_sources")
    .selectAll()
    .executeTakeFirstOrThrow();
  assert.equal(sourceRow.business_id, undefined);
});

test("empty registry yields partial run with explicit error", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([]),
    profile: PROFILE,
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.errors, ["no_providers_available"]);
  assert.equal(result.queriesCount, 0);

  const run = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("business_id", "=", biz.id)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "partial");
  assert.equal(run.error, "no_providers_available");
});

test("totally failing provider yields failed run", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([createMockProvider({ id: "broken", fail: "boom" })]),
    profile: PROFILE,
  });
  assert.equal(result.status, "failed");
  assert.ok(result.errors.some((value) => value.startsWith("provider:broken:boom")));
  assert.ok(result.queriesCount > 0);

  const run = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("business_id", "=", biz.id)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "failed");
  assert.ok(run.error?.includes("boom"));
});

test("stale running/queued runs are released as failed", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const staleId = randomUUID();
  const freshId = randomUUID();
  const staleStart = new Date(Date.now() - 20 * 60_000);

  await db
    .insertInto("osint_discovery_runs")
    .values({
      id: staleId,
      business_id: biz.id,
      status: "running",
      started_at: staleStart,
      created_at: staleStart,
      updated_at: staleStart,
    })
    .execute();
  await db
    .insertInto("osint_discovery_runs")
    .values({
      id: freshId,
      business_id: biz.id,
      status: "running",
      started_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  const released = await releaseStaleDiscoveryRuns(db);
  assert.ok(released >= 1);

  const stale = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("id", "=", staleId)
    .executeTakeFirstOrThrow();
  assert.equal(stale.status, "failed");
  assert.equal(stale.error, "stale_run_expired");
  assert.ok(stale.finished_at);

  const fresh = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("id", "=", freshId)
    .executeTakeFirstOrThrow();
  assert.equal(fresh.status, "running");
  assert.equal(fresh.error, null);
});
