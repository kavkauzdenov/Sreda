/**
 * OSINT tenant isolation (§5) — глобальный evidence общий, тенант-состояние
 * раздельное, и ни одна публичная таблица не ссыльается на тенантские.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect, sql } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

/** Публичный слой: ни одной тенантской колонки. */
const PUBLIC_TABLES = [
  "osint_entities",
  "osint_sources",
  "osint_observations",
  "osint_entity_sources",
  "osint_source_context",
  "osint_source_history",
  "osint_entity_mentions",
  "osint_entity_relations",
  "osint_entity_attributes",
];

/** Тенант-скоуп: колонка business_id ожидаема и не нарушает §5. */
const TENANT_TABLES = [
  "osint_discovery_runs",
  "osint_source_candidates",
  "osint_business_entities",
  "osint_facts",
  "osint_competitor_candidates",
  "osint_findings",
  "osint_finding_evidence",
  "osint_crawl_queue",
  "osint_intelligence_facts",
  "osint_fact_changes",
  "osint_intelligence_contradictions",
  "osint_enrichment_runs",
  "osint_research_passports",
  "osint_research_passport_revisions",
  "osint_research_launches",
];

const TENANT_REFS = [
  "'business'",
  "'\"user\"'",
  "'osint_discovery_runs'",
  "'osint_source_candidates'",
  "'osint_facts'",
  "'osint_competitor_candidates'",
  "'osint_findings'",
  "'osint_finding_evidence'",
  "'osint_crawl_queue'",
  "'osint_intelligence_facts'",
  "'osint_fact_changes'",
  "'osint_intelligence_contradictions'",
  "'osint_enrichment_runs'",
  "'osint_research_passports'",
  "'osint_research_passport_revisions'",
  "'osint_research_launches'",
].join(",");

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

