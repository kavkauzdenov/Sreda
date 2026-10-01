/**
 * Observation writer — закрытие Stage 3 gap (§23.3).
 *
 * Проверяем, что существующий Stage 2 discovery-pipeline теперь реально
 * наполняет `osint_observations`, а не только кандидаты/источники/связи:
 *   input → source/entity → observation → Stage 3 explainObservation
 *          → Evidence → Claim → Provenance
 *
 * Ни одной синтетической строки в production здесь нет — наблюдения создаёт
 * сам discovery, включая боевой провайдер `own_urls`.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { runDiscovery } from "../src/server/intelligence/osint/discovery.ts";
import {
  linkEntitySource,
} from "../src/server/intelligence/osint/candidates.ts";
import {
  ensureObservation,
  observationContent,
  observationContentHash,
} from "../src/server/intelligence/osint/observations.ts";
import {
  createOwnUrlsProvider,
  OWN_URLS_PROVIDER_ID,
} from "../src/server/intelligence/osint/providers/own-urls.ts";
import { createRegistry } from "../src/server/intelligence/osint/providers/registry.ts";
import { createMockProvider } from "../src/server/intelligence/osint/providers/mock.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { ensureBusinessEntity } from "../src/server/intelligence/osint/entity-graph.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

/** Ровно тот реестр, что собирает OsintService.registry() в production. */
function productionRegistry() {
  return createRegistry([createOwnUrlsProvider()]);
}

function profileFor(name, domain) {
  return buildDiscoveryProfile({
    name,
    description:
      `${name} — уютное кафе в Барнауле.\nГород: Барнаул\n` +
      `Телефон: 8 (3852) 55-10-10\nСайт: https://${domain}`,
    industry: "food",
  });
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

async function makeBusiness(ownerId, name, description = "") {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      description,
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: row.id,
      user_id: ownerId,
      role: "owner",
      status: "active",
    })
    .execute();
  return row;
}

async function seedSource(url) {
  const id = randomUUID();
  await db
    .insertInto("osint_sources")
    .values({
      id,
      type: "website",
      provider: "mock",
      url,
      normalized_url: url,
      name: "seeded source",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}

const observationsOf = (entityId) =>
  db
    .selectFrom("osint_observations")
    .selectAll()
    .where("entity_id", "=", entityId)
    .execute();

const material = (url, title, snippet = null) => ({
  url,
  title,
  snippet,
  provider: "mock_search",
  method: "search",
});

test("Test 1: real Stage 2 flow writes an observation into the database", async () => {
  const domain = "gap-closure.ru";
  const profile = profileFor("Кафе Ромашка", domain);
  const uid = await makeUser();
  const biz = await makeBusiness(uid, profile.businessName);
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile,
  });

  const result = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    // Буквально тот же реестр, что уходит в production.
    registry: productionRegistry(),
    profile,
  });

  assert.equal(result.status, "completed", result.errors.join(" | "));
  assert.equal(result.acceptedCount >= 1, true, "свой сайт принимается");
  assert.equal(
    (await db
      .selectFrom("osint_source_candidates")
      .select("id")
      .where("business_id", "=", biz.id)
      .execute()).length >= 1,
    true,
    "Stage 2 создал кандидатов",
  );

  const rows = await observationsOf(entityId);
  assert.equal(rows.length >= 1, true, "наблюдение записано в osint_observations");

  const row = rows[0];
  // Observation contract: только валидные строки.
  assert.equal(typeof row.id, "string");
  assert.equal(row.source_id !== null && row.source_id !== undefined, true);
  assert.equal(row.entity_id, entityId);
  assert.equal(row.url, `https://${domain}/`);
  assert.equal(row.title, profile.businessName);
  assert.equal(row.kind, "search_result");
  assert.equal(row.content.includes(`https://${domain}/`), true);
  assert.equal(
    row.content_hash,
    createHash("sha256").update(row.content, "utf8").digest("hex"),
    "content_hash детерминирован от content",
  );
  assert.equal(row.content_hash.length >= 1 && row.content_hash.length <= 128, true);
  assert.equal(row.observed_at instanceof Date, true);

  const metadata =
    typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
  assert.equal(metadata.provider, OWN_URLS_PROVIDER_ID);
  assert.equal(metadata.discovery_method, "search");
  // Глобальная строка не должна светить тенантский provenance (правило 070).
  assert.equal("discovery_run_id" in metadata, false);
  assert.equal("business_id" in metadata, false);

  // Помощники контракта.
  const observed = material(`https://${domain}/`, profile.businessName);
  assert.equal(observationContent(observed), `${profile.businessName}\nhttps://${domain}/`);
  assert.equal(
    observationContentHash(observationContent(observed)),
    row.content_hash,
    "content + hash — чистые функции, одинаковый вход → одинаковый хэш",
  );

  // Честная граница writer'а (§23.3): наблюдение требует источник, а
  // источник Stage 2 создаёт ТОЛЬКО для auto-accept кандидата. Профиль со
  // строкой адреса не доходит до порога domain_exact (0.381 < 0.40) —
  // кандидат уходит в ручную очередь, source не создаётся, наблюдения нет.
  const fullProfile = buildDiscoveryProfile({
    name: "Кафе Полный Профиль",
    description:
      "Кафе Полный Профиль в Барнауле.\nГород: Барнаул\nул. Ленина, 10\n" +
      "Телефон: 8 (3852) 55-10-10\nСайт: https://full-profile.ru",
    industry: "food",
  });
  assert.equal(fullProfile.address !== null, true, "адрес действительно распознан");
  const fullBiz = await makeBusiness(uid, fullProfile.businessName);
  const fullEntity = await ensureBusinessEntity(db, {
    businessId: fullBiz.id,
    profile: fullProfile,
  });
  const reviewRun = await runDiscovery(db, {
    businessId: fullBiz.id,
    userId: uid,
    registry: productionRegistry(),
    profile: fullProfile,
  });
  assert.equal(reviewRun.reviewCount >= 1, true, "кандидат в ручной очереди");
  assert.equal(reviewRun.acceptedCount, 0, "auto-accept не достигнут");
  assert.equal(
    (await observationsOf(fullEntity)).length,
    0,
    "без источника наблюдение схема и не позволяет (source_id NOT NULL)",
  );
});

