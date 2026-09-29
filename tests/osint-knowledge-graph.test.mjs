/**
 * OSINT knowledge graph — глобальные entity/source/observation, тенантский
 * bridge, source memory + history, mentions, relations, temporal attributes.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  ensureBusinessEntity,
  ensureGlobalEntity,
  linkBusinessEntity,
  strongSignalsMatch,
} from "../src/server/intelligence/osint/entity-graph.ts";
import {
  readSourceHistory,
  upsertSourceContext,
} from "../src/server/intelligence/osint/source-context.ts";
import {
  MentionEvidenceError,
  recordMention,
  readMentions,
} from "../src/server/intelligence/osint/mentions.ts";
import {
  closeRelation,
  readRelations,
  upsertRelation,
} from "../src/server/intelligence/osint/relations.ts";
import {
  readAttributeHistory,
  readAttributes,
  setAttribute,
} from "../src/server/intelligence/osint/attributes.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";

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

async function seedSource(normalizedUrl) {
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

async function seedObservation(sourceId, entityId, content) {
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

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description: "Кафе Ромашка, Барнаул\nСайт: https://romashka.ru",
  industry: "food",
});

test("global entity is shared by tenants while bridges stay separate", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "A");
  const bizB = await makeBusiness(uid, "B");

  const entityA = await ensureBusinessEntity(db, {
    businessId: bizA.id,
    profile: PROFILE,
  });
  const entityB = await ensureBusinessEntity(db, {
    businessId: bizB.id,
    profile: PROFILE,
  });

  assert.equal(entityA, entityB, "same identity_key → one global entity");

  const entityRow = await db
    .selectFrom("osint_entities")
    .selectAll()
    .where("id", "=", entityA)
    .executeTakeFirstOrThrow();
  assert.equal(entityRow.identity_key, "domain:romashka.ru");
  assert.ok(!("business_id" in entityRow), "public entity carries no tenant");

  const bridges = await db
    .selectFrom("osint_business_entities")
    .selectAll()
    .where("entity_id", "=", entityA)
    .execute();
  assert.equal(bridges.length, 2, "two tenants, two bridges");
  assert.deepEqual(
    bridges.map((row) => row.business_id).sort(),
    [bizA.id, bizB.id].sort(),
  );
  assert.ok(bridges.every((row) => row.status === "linked"));

  // Повторный resolve не плодит мосты и не понижает confidence.
  await linkBusinessEntity(db, {
    businessId: bizA.id,
    entityId: entityA,
    relationship: "OWNER",
    confidence: 0.2,
  });
  const after = await db
    .selectFrom("osint_business_entities")
    .selectAll()
    .where("entity_id", "=", entityA)
    .execute();
  assert.equal(after.length, 2, "no bridge duplicates");
});

test("name alone never dedupes globally — only identity_key does", async () => {
  const withKey = await ensureGlobalEntity(db, {
    identityKey: "domain:example-a.ru",
    displayName: "Единое Название",
    normalizedName: "единое название",
  });
  const withoutKey = await ensureGlobalEntity(db, {
    identityKey: null,
    displayName: "Единое Название",
    normalizedName: "единое название",
  });
  assert.notEqual(withKey, withoutKey, "§12: одно имя — не основание для мержа");

  const same = await ensureGlobalEntity(db, {
    identityKey: "domain:example-a.ru",
    displayName: "Совсем другое",
    normalizedName: "совсем другое",
  });
  assert.equal(same, withKey, "identity_key dedupes regardless of name");
});

test("source context overwrite records history and keeps old value", async () => {
  const sourceId = await seedSource("https://memory.example.org/");

  const first = await upsertSourceContext(db, {
    sourceId,
    patch: {
      canonical_name: "Старое имя",
      category: "cafe",
      city: "Барнаул",
      domains: ["memory.example.org"],
    },
    changeKind: "create",
  });
  assert.equal(first.created, true);
  assert.ok(first.changedFields.includes("canonical_name"));

  const second = await upsertSourceContext(db, {
    sourceId,
    patch: { canonical_name: "Новое имя", city: "Новосибирск" },
    changeKind: "auto_collect",
  });
  assert.equal(second.created, false);
  assert.deepEqual(second.changedFields.sort(), ["canonical_name", "city"]);

  const context = await db
    .selectFrom("osint_source_context")
    .selectAll()
    .where("source_id", "=", sourceId)
    .executeTakeFirstOrThrow();
  assert.equal(context.canonical_name, "Новое имя");
  assert.equal(context.city, "Новосибирск");
  assert.equal(context.category, "cafe", "незатронутое поле сохранено");

  const history = await readSourceHistory(db, sourceId);
  assert.equal(history.length, 2, "create + update");
  assert.equal(history[0].change_kind, "auto_collect");
  assert.equal(history[0].valid_to, null, "новый интервал открыт");
  const snapshot = history[0].snapshot;
  assert.equal(snapshot.canonical_name.to, "Новое имя");
  assert.ok(history[1].valid_to, "старый интервал закрыт, а не удалён");

  // Повтор того же значения не плодит историю.
  const third = await upsertSourceContext(db, {
    sourceId,
    patch: { canonical_name: "Новое имя" },
  });
  assert.deepEqual(third.changedFields, []);
  assert.equal((await readSourceHistory(db, sourceId)).length, 2);
});

test("mention keeps text_span evidence; ownership requires explicit evidence", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const entityId = await ensureBusinessEntity(db, { businessId: biz.id, profile: PROFILE });
  const sourceId = await seedSource("https://evidence.example.org/");
  const observationId = await seedObservation(
    sourceId,
    entityId,
    "Кафе Ромашка — лучший кофе в Барнауле",
  );

  const mention = await recordMention(db, {
    observationId,
    entityId,
    mentionType: "MENTIONS",
    textSpan: "Кафе Ромашка — лучший кофе в Барнауле",
    confidence: 0.9,
  });
  assert.equal(mention.created, true);

  const dup = await recordMention(db, {
    observationId,
    entityId,
    mentionType: "MENTIONS",
    textSpan: "Кафе Ромашка — лучший кофе в Барнауле",
  });
  assert.equal(dup.created, false, "уникальность по (obs, entity, type, span)");
  assert.equal(dup.id, mention.id);

  const mentions = await readMentions(db, entityId);
  assert.equal(mentions.length, 1);
  assert.ok(mentions[0].text_span.length > 0, "§9: evidence обязателен");

  await assert.rejects(
    () =>
      recordMention(db, {
        observationId,
        entityId,
        mentionType: "OWNER",
        textSpan: "кто-то сказал про владельца",
        evidenceKind: "text_span",
      }),
    (error) => error instanceof MentionEvidenceError,
    "MENTIONS не превращается в OWNER без явного evidence",
  );

  const owned = await recordMention(db, {
    observationId,
    entityId,
    mentionType: "OWNER",
    textSpan: "sameAs: https://vk.com/romashka_club",
    evidenceKind: "sameAs",
    confidence: 1,
  });
  assert.equal(owned.created, true, "явный sameAs достаточен для OWNER");
});

test("relations require observation evidence and reject self loops", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const cafe = await ensureBusinessEntity(db, { businessId: biz.id, profile: PROFILE });
  const supplier = await ensureGlobalEntity(db, {
    identityKey: "domain:supplier.example.org",
    displayName: "Поставщик Кофе",
    normalizedName: "поставщик кофе",
  });
  const sourceId = await seedSource("https://news.example.org/post");
  const observationId = await seedObservation(sourceId, cafe, "Поставщик Кофе поставляет");

  await assert.rejects(
    () =>
      upsertRelation(db, {
        fromEntityId: cafe,
        toEntityId: supplier,
        relationType: "SUPPLIER",
        sourceObservationId: "",
      }),
    (error) => error.code === "relation_requires_observation",
  );

  await assert.rejects(
    () =>
      upsertRelation(db, {
        fromEntityId: cafe,
        toEntityId: cafe,
        relationType: "RELATED_TO",
        sourceObservationId: observationId,
      }),
    (error) => error.code === "relation_requires_observation",
    "самосвязи запрещены",
  );

  const created = await upsertRelation(db, {
    fromEntityId: supplier,
    toEntityId: cafe,
    relationType: "SUPPLIER",
    sourceObservationId: observationId,
    confidence: 0.7,
    evidence: { text: "Поставщик Кофе поставляет" },
    validFrom: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(created.created, true);

  const again = await upsertRelation(db, {
    fromEntityId: supplier,
    toEntityId: cafe,
    relationType: "SUPPLIER",
    sourceObservationId: observationId,
    confidence: 0.95,
  });
  assert.equal(again.created, false);
  assert.equal(again.confidence, 0.95, "confidence накапливается, не теряется");
  assert.equal(again.id, created.id);

  const open = await readRelations(db, cafe);
  assert.equal(open.length, 1);
  assert.equal(open[0].relation_type, "SUPPLIER");

  await closeRelation(db, created.id, new Date("2026-05-01T00:00:00Z"));
  assert.equal((await readRelations(db, cafe)).length, 0, "закрытая связь не видна");
  const asOfMarch = await readRelations(db, cafe, {
    asOf: new Date("2026-03-01T00:00:00Z"),
  });
  assert.equal(asOfMarch.length, 1, "историческая выборка видит закрытую связь");
});

test("temporal attributes keep one open value and answer as-of queries", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const entityId = await ensureBusinessEntity(db, { businessId: biz.id, profile: PROFILE });
  const sourceId = await seedSource("https://archive.example.org/");
  const obs1 = await seedObservation(sourceId, entityId, "old phone");

  const june = new Date("2026-06-15T00:00:00Z");
  const august = new Date("2026-08-16T00:00:00Z");

  const first = await setAttribute(db, {
    entityId,
    attribute: "phone",
    value: "73852551010",
    confidence: 0.9,
    sourceObservationId: obs1,
    validFrom: june,
  });
  assert.equal(first.changed, true);
  assert.equal(first.closedPreviousId, null);

  const same = await setAttribute(db, {
    entityId,
    attribute: "phone",
    value: "73852551010",
    confidence: 0.5,
    validFrom: new Date("2026-07-01T00:00:00Z"),
  });
  assert.equal(same.changed, false, "то же значение не создаёт новую строку");

  const second = await setAttribute(db, {
    entityId,
    attribute: "phone",
    value: "73852559999",
    confidence: 1,
    validFrom: august,
  });
  assert.equal(second.changed, true);
  assert.equal(second.closedPreviousId, first.id, "старое значение закрыто");

  const open = await readAttributes(db, entityId);
  assert.equal(open.length, 1, "§18: ровно одно открытое значение");
  assert.deepEqual(open[0].value, "73852559999");

  const asOfJune = await readAttributes(db, entityId, { asOf: june });
  assert.equal(asOfJune.length, 1);
  assert.deepEqual(asOfJune[0].value, "73852551010", "на июнь — старый номер");

  const history = await readAttributeHistory(db, entityId, "phone");
  assert.equal(history.length, 2);
  assert.equal(history[0].valid_from.getTime(), august.getTime());
  assert.ok(history[0].valid_to === null);

  // Другой атрибут живёт независимо.
  await setAttribute(db, {
    entityId,
    attribute: "city",
    value: "Барнаул",
    validFrom: june,
  });
  assert.equal((await readAttributes(db, entityId)).length, 2);
});

test("cross-source linking matches on strong signals, not on name", () => {
  const strong = strongSignalsMatch(
    { phone: "73852551010", domain: "romashka.ru" },
    { phone: "73852551010", domain: "other.example.org" },
  );
  assert.equal(strong.matched, true);
  assert.deepEqual(strong.reasons, ["phone_exact"]);

  const weak = strongSignalsMatch(
    { phone: null, domain: null, address: "ул. Ленина, 10" },
    { phone: null, domain: null, address: "ул. Ленина, 11" },
  );
  assert.equal(weak.matched, false, "разные дома — не одно место");

  const byNameOnly = strongSignalsMatch(
    { phone: null, domain: null, address: null },
    { phone: null, domain: null, address: null },
  );
  assert.equal(byNameOnly.matched, false, "§12: имя вообще не участвует");
});