async function makeBusiness(ownerId, name) {
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

async function seedPublicEntity() {
  const id = randomUUID();
  await db
    .insertInto("osint_entities")
    .values({
      id,
      display_name: "Публичная сущность",
      normalized_name: "публичная сущность",
      identity_key: `domain:public-${id.slice(0, 8)}.example.org`,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}

test("public tables carry no tenant columns", async () => {
  const rows = await sql`
    select table_name, column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (${sql.join(PUBLIC_TABLES)})
      and column_name in ('business_id','candidate_business_id','decided_by_user_id','user_id')
    order by 1, 2
  `.execute(db);
  assert.deepEqual(
    rows.rows,
    [],
    `найдены тенантские колонки в публичном слое: ${JSON.stringify(rows.rows)}`,
  );
});

test("public tables have no foreign keys to tenant tables", async () => {
  const rows = await sql`
    select c.conrelid::regclass::text as tbl,
           c.confrelid::regclass::text as ref,
           c.conname
    from pg_constraint c
    where c.contype = 'f'
      and c.conrelid::regclass::text in (${sql.join(PUBLIC_TABLES)})
      and c.confrelid::regclass::text in (${sql.raw(TENANT_REFS)})
    order by 1
  `.execute(db);
  assert.deepEqual(
    rows.rows,
    [],
    `утечка FK из публичного слоя в тенантский: ${JSON.stringify(rows.rows)}`,
  );
});

test("tenant tables keep their tenant column and no others leak", async () => {
  const rows = await sql`
    select table_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in (${sql.join(TENANT_TABLES)})
      and column_name = 'business_id'
    order by 1
  `.execute(db);
  assert.deepEqual(
    rows.rows.map((row) => row.table_name).sort(),
    [...TENANT_TABLES].sort(),
    "каждая тенантская таблица обязана иметь business_id",
  );
});

test("tenant state never crosses tenants", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "A");
  const bizB = await makeBusiness(uid, "B");
  const entityId = await seedPublicEntity();

  const sourceId = randomUUID();
  const url = `https://iso-${sourceId.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id: sourceId,
      type: "website",
      provider: "mock",
      url,
      normalized_url: url,
      name: "iso",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: entityId,
      source_id: sourceId,
      confidence: "1",
      created_at: new Date(),
    })
    .execute();

  const observationId = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: observationId,
      source_id: sourceId,
      entity_id: entityId,
      content: "общий контент",
      content_hash: randomUUID(),
      created_at: new Date(),
    })
    .execute();

  // Тенант-скоуп: runs, candidates, facts, findings + таблицы 072/073.
  for (const biz of [bizA, bizB]) {
    const runId = randomUUID();
    await db
      .insertInto("osint_discovery_runs")
      .values({ id: runId, business_id: biz.id })
      .execute();
    const crawlUrl = `https://crawl-${biz.name.toLowerCase()}.example.org/`;
    await db
      .insertInto("osint_crawl_queue")
      .values({
        id: randomUUID(),
        run_id: runId,
        business_id: biz.id,
        url: crawlUrl,
        normalized_url: crawlUrl,
      })
      .execute();
    await db
      .insertInto("osint_source_candidates")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        url,
        normalized_url: `${url}#${biz.name}`,
        confidence: "0.5",
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
    await db
      .insertInto("osint_facts")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        subject: `subject-${biz.name}`,
        predicate: "phone",
        object: "73852551010",
        source_observation_id: observationId,
        created_at: new Date(),
      })
      .execute();
    await db
      .insertInto("osint_findings")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        type: "REPUTATION",
        title: `finding-${biz.name}`,
        dedupe_key: `finding-${biz.name}`,
        created_at: new Date(),
        updated_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute();
    await db
      .insertInto("osint_intelligence_facts")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        entity_id: entityId,
        fact_type: "phone",
        fact_key: `799900000${biz.name}`,
        value: `799900000${biz.name}`,
        raw_value: `8 (999) 000-00-0${biz.name}`,
        source_id: sourceId,
        observation_id: observationId,
        status: "ACTIVE",
        fingerprint: `fp-${biz.name}`,
      })
      .execute();
    await db
      .insertInto("osint_fact_changes")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        entity_id: entityId,
        fact_type: "phone",
        fact_key: `799900000${biz.name}`,
        change_kind: "FIRST_SEEN",
        new_value: `799900000${biz.name}`,
        source_id: sourceId,
        observation_id: observationId,
        fingerprint: `chg-${biz.name}`,
      })
      .execute();
    await db
      .insertInto("osint_intelligence_contradictions")
      .values({
        id: randomUUID(),
        business_id: biz.id,
        fact_type: "phone",
        value_count: 1,
        source_count: 1,
      })
      .execute();
    await db
      .insertInto("osint_enrichment_runs")
      .values({ id: randomUUID(), business_id: biz.id, status: "queued" })
      .execute();
  }

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
  assert.equal(runsA.length, 1);
  assert.equal(runsB.length, 1);
  assert.notEqual(runsA[0].id, runsB[0].id);

  const factsA = await db
    .selectFrom("osint_facts")
    .selectAll()
    .where("business_id", "=", bizA.id)
    .execute();
  assert.equal(factsA.length, 1);
  assert.equal(factsA[0].subject, "subject-A");

  const findingsForB = await db
    .selectFrom("osint_findings")
    .selectAll()
    .where("business_id", "=", bizB.id)
    .execute();
  assert.equal(findingsForB.length, 1);
  assert.equal(findingsForB[0].title, "finding-B");

  // Таблицы 072/073: каждый тенант видит ровно свои строки.
  const separation = [
    ["osint_crawl_queue", "id"],
    ["osint_intelligence_facts", "id"],
    ["osint_fact_changes", "id"],
    ["osint_intelligence_contradictions", "id"],
    ["osint_enrichment_runs", "id"],
  ];
  for (const [table, key] of separation) {
    const rowsA = await db
      .selectFrom(table)
      .select(key)
      .where("business_id", "=", bizA.id)
      .execute();
    const rowsB = await db
      .selectFrom(table)
      .select(key)
      .where("business_id", "=", bizB.id)
      .execute();
    assert.equal(rowsA.length, 1, `${table}: строка тенанта A`);
    assert.equal(rowsB.length, 1, `${table}: строка тенанта B`);
    assert.notEqual(rowsA[0][key], rowsB[0][key], `${table}: строки разные`);
  }

  // Публичный слой общий — оба тенанта видят одни и те же строки.
  await db
    .insertInto("osint_business_entities")
    .values([
      {
        business_id: bizA.id,
        entity_id: entityId,
        relationship: "ABOUT",
        confidence: "1",
        status: "linked",
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        business_id: bizB.id,
        entity_id: entityId,
        relationship: "ABOUT",
        confidence: "1",
        status: "linked",
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])
    .execute();

  const shared = await db
    .selectFrom("osint_business_entities")
    .select("business_id")
    .where("entity_id", "=", entityId)
    .execute();
  assert.equal(shared.length, 2, "оба тенанта ссылаются на одну публичную строку");

  const globalSource = await db
    .selectFrom("osint_sources")
    .selectAll()
    .where("id", "=", sourceId)
    .executeTakeFirstOrThrow();
  assert.equal(globalSource.business_id, undefined);

  // Приватные поля CRM/лидов недоступны через публичный слой.
  const columns = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('osint_entities','osint_sources','osint_observations')
      and column_name in ('client','lead','note','password','billing','telegram_user_id')
  `.execute(db);
  assert.deepEqual(columns.rows, [], "приватные поля в OSINT-слое не хранятся");
});

test("run status of another tenant is not found", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "Status A");
  const bizB = await makeBusiness(uid, "Status B");
  const runA = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({ id: runA, business_id: bizA.id })
    .execute();

  const service = new OsintService(db);
  // Участник B читает через свой бизнес — run тенанта A не виден.
  await assert.rejects(
    () => service.getRunStatus(uid, bizB.public_id, runA),
    (error) =>
      error.code === "DISCOVERY_RUN_NOT_FOUND" && error.status === 404,
    "кросс-tenant run не читается даже при членстве в другом бизнесе",
  );

  const own = await service.getRunStatus(uid, bizA.public_id, runA);
  assert.equal(own.runId, runA, "владелец видит свой run");
});