test("Test 2: re-processing the same input does not create uncontrolled duplicates", async () => {
  const domain = "idempotent.ru";
  const profile = profileFor("Пекарня Идемпотент", domain);
  const uid = await makeUser();
  const biz = await makeBusiness(uid, profile.businessName);
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile,
  });

  // 1) discovery дважды → счётчик наблюдений не растёт.
  await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: productionRegistry(),
    profile,
  });
  const afterFirst = (await observationsOf(entityId)).length;
  assert.equal(afterFirst >= 1, true);

  await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: productionRegistry(),
    profile,
  });
  const afterSecond = (await observationsOf(entityId)).length;
  assert.equal(afterSecond, afterFirst, "повторный run не плодит наблюдения");

  // 2) прямой повторный вызов writer'а → тот же id, created=false.
  const sourceId = await seedSource(`https://idem-check.ru/`);
  await linkEntitySource(db, { entityId, sourceId, confidence: 1 });
  const observed = material(
    `https://idem-check.ru/`,
    "Пекарня Идемпотент",
    "хлеб, выпечка",
  );

  const first = await ensureObservation(db, {
    businessId: biz.id,
    entityId,
    sourceId,
    observed,
  });
  assert.equal(first.created, true, first.skipped ?? "");
  assert.equal(first.id !== null, true);

  const repeat = await ensureObservation(db, {
    businessId: biz.id,
    entityId,
    sourceId,
    observed,
  });
  assert.equal(repeat.created, false, "тот же материал не создаёт дубль");
  assert.equal(repeat.id, first.id, "иначе — та же строка");

  const onSource = await db
    .selectFrom("osint_observations")
    .select("id")
    .where("source_id", "=", sourceId)
    .execute();
  assert.equal(onSource.length, 1, "UNIQUE (source_id, content_hash) держится");

  // Другой материал того же источника — новое наблюдение, а не потеря данных.
  const changed = await ensureObservation(db, {
    businessId: biz.id,
    entityId,
    sourceId,
    observed: material(`https://idem-check.ru/`, "Пекарня Идемпотент", "новый ассортимент"),
  });
  assert.equal(changed.created, true);
  assert.notEqual(changed.id, first.id);
});

