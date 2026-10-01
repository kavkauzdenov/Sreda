/**
 * Stage 3 runtime v1 — вертикальный slice:
 * Stage 2 observation → Evidence → Claim → Provenance.
 *
 * Read-model поверх Stage 2: ничего не персистится, поэтому повторная
 * проекция обязана быть идентичной, а доступ — определяться тенантским
 * мостом `osint_business_entities`, а не знанием UUID наблюдения.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { ensureBusinessEntity } from "../src/server/intelligence/osint/entity-graph.ts";
import {
  assertClaimSupportedKind,
  isClaimSupportedObservationKind,
  toEvidence,
} from "../src/server/intelligence/osint/evidence.ts";
import { stableClaimId } from "../src/server/intelligence/osint/claims.ts";
import { EXTRACTABLE_ATTRIBUTES } from "../src/server/intelligence/osint/extraction/contract.ts";
import { AppError } from "../src/server/http/errors.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PROFILE_A = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description:
    "Кафе Ромашка — уютное кафе в Барнауле.\nГород: Барнаул\nСайт: https://romashka.ru",
  industry: "food",
});

const PROFILE_B = buildDiscoveryProfile({
  name: "Пекарня Светлана",
  description:
    "Пекарня Светлана — свежий хлеб в Новосибирске.\nСайт: https://svetlana.example",
  industry: "food",
});

const RICH_CONTENT =
  "Кафе Ромашка в Барнауле. Телефон: 8 (3852) 55-10-10. " +
  "Почта: info@romashka.ru. Сайт: https://romashka.ru/";

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

/** Реальная строка Stage 2: глобальный source + observation + связь с entity. */
async function seedObservation({ entityId, content, kind = "page" }) {
  const sourceId = randomUUID();
  const url = `https://obs-${sourceId.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id: sourceId,
      type: "website",
      provider: "mock",
      url,
      normalized_url: url,
      name: "Наблюдаемый источник",
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
      content,
      content_hash: randomUUID(),
      kind,
      created_at: new Date(),
    })
    .execute();

  return { observationId, sourceId, url };
}

test("Test 1: valid observation → Evidence → Claim → provenance", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile: PROFILE_A,
  });
  const { observationId, sourceId } = await seedObservation({
    entityId,
    content: RICH_CONTENT,
  });

  const slice = await new OsintService(db).explainObservation(
    uid,
    biz.public_id,
    observationId,
  );

  assert.equal(slice.reason, null);
  assert.equal(slice.businessId, biz.id);
  assert.equal(slice.observationId, observationId);

  // Evidence: провенанс сохранён, это не «строка».
  assert.equal(slice.evidence.id, observationId);
  assert.equal(slice.evidence.sourceId, sourceId);
  assert.equal(slice.evidence.content, RICH_CONTENT);
  assert.equal(slice.evidence.entityId, entityId);
  assert.ok(slice.evidence.contentHash.length > 0);
  assert.ok(Number.isFinite(Date.parse(slice.evidence.observedAt)));

  assert.equal(slice.source?.id, sourceId);
  assert.ok(slice.source?.url.startsWith("https://"));
  assert.equal(slice.entity?.id, entityId);
  assert.equal(slice.entity?.displayName, "Кафе Ромашка");

  assert.ok(slice.claims.length >= 2, `claims=${slice.claims.length}`);

  const predicates = slice.claims.map((claim) => claim.predicate);
  assert.ok(predicates.includes("phone"), predicates.join(","));
  assert.ok(
    predicates.every((p) => EXTRACTABLE_ATTRIBUTES.includes(p)),
    predicates.join(","),
  );

  for (const claim of slice.claims) {
    assert.equal(claim.businessId, biz.id);
    assert.equal(claim.subject, "Кафе Ромашка");
    assert.ok(claim.value && claim.value.length > 0);
    assert.ok(claim.evidence.length >= 1, "§6: Claim без Evidence невалиден");

    const ref = claim.evidence[0];
    assert.equal(ref.observationId, observationId);
    assert.equal(ref.evidenceKind, "text_span");
    assert.ok(ref.textSpan && ref.textSpan.length > 0);
    assert.ok(ref.confidence > 0 && ref.confidence <= 1);

    // Claim → Evidence → Observation → Source.
    assert.equal(claim.provenance.claimId, claim.id);
    assert.equal(claim.provenance.observationId, slice.evidence.id);
    assert.equal(claim.provenance.sourceId, slice.evidence.sourceId);
    assert.equal(claim.provenance.sourceId, slice.source.id);
    assert.deepEqual(claim.provenance.evidenceRef, ref);
  }
});

test("Test 2: observation without enough provenance/content yields an explainable empty result", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile: PROFILE_A,
  });
  const service = new OsintService(db);

  // (a) Провенанс собран, но извлекать нечего — это не ошибка (§12).
  const blank = await seedObservation({ entityId, content: "   " });
  const empty = await service.explainObservation(
    uid,
    biz.public_id,
    blank.observationId,
  );
  assert.deepEqual(empty.claims, []);
  assert.equal(empty.reason, "no_extractable_claims");
  assert.equal(empty.evidence.id, blank.observationId);
  assert.equal(empty.source?.id, blank.sourceId);
  assert.equal(empty.entity?.id, entityId);

  // (b) Нельзя провести цепочку до тенанта: нет entity_id и нет связи
  //     source → entity → bridge. Claim не создаётся, ответ контролируемый.
  const orphanSourceId = randomUUID();
  const orphanUrl = `https://orphan-${orphanSourceId.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id: orphanSourceId,
      type: "website",
      provider: "mock",
      url: orphanUrl,
      normalized_url: orphanUrl,
      name: "orphan",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  const orphanObservationId = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: orphanObservationId,
      source_id: orphanSourceId,
      entity_id: null,
      content: RICH_CONTENT,
      content_hash: randomUUID(),
      created_at: new Date(),
    })
    .execute();

  await assert.rejects(
    () =>
      service.explainObservation(uid, biz.public_id, orphanObservationId),
    (error) =>
      error instanceof AppError &&
      error.status === 404 &&
      error.code === "OBSERVATION_NOT_FOUND",
    "неприписанное наблюдение не даёт Claim",
  );
});

