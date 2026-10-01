/**
 * Ремонтный пасс OSINT (аудит Stage 1/2) — инварианты, которые раньше
 * не проверялись: провенанс observation→source, остановка traversal на циклах,
 * бюджеты maxRequests/maxObservations/maxSearchResults, abort signal,
 * аудит упавшего run'а, дедуп по identity_key с двумя доменами,
 * ownership-guard для PUBLISHED_BY и отклонения DB-ограничений.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  runDiscovery,
} from "../src/server/intelligence/osint/discovery.ts";
import { createRegistry } from "../src/server/intelligence/osint/providers/registry.ts";
import { createMockProvider } from "../src/server/intelligence/osint/providers/mock.ts";
import { buildTraversalPlan } from "../src/server/intelligence/osint/traversal.ts";
import {
  ensureGlobalEntity,
} from "../src/server/intelligence/osint/entity-graph.ts";
import { upsertRelation, readRelations } from "../src/server/intelligence/osint/relations.ts";
import { recordMention } from "../src/server/intelligence/osint/mentions.ts";
import { classifyResult } from "../src/server/intelligence/osint/classifier.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { DEFAULT_DISCOVERY_BUDGET } from "../src/server/intelligence/osint/config.ts";

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

const RESULTS = [
  { url: "https://romashka.ru/", title: "Кафе Ромашка", snippet: "Барнаул", position: 1 },
  { url: "https://2gis.ru/barnaul/firm/xyz", title: "Кафе Ромашка", snippet: "Барнаул", position: 2 },
  { url: "https://vk.com/romashka_club", title: "Кафе Ромашка", snippet: "Барнаул", position: 3 },
  { url: "https://barnaul-life.example.net/cafes", title: "Кафе Ромашка", snippet: "Барнаул", position: 4 },
];

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

async function makeBusiness(ownerId, name = "Biz") {
  const row = await db
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
    .values({ business_id: row.id, user_id: ownerId, role: "owner", status: "active" })
    .execute();
  return row;
}

async function seedSource(
  normalizedUrl = `https://source-${randomUUID()}.example/`,
) {
  const id = randomUUID();
  await db
    .insertInto("osint_sources")
    .values({
      id,
      type: "website",
      provider: "mock",
      url: normalizedUrl,
      normalized_url: normalizedUrl,
      name: normalizedUrl,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}

async function seedObservation(sourceId, entityId, content = "текст") {
  const id = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id,
      source_id: sourceId,
      entity_id: entityId,
      content,
      content_hash: randomUUID(),
      created_at: new Date(),
    })
    .execute();
  return id;
}

async function entity(key, name) {
  return ensureGlobalEntity(db, {
    identityKey: key,
    displayName: name,
    normalizedName: name.toLowerCase(),
  });
}

test("observation always carries its source link (provenance)", async () => {
  const sourceId = await seedSource("https://provenance.example/");
  const observationId = await seedObservation(
    sourceId,
    null,
    "наблюдение с источником",
  );

  const row = await db
    .selectFrom("osint_observations")
    .select(["id", "source_id"])
    .where("id", "=", observationId)
    .executeTakeFirstOrThrow();
  assert.equal(row.source_id, sourceId, "observation -> source link persisted");

  // NOT NULL источника закреплён в схеме (069:166), а не только в коде.
  await assert.rejects(
    () =>
      db
        .insertInto("osint_observations")
        .values({
          id: randomUUID(),
          source_id: null,
          entity_id: null,
          content: "нет источника",
          content_hash: randomUUID(),
          created_at: new Date(),
        })
        .execute(),
    "observation without source must be rejected by the database",
  );
});

test("traversal terminates on A->B->C->A cycle without revisiting", async () => {
  const a = await entity("domain:cycle-a.example", "Цикл А");
  const b = await entity("domain:cycle-b.example", "Цикл Б");
  const c = await entity("domain:cycle-c.example", "Цикл В");

  const observationId = await seedObservation(await seedSource(), a, "связи");
  await upsertRelation(db, {
    fromEntityId: a,
    toEntityId: b,
    relationType: "PARTNER",
    sourceObservationId: observationId,
    confidence: 0.9,
  });
  await upsertRelation(db, {
    fromEntityId: b,
    toEntityId: c,
    relationType: "PARTNER",
    sourceObservationId: observationId,
    confidence: 0.9,
  });
  await upsertRelation(db, {
    fromEntityId: c,
    toEntityId: a,
    relationType: "PARTNER",
    sourceObservationId: observationId,
    confidence: 0.9,
  });

  const plan = await buildTraversalPlan(db, {
    rootEntityId: a,
    budget: { ...DEFAULT_DISCOVERY_BUDGET, maxDepth: 10, maxEntities: 10 },
  });

  const visited = plan.steps.map((step) => step.entityId);
  assert.equal(plan.stats.visited_entities, 3, "A, B and C visited exactly once");
  assert.equal(plan.steps.length, 3, "no duplicated step per entity");
  assert.equal(new Set(visited).size, visited.length, "steps are unique");
  assert.equal(plan.truncated, false, "generous budget is not truncated");
  assert.ok(!plan.stats.budget_hits.includes("max_depth"));
});

test("traversal reports max_requests and max_observations budget hits", async () => {
  const root = await entity("domain:budget.example", "Бюджет");
  const sourceId = await seedSource("https://budget.example/");
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: root,
      source_id: sourceId,
      confidence: "1",
      created_at: new Date(),
    })
    .onConflict((oc) => oc.columns(["entity_id", "source_id"]).doNothing())
    .execute();
  await seedObservation(sourceId, root, "наблюдение для бюджета");

  const plan = await buildTraversalPlan(db, {
    rootEntityId: root,
    budget: { ...DEFAULT_DISCOVERY_BUDGET, maxRequests: 0, maxObservations: 0 },
  });

  assert.ok(
    plan.stats.budget_hits.includes("max_requests"),
    `budget_hits=${JSON.stringify(plan.stats.budget_hits)}`,
  );
  assert.ok(plan.stats.budget_hits.includes("max_observations"));
  assert.equal(plan.stats.scanned_observations, 0, "observations budget respected");
  assert.equal(plan.truncated, true);
});

test("discovery stops at maxSearchResults budget and reports partial", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);

  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([
      createMockProvider({ id: "mock_search", respond: () => RESULTS }),
    ]),
    profile: PROFILE,
    budget: { maxSearchResults: 2 },
  });

  assert.equal(result.resultsCount, 2, "never reads more than the budget");
  assert.equal(result.status, "partial");
  assert.ok(result.errors.includes("results_budget_exhausted"));
});

test("abort signal stops discovery with aborted_by_caller", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const controller = new AbortController();
  controller.abort();

  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([
      createMockProvider({ id: "mock_search", respond: () => RESULTS }),
    ]),
    profile: PROFILE,
    signal: controller.signal,
  });

  assert.equal(result.status, "partial");
  assert.ok(result.errors.includes("aborted_by_caller"));
  assert.equal(result.queriesCount, 0, "no query runs after abort");

  const run = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("id", "=", result.runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.status, "partial");
  assert.ok(run.error?.includes("aborted_by_caller"));
});

test("failed discovery run writes an audit row with result=failed", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);

  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([createMockProvider({ id: "broken", fail: "boom" })]),
    profile: PROFILE,
  });
  assert.equal(result.status, "failed");

  const audits = await db
    .selectFrom("intelligence_audit_log")
    .selectAll()
    .where("business_id", "=", biz.id)
    .where("operation", "=", "osint.discovery.run")
    .where("result", "=", "failed")
    .execute();
  assert.equal(audits.length, 1, "failure is auditable");
  assert.equal(audits[0].source, "osint");
  assert.equal(audits[0].user_id, uid);
});

test("relation provenance is persisted and read back", async () => {
  const a = await entity("domain:prov-a.example", "Пров А");
  const b = await entity("domain:prov-b.example", "Пров Б");
  const observationId = await seedObservation(await seedSource(), a, "провенанс");

  const created = await upsertRelation(db, {
    fromEntityId: a,
    toEntityId: b,
    relationType: "PARTNER",
    sourceObservationId: observationId,
    confidence: 0.75,
  });
  assert.equal(created.created, true);

  const relations = await readRelations(db, a);
  const match = relations.find((row) => row.id === created.id);
  assert.ok(match, "relation readable");
  assert.equal(match.source_observation_id, observationId, "provenance survives round-trip");

  await assert.rejects(
    () =>
      db
        .insertInto("osint_entity_relations")
        .values({
          id: randomUUID(),
          from_entity_id: a,
          to_entity_id: b,
          relation_type: "RELATED_TO",
          confidence: "1",
          source_observation_id: null,
          evidence: {},
          valid_from: new Date(),
          valid_to: null,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .execute(),
    "relation without provenance must be rejected by the database",
  );
});

test("same display name with two distinct identity keys never merges", async () => {
  const name = "Одинаковое Название";
  const first = await entity("domain:same-a.example", name);
  const second = await entity("domain:same-b.example", name);
  assert.notEqual(first, second, "identity_key decides, not the name");

  const rows = await db
    .selectFrom("osint_entities")
    .select("id")
    .where("display_name", "=", name)
    .execute();
  assert.equal(rows.length, 2, "two rows with the same name stay separate");
});

test("PUBLISHED_BY still requires explicit evidence", async () => {
  const target = await entity("domain:author.example", "Автор");
  const observationId = await seedObservation(await seedSource(), target, "авторство");

  await assert.rejects(
    () =>
      recordMention(db, {
        observationId,
        entityId: target,
        mentionType: "PUBLISHED_BY",
        textSpan: "опубликовано кем-то",
        evidenceKind: "text_span",
      }),
    (error) => error.code === "mention_requires_explicit_evidence",
  );

  const ok = await recordMention(db, {
    observationId,
    entityId: target,
    mentionType: "PUBLISHED_BY",
    textSpan: "canonical author",
    evidenceKind: "sameAs",
  });
  assert.equal(ok.created, true);
});

test("URL longer than the schema CHECK is rejected at classification", async () => {
  const long = "https://example.com/" + "a".repeat(3000);
  const result = classifyResult({ url: long, provider: "mock" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "url_too_long");
});
