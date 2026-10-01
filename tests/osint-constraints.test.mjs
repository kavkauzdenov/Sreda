/**
 * DB-ограничения OSINT: раньше ни одно ограничение схемы 069/070 не
 * проверялось на отклонение — только app-уровневые guard'ы. Здесь именно
 * поведение PostgreSQL: уникальность, CHECK, FK.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";

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
      name: "Constraint User",
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
      name: "Constraints",
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

function sourceRow(normalizedUrl) {
  const id = randomUUID();
  return {
    id,
    type: "website",
    provider: "mock",
    url: normalizedUrl,
    normalized_url: normalizedUrl,
    name: normalizedUrl,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

async function seedSource(normalizedUrl) {
  const row = sourceRow(normalizedUrl);
  await db.insertInto("osint_sources").values(row).execute();
  return row.id;
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

async function seedEntity(identityKey, displayName) {
  const id = randomUUID();
  await db
    .insertInto("osint_entities")
    .values({
      id,
      kind: "business",
      display_name: displayName,
      normalized_name: displayName.toLowerCase(),
      identity_key: identityKey,
      created_at: new Date(),
      updated_at: new Date(),
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })
    .execute();
  return id;
}

test("osint_sources rejects a second row with the same normalized_url", async () => {
  await seedSource("https://unique-source.example/");
  await assert.rejects(() =>
    db.insertInto("osint_sources").values(sourceRow("https://unique-source.example/")).execute(),
  );
});

test("osint_entities rejects a duplicate non-null identity_key", async () => {
  await seedEntity("domain:dup.example", "Первый");
  await assert.rejects(() =>
    db
      .insertInto("osint_entities")
      .values({
        id: randomUUID(),
        kind: "business",
        display_name: "Второй",
        normalized_name: "второй",
        identity_key: "domain:dup.example",
        created_at: new Date(),
        updated_at: new Date(),
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      })
      .execute(),
  );
});

test("osint_observations rejects a duplicate (source_id, content_hash)", async () => {
  const sourceId = await seedSource("https://hash-source.example/");
  const hash = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: randomUUID(),
      source_id: sourceId,
      entity_id: null,
      content: "одинаковый контент",
      content_hash: hash,
      created_at: new Date(),
    })
    .execute();
  await assert.rejects(() =>
    db
      .insertInto("osint_observations")
      .values({
        id: randomUUID(),
        source_id: sourceId,
        entity_id: null,
        content: "одинаковый контент",
        content_hash: hash,
        created_at: new Date(),
      })
      .execute(),
  );
});

test("osint_observations rejects an unknown source_id (FK)", async () => {
  await assert.rejects(() =>
    db
      .insertInto("osint_observations")
      .values({
        id: randomUUID(),
        source_id: randomUUID(),
        entity_id: null,
        content: "битый FK",
        content_hash: randomUUID(),
        created_at: new Date(),
      })
      .execute(),
  );
});

test("osint_entity_relations rejects self relations (CHECK)", async () => {
  const target = await seedEntity("domain:self.example", "Самосвязь");
  const observationId = await seedObservation(await seedSource("https://self.example/"), target);
  await assert.rejects(() =>
    db
      .insertInto("osint_entity_relations")
      .values({
        id: randomUUID(),
        from_entity_id: target,
        to_entity_id: target,
        relation_type: "RELATED_TO",
        confidence: "1",
        source_observation_id: observationId,
        evidence: {},
        valid_from: new Date(),
        valid_to: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute(),
  );
});

test("osint_entity_relations rejects a duplicate provenance row (UNIQUE)", async () => {
  const a = await seedEntity("domain:dedupe-a.example", "Дедуп А");
  const b = await seedEntity("domain:dedupe-b.example", "Дедуп Б");
  const observationId = await seedObservation(await seedSource("https://dedupe.example/"), a);
  const values = {
    id: randomUUID(),
    from_entity_id: a,
    to_entity_id: b,
    relation_type: "PARTNER",
    confidence: "1",
    source_observation_id: observationId,
    evidence: {},
    valid_from: new Date(),
    valid_to: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
  await db.insertInto("osint_entity_relations").values(values).execute();
  await assert.rejects(() =>
    db
      .insertInto("osint_entity_relations")
      .values({ ...values, id: randomUUID() })
      .execute(),
  );
});

test("osint_entity_mentions rejects the same span twice (UNIQUE)", async () => {
  const target = await seedEntity("domain:mention.example", "Упоминание");
  const observationId = await seedObservation(
    await seedSource("https://mention.example/"),
    target,
  );
  const values = {
    id: randomUUID(),
    observation_id: observationId,
    entity_id: target,
    mention_type: "MENTIONS",
    text_span: "один и тот же фрагмент",
    context: "",
    confidence: "1",
    created_at: new Date(),
  };
  await db.insertInto("osint_entity_mentions").values(values).execute();
  await assert.rejects(() =>
    db
      .insertInto("osint_entity_mentions")
      .values({ ...values, id: randomUUID() })
      .execute(),
  );
});

test("osint_facts rejects the same claim from the same observation twice", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const observationId = await seedObservation(
    await seedSource("https://facts.example/"),
    null,
    "утверждение",
  );
  const values = {
    id: randomUUID(),
    business_id: biz.id,
    subject: "Кафе Ромашка",
    predicate: "phone",
    object: null,
    value: null,
    value_kind: null,
    source_observation_id: observationId,
    confidence: "1",
    valid_from: null,
    valid_to: null,
    created_at: new Date(),
  };
  await db.insertInto("osint_facts").values(values).execute();
  await assert.rejects(() =>
    db.insertInto("osint_facts").values({ ...values, id: randomUUID() }).execute(),
  );
});

test("tenant rows survive deletion of an unrelated global source", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const sourceId = await seedSource("https://tenant-boundary.example/");
  const entityId = await seedEntity("domain:tenant-boundary.example", "Граница");
  await db
    .insertInto("osint_business_entities")
    .values({
      business_id: biz.id,
      entity_id: entityId,
      relationship: "OWNER",
      confidence: "1",
      status: "linked",
      evidence: [],
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  const observationId = await seedObservation(sourceId, entityId, "тенантский факт");
  await db
    .insertInto("osint_facts")
    .values({
      id: randomUUID(),
      business_id: biz.id,
      subject: "Граница",
      predicate: "phone",
      source_observation_id: observationId,
      created_at: new Date(),
    })
    .execute();

  // Граница «тенант <- глобал» (миграция 071): глобальное наблюдение,
  // на которое ссылается тенантский факт, удалить нельзя.
  await assert.rejects(() =>
    db.deleteFrom("osint_observations").where("id", "=", observationId).execute(),
  );

  const fact = await db
    .selectFrom("osint_facts")
    .select("id")
    .where("business_id", "=", biz.id)
    .executeTakeFirstOrThrow();
  assert.ok(fact, "tenant fact still exists");

  // Наблюдение, на которое никто не ссылается, удаляется (глобальный слой).
  const orphan = await seedObservation(sourceId, entityId, "ненаблюдаемое");
  await db.deleteFrom("osint_observations").where("id", "=", orphan).execute();
});

test("deleting competitor business B does not delete tenant A's row", async () => {
  const ownerA = await makeUser();
  const ownerB = await makeUser();
  const bizA = await makeBusiness(ownerA, "A");
  const bizB = await makeBusiness(ownerB, "B");

  const candidateId = randomUUID();
  await db
    .insertInto("osint_competitor_candidates")
    .values({
      id: candidateId,
      business_id: bizA.id,
      candidate_business_id: bizB.id,
      name: "Конкурент Б",
      match_score: "0.8",
    })
    .execute();

  // business_member держит RESTRICT — приложение снимает участников само.
  await db.deleteFrom("business_member").where("business_id", "=", bizB.id).execute();
  await db.deleteFrom("business").where("id", "=", bizB.id).execute();

  const row = await db
    .selectFrom("osint_competitor_candidates")
    .selectAll()
    .where("id", "=", candidateId)
    .executeTakeFirst();
  assert.ok(row, "tenant A keeps its competitor candidate row");
  assert.equal(row.candidate_business_id, null, "stale reference cleared, not cascaded");
  assert.equal(row.business_id, bizA.id, "ownership untouched");

  // Обратная операция: удаление владельца строки убирает его собственные данные.
  await db.deleteFrom("business_member").where("business_id", "=", bizA.id).execute();
  await db.deleteFrom("business").where("id", "=", bizA.id).execute();
  const gone = await db
    .selectFrom("osint_competitor_candidates")
    .select("id")
    .where("id", "=", candidateId)
    .executeTakeFirst();
  assert.equal(gone, undefined, "owner's own row is removed with its business");
});