test("Test 3: cross-tenant observation is denied at the service layer", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "A");
  const bizB = await makeBusiness(uid, "B");
  const stranger = await makeUser("Stranger");

  const entityA = await ensureBusinessEntity(db, {
    businessId: bizA.id,
    profile: PROFILE_A,
  });
  const entityB = await ensureBusinessEntity(db, {
    businessId: bizB.id,
    profile: PROFILE_B,
  });
  assert.notEqual(entityA, entityB, "разные профили → разные сущности");

  const owned = await seedObservation({
    entityId: entityA,
    content: RICH_CONTENT,
  });
  const foreign = await seedObservation({
    entityId: entityB,
    content: "Пекарня Светлана. Телефон: 8 (3852) 55-22-33",
  });

  const service = new OsintService(db);

  // Свой бизнес видит своё наблюдение…
  const own = await service.explainObservation(uid, bizA.public_id, owned.observationId);
  assert.equal(own.claims.length >= 1, true);

  // …и не видит чужое, даже зная его UUID.
  await assert.rejects(
    () => service.explainObservation(uid, bizB.public_id, owned.observationId),
    (error) =>
      error instanceof AppError &&
      error.status === 404 &&
      error.code === "OBSERVATION_NOT_FOUND",
    "tenant B не получает наблюдение tenant A",
  );
  await assert.rejects(
    () => service.explainObservation(uid, bizA.public_id, foreign.observationId),
    (error) =>
      error instanceof AppError &&
      error.status === 404 &&
      error.code === "OBSERVATION_NOT_FOUND",
    "tenant A не получает наблюдение tenant B",
  );

  // Человек без членства не узнаёт о бизнесе.
  await assert.rejects(
    () => service.explainObservation(stranger, bizA.public_id, owned.observationId),
    (error) =>
      error instanceof AppError &&
      error.status === 404 &&
      error.code === "BUSINESS_NOT_FOUND",
  );

  // Чужой бизнес не «улучшает» доступ через существование другой сущности.
  const viaB = await service.explainObservation(uid, bizB.public_id, foreign.observationId);
  assert.equal(viaB.businessId, bizB.id);
  assert.equal(viaB.entity?.id, entityB);
  assert.notEqual(viaB.evidence.id, owned.observationId);
});

test("Test 4: re-processing the same observation is deterministic and duplicate-free", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile: PROFILE_A,
  });
  const { observationId } = await seedObservation({
    entityId,
    content: RICH_CONTENT,
  });

  const service = new OsintService(db);
  const first = await service.explainObservation(uid, biz.public_id, observationId);
  const second = await service.explainObservation(uid, biz.public_id, observationId);
  const third = await service.explainObservation(uid, biz.public_id, observationId);

  assert.deepEqual(second, first, "повторная проекция идентична");
  assert.deepEqual(third, first, "третья проекция идентична");

  const ids = first.claims.map((claim) => claim.id);
  assert.equal(new Set(ids).size, ids.length, "дубликатов claim нет");
  assert.deepEqual(second.claims.map((c) => c.id), ids);
  assert.deepEqual(third.claims.map((c) => c.id), ids);

  // Стабильность id: одинаковый вход — одинаковый id, другой value — другой id.
  const base = {
    businessId: biz.id,
    subject: "Кафе Ромашка",
    predicate: "phone",
    observationId,
  };
  assert.equal(
    stableClaimId({ ...base, value: "73852551010" }),
    stableClaimId({ ...base, value: "73852551010" }),
  );
  assert.notEqual(
    stableClaimId({ ...base, value: "73852551010" }),
    stableClaimId({ ...base, value: "73852559999" }),
  );
});

test("Test 5: unsupported or malformed observation gets a controlled response", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка");
  const service = new OsintService(db);

  // Все виды из CHECK 069 поддерживаются, любой иной — контролируемый отказ.
  for (const kind of ["page", "review", "search_result", "post", "listing"]) {
    assert.equal(isClaimSupportedObservationKind(kind), true, kind);
  }
  assert.equal(isClaimSupportedObservationKind("story"), false);
  assert.throws(
    () => assertClaimSupportedKind("story"),
    (error) =>
      error instanceof AppError &&
      error.status === 422 &&
      error.code === "UNSUPPORTED_OBSERVATION_KIND",
  );

  // Битые данные наблюдения не дают права на Claim (§6).
  assert.throws(
    () =>
      toEvidence({
        id: randomUUID(),
        source_id: randomUUID(),
        entity_id: null,
        content: "текст",
        content_hash: randomUUID(),
        observed_at: "не дата",
        created_at: new Date(),
        kind: "page",
      }),
    (error) =>
      error instanceof AppError &&
      error.status === 422 &&
      error.code === "MALFORMED_OBSERVATION",
  );

  // Малформенный и несуществующий id — 404, а не 503.
  for (const badId of ["not-a-uuid", randomUUID()]) {
    await assert.rejects(
      () => service.explainObservation(uid, biz.public_id, badId),
      (error) =>
        error instanceof AppError &&
        error.status === 404 &&
        error.code === "OBSERVATION_NOT_FOUND",
      `id=${badId}`,
    );
  }
});