test("Test 3: tenant A cannot write an observation onto tenant B's entity/source", async () => {
  const profileA = profileFor("Кафе Альфа", "alpha-cafe.ru");
  const profileB = profileFor("Кафе Бета", "beta-cafe.ru");
  const uidA = await makeUser("Owner A");
  const bizA = await makeBusiness(uidA, profileA.businessName);
  const uidB = await makeUser("Owner B");
  const bizB = await makeBusiness(uidB, profileB.businessName);

  const entityA = await ensureBusinessEntity(db, {
    businessId: bizA.id,
    profile: profileA,
  });
  const entityB = await ensureBusinessEntity(db, {
    businessId: bizB.id,
    profile: profileB,
  });
  assert.notEqual(entityA, entityB, "разные профили → разные сущности");

  // Источник B: привязан только к сущности B.
  const sourceOfB = await seedSource("https://beta-cafe.ru/");
  await linkEntitySource(db, { entityId: entityB, sourceId: sourceOfB, confidence: 1 });

  const beforeCount = (await db
    .selectFrom("osint_observations")
    .select("id")
    .execute()).length;

  // 1) tenant A → entity/source tenant B: отказ без записи.
  const cross = await ensureObservation(db, {
    businessId: bizA.id,
    entityId: entityB,
    sourceId: sourceOfB,
    observed: material("https://beta-cafe.ru/", profileB.businessName),
  });
  assert.equal(cross.id, null);
  assert.equal(cross.created, false);
  assert.equal(cross.skipped, "tenant_bridge_missing");

  // 2) своя сущность, но источник к ней не привязан: тоже отказ.
  const orphanSource = await seedSource("https://orphan-source.ru/");
  const unlinked = await ensureObservation(db, {
    businessId: bizA.id,
    entityId: entityA,
    sourceId: orphanSource,
    observed: material("https://orphan-source.ru/", profileA.businessName),
  });
  assert.equal(unlinked.id, null);
  assert.equal(unlinked.skipped, "source_not_linked_to_entity");

  const afterCount = (await db
    .selectFrom("osint_observations")
    .select("id")
    .execute()).length;
  assert.equal(afterCount, beforeCount, "отказанные записи не оставили строк");
  assert.equal((await observationsOf(entityB)).length, 0, "entity B не тронута");

  // 3) Тот же writer с корректным тенантом — проходит (иначе guard просто
  //    всегда бы отказывал).
  const allowed = await ensureObservation(db, {
    businessId: bizA.id,
    entityId: entityA,
    sourceId: await (async () => {
      const sourceId = await seedSource("https://alpha-cafe.ru/");
      await linkEntitySource(db, { entityId: entityA, sourceId, confidence: 1 });
      return sourceId;
    })(),
    observed: material("https://alpha-cafe.ru/", profileA.businessName),
  });
  assert.equal(allowed.created, true, allowed.skipped ?? "");

  // 4) Читательская сторона: B не получает наблюдение A, зная его UUID.
  const written = (await observationsOf(entityA))[0];
  await assert.rejects(
    () => new OsintService(db).explainObservation(uidB, bizB.public_id, written.id),
    (error) => error.status === 404 && error.code === "OBSERVATION_NOT_FOUND",
    "tenant B не читает наблюдение tenant A",
  );
});

