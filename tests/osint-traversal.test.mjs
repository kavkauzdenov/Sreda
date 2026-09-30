/**
 * OSINT traversal (§21-§25) — глубина, бюджеты, приоритет источников.
 * Обход идёт только по локальному графу, без сетевых запросов (§26).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  buildTraversalPlan,
  runTraversal,
} from "../src/server/intelligence/osint/traversal.ts";
import {
  ensureGlobalEntity,
  linkBusinessEntity,
} from "../src/server/intelligence/osint/entity-graph.ts";
import { linkEntitySource } from "../src/server/intelligence/osint/candidates.ts";
import { upsertRelation } from "../src/server/intelligence/osint/relations.ts";
import {
  DEFAULT_DISCOVERY_BUDGET,
  TRAVERSAL_PRIORITY,
} from "../src/server/intelligence/osint/config.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function makeUser() {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      public_id: "usr_" + id.replaceAll("-", "").slice(0, 16),
      name: "User",
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

async function makeBusiness(ownerId) {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name: "Biz",
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

async function seedEntity(key, name) {
  return ensureGlobalEntity(db, {
    identityKey: `domain:${key}`,
    displayName: name,
    normalizedName: name.toLowerCase(),
  });
}

async function seedSource(type) {
  const id = randomUUID();
  const url = `https://${type}-${id.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id,
      type,
      provider: "mock",
      url,
      normalized_url: url,
      name: type,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}

async function seedObservation(sourceId, entityId) {
  const id = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id,
      source_id: sourceId,
      entity_id: entityId,
      content: "наблюдение",
      content_hash: randomUUID(),
      created_at: new Date(),
    })
    .execute();
  return id;
}

function budget(overrides = {}) {
  return { ...DEFAULT_DISCOVERY_BUDGET, ...overrides };
}

test("BFS stops at maxDepth and never reaches deeper nodes", async () => {
  const evidenceSource = await seedSource("other");
  const observationId = await seedObservation(evidenceSource, null);

  const root = await seedEntity("root.example.org", "Корень");
  const mid = await seedEntity("mid.example.org", "Середина");
  const leaf = await seedEntity("leaf.example.org", "Лист");

  await upsertRelation(db, {
    fromEntityId: mid,
    toEntityId: root,
    relationType: "SUPPLIER",
    sourceObservationId: observationId,
    confidence: 0.8,
  });
  await upsertRelation(db, {
    fromEntityId: leaf,
    toEntityId: mid,
    relationType: "RELATED_TO",
    sourceObservationId: observationId,
    confidence: 0.8,
  });

  const plan = await buildTraversalPlan(db, {
    rootEntityId: root,
    budget: budget({ maxDepth: 1 }),
  });

  const ids = plan.steps.map((step) => step.entityId);
  assert.ok(ids.includes(root), "depth 0 visited");
  assert.ok(ids.includes(mid), "depth 1 visited");
  assert.ok(!ids.includes(leaf), "depth 2 blocked by maxDepth");
  assert.equal(plan.stats.max_depth_reached, 1);
  assert.ok(plan.stats.budget_hits.includes("max_depth"));
  assert.equal(plan.truncated, true);
});

test("maxEntities budget stops traversal and reports the hit", async () => {
  const evidenceSource = await seedSource("other");
  const observationId = await seedObservation(evidenceSource, null);

  const a = await seedEntity("budget-a.example.org", "A");
  const b = await seedEntity("budget-b.example.org", "B");
  const c = await seedEntity("budget-c.example.org", "C");

  await upsertRelation(db, {
    fromEntityId: b,
    toEntityId: a,
    relationType: "RELATED_TO",
    sourceObservationId: observationId,
    confidence: 0.5,
  });
  await upsertRelation(db, {
    fromEntityId: c,
    toEntityId: a,
    relationType: "RELATED_TO",
    sourceObservationId: observationId,
    confidence: 0.5,
  });

  const plan = await buildTraversalPlan(db, {
    rootEntityId: a,
    budget: budget({ maxDepth: 3, maxEntities: 1 }),
  });

  assert.equal(plan.stats.visited_entities, 1);
  assert.equal(plan.steps.length, 1);
  assert.ok(plan.stats.budget_hits.includes("max_entities"));
  assert.equal(plan.truncated, true);
});

test("sources are prioritized by type: website beats directory and reviews", async () => {
  const root = await seedEntity("priority.example.org", "Приоритет");

  const website = await seedSource("website");
  const directory = await seedSource("directory");
  const reviews = await seedSource("review_platform");
  const news = await seedSource("news");

  await linkEntitySource(db, { entityId: root, sourceId: website, confidence: 0.9 });
  await linkEntitySource(db, { entityId: root, sourceId: directory, confidence: 0.9 });
  await linkEntitySource(db, { entityId: root, sourceId: reviews, confidence: 0.9 });
  await linkEntitySource(db, { entityId: root, sourceId: news, confidence: 0.9 });

  const plan = await buildTraversalPlan(db, {
    rootEntityId: root,
    budget: budget({ maxDepth: 0 }),
  });

  const step = plan.steps.find((item) => item.entityId === root);
  assert.ok(step, "root step present");
  assert.equal(step.tier, "official_website", "§24: официальный сайт приоритетнее");
  assert.equal(step.sourceIds.length, 4, "все источники учтены");

  const websiteRank = TRAVERSAL_PRIORITY.indexOf(step.tier);
  assert.equal(websiteRank, 0);
  assert.ok(TRAVERSAL_PRIORITY.indexOf("reviews") > websiteRank);
  assert.ok(TRAVERSAL_PRIORITY.indexOf("maps_and_directories") > websiteRank);
});

test("budget maxSources limits discovered sources", async () => {
  const root = await seedEntity("maxsources.example.org", "Источники");
  for (const type of ["website", "directory", "review_platform"]) {
    const sourceId = await seedSource(type);
    await linkEntitySource(db, { entityId: root, sourceId, confidence: 0.5 });
  }

  const plan = await buildTraversalPlan(db, {
    rootEntityId: root,
    budget: budget({ maxDepth: 0, maxSources: 1 }),
  });

  assert.equal(plan.stats.discovered_sources, 1);
  assert.ok(plan.stats.budget_hits.includes("max_sources"));
});

test("runTraversal persists depth, max_depth and stats into the run", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);

  const evidenceSource = await seedSource("other");
  const observationId = await seedObservation(evidenceSource, null);
  const root = await seedEntity("run-root.example.org", "Корень run");
  const neighbour = await seedEntity("run-neighbour.example.org", "Сосед run");
  await upsertRelation(db, {
    fromEntityId: neighbour,
    toEntityId: root,
    relationType: "CLIENT",
    sourceObservationId: observationId,
    confidence: 0.6,
  });

  await linkBusinessEntity(db, { businessId: biz.id, entityId: root });

  const runId = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({ id: runId, business_id: biz.id })
    .execute();

  const result = await runTraversal(db, {
    runId,
    businessId: biz.id,
    rootEntityId: root,
    budget: budget({ maxDepth: 1 }),
  });

  assert.equal(result.depth, 1);

  const run = await db
    .selectFrom("osint_discovery_runs")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  assert.equal(run.depth, 1);
  assert.equal(run.max_depth, 1);
  assert.equal(run.root_entity_id, root);
  const stats = run.stats;
  assert.equal(stats.visited_entities, 2);
  assert.ok(stats.budget_hits.includes("max_depth"));
});

test("traversal never queries outside the local graph", async () => {
  // Санити: в модуле traversal нет fetch/http — обход читает только БД.
  const traversalModule = await import(
    "../src/server/intelligence/osint/traversal.ts"
  );
  assert.ok(Object.keys(traversalModule).includes("buildTraversalPlan"));
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(
      new URL("../src/server/intelligence/osint/traversal.ts", import.meta.url),
      "utf8",
    ),
  );
  assert.ok(!/\bfetch\s*\(/.test(source), "нет прямых fetch-вызовов");
  assert.ok(!/https?:\/\/(?!example\.org)/.test(source), "нет URL для запросов");
});