test("Test 4: created observation traces observation → source → entity → tenant", async () => {
  const domain = "provenance-cafe.ru";
  const profile = profileFor("Кафе Провенанс", domain);
  const uid = await makeUser();
  const biz = await makeBusiness(uid, profile.businessName);
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile,
  });

  const run = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: productionRegistry(),
    profile,
  });
  assert.equal(run.status, "completed", run.errors.join(" | "));

  const rows = await observationsOf(entityId);
  assert.equal(rows.length >= 1, true);
  const row = rows[0];

  // observation → source (global)
  const source = await db
    .selectFrom("osint_sources")
    .selectAll()
    .where("id", "=", row.source_id)
    .executeTakeFirst();
  assert.equal(source !== undefined, true, "источник существует");
  assert.equal(source.normalized_url, row.url);

  // observation → entity (global)
  const entity = await db
    .selectFrom("osint_entities")
    .selectAll()
    .where("id", "=", row.entity_id)
    .executeTakeFirst();
  assert.equal(entity !== undefined, true, "сущность существует");

  // entity ↔ source связь, без которой Stage 3 не соберёт fallback-путь
  const link = await db
    .selectFrom("osint_entity_sources")
    .selectAll()
    .where("entity_id", "=", row.entity_id)
    .where("source_id", "=", row.source_id)
    .executeTakeFirst();
  assert.equal(link !== undefined, true, "связь entity↔source сохранена");

  // мост тенанта → глобальная сущность
  const bridge = await db
    .selectFrom("osint_business_entities")
    .selectAll()
    .where("business_id", "=", biz.id)
    .where("entity_id", "=", row.entity_id)
    .executeTakeFirst();
  assert.equal(bridge !== undefined, true, "мост бизнеса на сущность есть");
  assert.notEqual(bridge.status, "rejected");

  // тенантский provenance Stage 2: кандидат хранит run/query/position
  const candidate = await db
    .selectFrom("osint_source_candidates")
    .selectAll()
    .where("business_id", "=", biz.id)
    .where("source_id", "=", row.source_id)
    .executeTakeFirst();
  assert.equal(candidate !== undefined, true, "кандидат привязан к источнику");
  assert.equal(candidate.discovery_run_id, run.runId, "run восстановим");
  assert.equal(candidate.query !== null, true);

  // Полная цепочка читается без второго формата провенанса.
  const chain = await db
    .selectFrom("osint_observations as o")
    .innerJoin("osint_sources as s", "s.id", "o.source_id")
    .innerJoin("osint_entity_sources as es", "es.source_id", "s.id")
    .innerJoin("osint_business_entities as be", "be.entity_id", "es.entity_id")
    .select("o.id")
    .where("o.id", "=", row.id)
    .where("be.business_id", "=", biz.id)
    .where("be.status", "!=", "rejected")
    .executeTakeFirst();
  assert.equal(chain !== undefined, true, "цепочка до тенанта замкнута");
});

test("Test 5: writer-produced observation explains through Stage 3", async () => {
  const domain = "stage3-cafe.ru";
  const profile = profileFor("Кафе Этап3", domain);
  const uid = await makeUser();
  const biz = await makeBusiness(uid, profile.businessName);
  const entityId = await ensureBusinessEntity(db, {
    businessId: biz.id,
    profile,
  });

  // Реальный Stage 2 вход → observation (не вручную вставленная строка).
  const run = await runDiscovery(db, {
    businessId: biz.id,
    userId: uid,
    registry: createRegistry([
      createMockProvider({
        id: "mock_search",
        results: [
          {
            url: `https://${domain}/`,
            title: profile.businessName,
            snippet:
              `Кафе Этап3 в Барнауле, ул. Ленина, 10. ` +
              `Телефон 8 (3852) 55-10-10. info@stage3-cafe.ru`,
            position: 1,
          },
        ],
      }),
    ]),
    profile,
  });
  assert.equal(run.status, "completed", run.errors.join(" | "));

  const rows = await observationsOf(entityId);
  assert.equal(rows.length >= 1, true);
  const row = rows[0];

  const service = new OsintService(db);
  const slice = await service.explainObservation(uid, biz.public_id, row.id);

  // Evidence
  assert.equal(slice.reason, null, "наблюдение объяснимо целиком");
  assert.equal(slice.evidence.id, row.id);
  assert.equal(slice.evidence.content, row.content);
  assert.equal(slice.evidence.sourceId, row.source_id);
  assert.equal(slice.evidence.entityId, row.entity_id);
  assert.equal(slice.source.id, row.source_id);
  assert.equal(slice.entity.id, row.entity_id);

  // Claim(s)
  assert.equal(slice.claims.length >= 1, true, "из content извлеклись claims");
  const predicates = slice.claims.map((claim) => claim.predicate);
  assert.equal(predicates.includes("website"), true, predicates.join(","));
  assert.equal(predicates.includes("phone"), true, predicates.join(","));

  // Provenance: Claim → Evidence → Observation → Source, textSpan внутри content.
  for (const claim of slice.claims) {
    assert.equal(claim.businessId, biz.id);
    assert.equal(claim.provenance.observationId, row.id);
    assert.equal(claim.provenance.sourceId, row.source_id);
    assert.deepEqual(claim.provenance.evidenceRef, claim.evidence[0]);
    const span = claim.evidence[0].textSpan;
    assert.equal(typeof span, "string");
    assert.equal(
      row.content.includes(span),
      true,
      "textSpan безошибочно лежит внутри Evidence.content",
    );
  }

  // Детерминизм живого slice.
  const again = await service.explainObservation(uid, biz.public_id, row.id);
  assert.deepEqual(again, slice, "повторное объяснение идентично");
});
