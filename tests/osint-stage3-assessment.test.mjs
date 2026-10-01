/**
 * Stage 3 runtime v2 — corroboration / contradiction / claim assessment (§5).
 *
 * Оценка — read-model без персистентности, поэтому повторный запуск того же
 * входа обязан давать байт-в-байт тот же ответ (§8), а доступ определяется
 * тенантским мостом `osint_business_entities`, а не знанием UUID (§7).
 *
 * Часть кейсов гоняется на чистой функции `assessClaims` (где важны
 * семантика сравнения и правила), часть — на реальных строках Stage 2 в
 * PGlite (где важны tenant isolation и фактическая экстракция).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import { assessClaims } from "../src/server/intelligence/osint/assessment.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { ensureBusinessEntity } from "../src/server/intelligence/osint/entity-graph.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PURE_BIZ = "00000000-0000-4000-8000-000000000001";

const PHONE_A = "73852551010";
const PHONE_B = "73852552233";

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
    .values({
      business_id: row.id,
      user_id: ownerId,
      role: "owner",
      status: "active",
    })
    .execute();
  return row;
}

/**
 * Отдельный профиль на каждый кейс: сущности в Stage 2 глобальны, и
 * переиспользование имени склеило бы наблюдения разных тестов.
 */
async function scenario(label) {
  const userId = await makeUser();
  const business = await makeBusiness(userId, label);
  const entityId = await ensureBusinessEntity(db, {
    businessId: business.id,
    profile: buildDiscoveryProfile({
      name: label,
      description: `${label} — тестовое заведение.`,
      industry: "food",
    }),
  });
  return { userId, business, entityId };
}

async function createSource() {
  const sourceId = randomUUID();
  const url = `https://src-${sourceId.slice(0, 8)}.example.org/`;
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
  return { sourceId, url };
}

async function attachSource(entityId, sourceId) {
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: entityId,
      source_id: sourceId,
      confidence: "1",
      created_at: new Date(),
    })
    .execute();
}

async function addObservation({
  entityId,
  sourceId,
  content,
  kind = "page",
  observedAt,
  contentHash,
}) {
  const observationId = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: observationId,
      source_id: sourceId,
      entity_id: entityId,
      content,
      content_hash: contentHash ?? randomUUID(),
      kind,
      observed_at: observedAt,
      created_at: new Date(),
    })
    .execute();
  return observationId;
}

const RICH_A =
  "Кафе. Телефон: 8 (3852) 55-10-10. Почта: info@romashka.ru. " +
  "Сайт: https://romashka.ru/";
const RICH_B =
  "Кафе в Барнауле. Телефон: +7 (3852) 55-10-10. Почта: info@romashka.ru. " +
  "Сайт: https://romashka.ru/";

function makeClaim(input) {
  const observationId = input.observationId ?? null;
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00.000Z";
  return {
    id: input.id,
    businessId: input.businessId ?? PURE_BIZ,
    kind: input.kind ?? "contact",
    subject: input.subject ?? "Кафе Ромашка",
    predicate: input.predicate ?? "phone",
    value: input.value ?? PHONE_A,
    valueKind: input.valueKind ?? "string",
    evidence: observationId
      ? [
          {
            observationId,
            textSpan: "фрагмент",
            evidenceKind: "text_span",
            confidence: 0.95,
          },
        ]
      : [],
    confidence: input.confidence ?? 0.95,
    validFrom: createdAt,
    validTo: null,
    createdAt,
  };
}

function assess(claims, provenance, extra = {}) {
  return assessClaims({
    businessId: extra.businessId ?? PURE_BIZ,
    observationCount: extra.observationCount ?? claims.length,
    skippedObservations: extra.skippedObservations ?? 0,
    claims,
    provenance,
  });
}

function singleGroup(result) {
  assert.equal(result.groups.length, 1, `groups=${result.groups.length}`);
  return result.groups[0];
}

test("Test 1: два источника с одним значением → corroboration, но independence остаётся unknown", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 1");
  const first = await createSource();
  const second = await createSource();
  await attachSource(entityId, first.sourceId);
  await attachSource(entityId, second.sourceId);

  await addObservation({ entityId, sourceId: first.sourceId, content: RICH_A });
  await addObservation({ entityId, sourceId: second.sourceId, content: RICH_B });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  assert.equal(result.businessId, business.id);
  assert.equal(result.observationCount, 2);
  assert.equal(result.skippedObservations, 0);
  assert.equal(result.reason, null);
  assert.ok(result.groups.length >= 3, `groups=${result.groups.length}`);

  for (const group of result.groups) {
    assert.equal(group.rule, "distinct_sources", group.predicate);
    assert.equal(group.independence, "unknown", "§4.5: не доказываем независимость");
    assert.equal(group.distinctObservationCount, 2);
    assert.equal(group.distinctSourceCount, 2);
    assert.equal(group.observations.length, 2);
    assert.equal(group.sources.length, 2);
    assert.ok(group.gaps.includes("source_independence_unknown"));

    assert.ok(group.corroboration, `${group.predicate}: corroboration ожидался`);
    assert.equal(group.corroboration.status, "corroborated");
    assert.equal(group.corroboration.distinctSourceCount, 2);
    assert.equal(group.corroboration.claims.length, 2);
    assert.equal(
      group.corroboration.confidence,
      Math.min(...group.corroboration.claims.map((claim) => claim.confidence)),
      "confidence — пол извлечения, не новая оценка",
    );
    assert.deepEqual(group.contradictions, []);

    // §6: каждый claim трассируется до своего наблюдения и источника.
    assert.equal(group.provenance.length, group.claimCount);
    for (const pointer of group.provenance) {
      assert.ok(group.observations.includes(pointer.observationId));
      assert.ok(group.sources.includes(pointer.sourceId));
      assert.equal(pointer.observationId, pointer.evidenceRef.observationId);
      assert.ok(pointer.claimId.length > 0);
    }
  }
});

test("Test 2: одного наблюдения недостаточно — подтвердить нечем", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 2");
  const source = await createSource();
  await attachSource(entityId, source.sourceId);
  await addObservation({ entityId, sourceId: source.sourceId, content: RICH_A });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  assert.ok(result.groups.length >= 1);
  for (const group of result.groups) {
    assert.equal(group.rule, "single_observation");
    assert.equal(group.corroboration, null);
    assert.deepEqual(group.contradictions, []);
    assert.equal(group.distinctObservationCount, 1);
    assert.ok(group.gaps.includes("insufficient_observations"));
    assert.ok(!group.gaps.includes("source_independence_unknown"));
  }
});

test("Test 3: один source с несколькими observations ≠ несколько источников", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 3");
  const source = await createSource();
  await attachSource(entityId, source.sourceId);
  await addObservation({ entityId, sourceId: source.sourceId, content: RICH_A });
  await addObservation({ entityId, sourceId: source.sourceId, content: RICH_B });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  assert.equal(result.observationCount, 2);
  for (const group of result.groups) {
    assert.equal(group.rule, "single_source", group.predicate);
    assert.equal(group.distinctObservationCount, 2);
    assert.equal(group.distinctSourceCount, 1);
    assert.equal(group.corroboration, null, "§4.3: один source не подтверждает сам себя");
    assert.ok(!group.gaps.includes("source_independence_unknown"));
  }
});

test("Test 4: разные значения безопасного predicate → contradiction candidate", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 4");
  const first = await createSource();
  const second = await createSource();
  await attachSource(entityId, first.sourceId);
  await attachSource(entityId, second.sourceId);

  await addObservation({
    entityId,
    sourceId: first.sourceId,
    content: "Кафе. Телефон: 8 (3852) 55-10-10.",
    observedAt: new Date("2024-05-01T00:00:00.000Z"),
  });
  await addObservation({
    entityId,
    sourceId: second.sourceId,
    content: "Кафе. Телефон: 8 (3852) 55-22-33.",
    observedAt: new Date("2024-06-01T00:00:00.000Z"),
  });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  const group = singleGroup(result);
  assert.equal(group.predicate, "phone");
  assert.equal(group.rule, "value_mismatch");
  assert.equal(group.contradictions.length, 1);

  const contradiction = group.contradictions[0];
  assert.equal(contradiction.businessId, business.id);
  assert.equal(contradiction.sides.length, 2);
  assert.deepEqual(
    contradiction.sides.map((side) => side.value).sort(),
    [PHONE_A, PHONE_B],
  );
  for (const side of contradiction.sides) {
    assert.equal(side.claims.length, 1);
    assert.ok(side.claims[0].evidence[0].observationId);
  }
  assert.ok(group.gaps.includes("no_temporal_semantics"));
  assert.ok(group.gaps.includes("source_independence_unknown"));
  assert.equal(group.corroboration, null);
});

test("Test 5: временно изменчивый predicate не разрешается категорически", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 5");
  const first = await createSource();
  const second = await createSource();
  await attachSource(entityId, first.sourceId);
  await attachSource(entityId, second.sourceId);

  const newer = new Date("2024-06-01T00:00:00.000Z");
  await addObservation({
    entityId,
    sourceId: first.sourceId,
    content: "Кафе. Телефон: 8 (3852) 55-10-10.",
    observedAt: new Date("2024-05-01T00:00:00.000Z"),
  });
  await addObservation({
    entityId,
    sourceId: second.sourceId,
    content: "Кафе. Телефон: 8 (3852) 55-22-33.",
    observedAt: newer,
  });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  const contradiction = singleGroup(result).contradictions[0];
  assert.ok(contradiction, "кандидат на противоречие есть");
  assert.equal(contradiction.resolution, "unresolved");
  assert.equal(contradiction.status, "unresolved");
  // §8: момент вывода — из данных, а не из часов запуска.
  assert.equal(
    contradiction.detectedAt,
    newer.toISOString(),
    "§8: вывод привязан к данным, а не к часам запуска",
  );
  assert.match(
    contradiction.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("Test 6: два телефона одного источника не считаются спором источников", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 6");
  const first = await createSource();
  const second = await createSource();
  await attachSource(entityId, first.sourceId);
  await attachSource(entityId, second.sourceId);

  await addObservation({
    entityId,
    sourceId: first.sourceId,
    content:
      "Кафе. Телефоны: 8 (3852) 55-10-10 и 8 (3852) 55-22-33.",
  });
  await addObservation({
    entityId,
    sourceId: second.sourceId,
    content: "Кафе. Телефон: 8 (3852) 55-10-10.",
  });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  const group = singleGroup(result);
  assert.equal(group.rule, "distinct_sources");
  assert.deepEqual(group.contradictions, [], "нет двух непересекающихся ответов");
  assert.ok(group.corroboration, "общее значение подтверждено двумя источниками");
  assert.equal(group.corroboration.value, PHONE_A);
  assert.equal(group.corroboration.distinctSourceCount, 2);
});

test("Test 7: разные предметы не сравниваются между собой", async () => {
  const claims = [
    makeClaim({ id: "a1", subject: "Кафе Ромашка", observationId: "o1", value: PHONE_A }),
    makeClaim({ id: "a2", subject: "Кафе Ромашка", observationId: "o2", value: PHONE_A }),
    makeClaim({ id: "b1", subject: "Пекарня Светлана", observationId: "o3", value: PHONE_B }),
    makeClaim({ id: "b2", subject: "Пекарня Светлана", observationId: "o4", value: PHONE_B }),
  ];
  const provenance = new Map([
    ["o1", "s1"],
    ["o2", "s2"],
    ["o3", "s3"],
    ["o4", "s4"],
  ]);

  const result = assess(claims, provenance);
  assert.equal(result.groups.length, 2);
  assert.deepEqual(
    result.groups.map((group) => group.subject),
    ["Кафе Ромашка", "Пекарня Светлана"],
  );
  for (const group of result.groups) {
    assert.equal(group.rule, "distinct_sources");
    assert.deepEqual(group.contradictions, [], "§5: несовместимые предметы не сравниваются");
  }
  assert.ok(result.groups.every((group) => group.distinctObservationCount === 2));
});

test("Test 8: неизвестный predicate получает not_assessed", async () => {
  const claims = [
    makeClaim({
      id: "x1",
      predicate: "favourite_colour",
      value: "red",
      observationId: "o1",
    }),
    makeClaim({
      id: "x2",
      predicate: "favourite_colour",
      value: "blue",
      observationId: "o2",
    }),
  ];
  const provenance = new Map([
    ["o1", "s1"],
    ["o2", "s2"],
  ]);

  const group = singleGroup(assess(claims, provenance));
  assert.equal(group.rule, "not_assessed");
  assert.equal(group.corroboration, null);
  assert.deepEqual(group.contradictions, []);
  assert.ok(group.gaps.includes("predicate_not_comparable"));
  assert.equal(group.claimCount, 2);
});

test("Test 9: оценка детерминирована и не мутирует входные claims", async () => {
  const claims = [
    makeClaim({ id: "d1", observationId: "o1", value: PHONE_A }),
    makeClaim({ id: "d2", observationId: "o2", value: PHONE_A }),
    makeClaim({ id: "d3", observationId: "o3", value: PHONE_B }),
    makeClaim({ id: "d4", observationId: "o4", value: PHONE_B }),
  ];
  const provenance = new Map([
    ["o1", "s1"],
    ["o2", "s2"],
    ["o3", "s3"],
    ["o4", "s4"],
  ]);
  const snapshot = structuredClone(claims);

  const first = assess(claims, provenance);
  const second = assess([...claims].reverse(), provenance);
  const third = assess(claims, provenance);

  assert.deepEqual(second, first, "порядок входа не влияет на ответ");
  assert.deepEqual(third, first, "повторная проекция идентична");
  assert.deepEqual(claims, snapshot, "§5: исходные Claim не мутируются");

  const contradiction = first.groups[0].contradictions[0];
  assert.ok(contradiction);
  assert.equal(
    contradiction.id,
    second.groups[0].contradictions[0].id,
    "§8: id противоречия выводится из данных",
  );

  // Нормализация не доходит до отданного значения: провенанс сохранён.
  for (const side of contradiction.sides) {
    assert.equal(typeof side.value, "string");
    assert.ok(side.claims[0].evidence[0].textSpan.length > 0);
  }
});

test("Test 10: cross-tenant наблюдения не попадают в оценку", async () => {
  const own = await scenario("Кафе Оценка 10а");
  const foreign = await scenario("Пекарня Оценка 10б");
  const stranger = await makeUser("Stranger");

  const ownSource = await createSource();
  await attachSource(own.entityId, ownSource.sourceId);
  await addObservation({
    entityId: own.entityId,
    sourceId: ownSource.sourceId,
    content: RICH_A,
  });

  const foreignSource = await createSource();
  await attachSource(foreign.entityId, foreignSource.sourceId);
  await addObservation({
    entityId: foreign.entityId,
    sourceId: foreignSource.sourceId,
    content:
      "Пекарня. Телефон: 8 (3852) 55-99-99. Сайт: https://svetlana.example/",
  });

  const service = new OsintService(db);
  const result = await service.assessObservations(
    own.userId,
    own.business.public_id,
  );

  assert.equal(result.observationCount, 1, "чужое наблюдение не читается");
  assert.equal(result.skippedObservations, 0);
  for (const group of result.groups) {
    assert.equal(group.subject, "Кафе Оценка 10а");
    assert.ok(
      !JSON.stringify(group).includes("55-99-99"),
      "§7: чужие claims не смешиваются",
    );
    assert.ok(!group.sources.includes(foreignSource.sourceId));
  }

  await assert.rejects(
    () => service.assessObservations(stranger, own.business.public_id),
    (error) => error.status === 404 && error.code === "BUSINESS_NOT_FOUND",
  );

  // §7: claim чужого бизнеса не создаёт группу и не подтверждает нашу.
  const onlyForeign = assess(
    [
      makeClaim({
        id: "t",
        businessId: foreign.business.id,
        subject: "Кафе Оценка 10а",
        observationId: "o9",
      }),
    ],
    new Map([["o9", "s9"]]),
    { businessId: own.business.id },
  );
  assert.deepEqual(onlyForeign.groups, []);
  assert.equal(onlyForeign.reason, "insufficient_evidence");

  const mixed = assess(
    [
      makeClaim({
        id: "mine",
        businessId: own.business.id,
        subject: "Кафе Оценка 10а",
        observationId: "o1",
      }),
      makeClaim({
        id: "theirs",
        businessId: foreign.business.id,
        subject: "Кафе Оценка 10а",
        observationId: "o2",
      }),
    ],
    new Map([
      ["o1", "s1"],
      ["o2", "s2"],
    ]),
    { businessId: own.business.id },
  );
  const mine = singleGroup(mixed);
  assert.equal(mine.claimCount, 1, "чужой claim отброшен");
  assert.equal(mine.rule, "single_observation");
  assert.ok(!JSON.stringify(mixed).includes('"theirs"'));
});

test("Test 11: без наблюдений возвращается пустой, но объяснимый результат", async () => {
  const { userId, business } = await scenario("Кафе Оценка 11");

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  assert.deepEqual(result, {
    businessId: business.id,
    observationCount: 0,
    skippedObservations: 0,
    claimCount: 0,
    groups: [],
    reason: "insufficient_evidence",
  });
});

test("Test 12: claim без проверяемой провенанс-цепочки не выдаётся за подтверждение", async () => {
  const untraceable = [
    makeClaim({ id: "u1", observationId: "ghost-1", value: PHONE_A }),
    makeClaim({ id: "u2", observationId: "ghost-2", value: PHONE_A }),
    makeClaim({ id: "u3", observationId: null, value: PHONE_A }),
  ];

  // (a) Цепочка не проверяется в этом тенанте → подтверждения нет.
  const denied = singleGroup(assess(untraceable, new Map()));
  assert.equal(denied.rule, "missing_provenance");
  assert.equal(denied.claimCount, 0);
  assert.equal(denied.corroboration, null);
  assert.deepEqual(denied.contradictions, []);
  assert.deepEqual(denied.observations, []);
  assert.deepEqual(denied.provenance, []);
  assert.ok(denied.gaps.includes("missing_provenance"));

  // (b) Та же группа с работающей цепочкой — подтверждение появляется,
  //     то есть (a) отличимо от «источников нет».
  const traceable = untraceable.filter((claim) => claim.evidence.length > 0);
  const ok = singleGroup(
    assess(
      traceable,
      new Map([
        ["ghost-1", "s1"],
        ["ghost-2", "s2"],
      ]),
    ),
  );
  assert.equal(ok.rule, "distinct_sources");
  assert.ok(ok.corroboration);
  assert.equal(ok.corroboration.distinctSourceCount, 2);
  assert.equal(ok.claimCount, 2);
  assert.ok(!ok.gaps.includes("missing_provenance"));
});

test("Test 13: повтор одного observation не увеличивает поддержку claim", () => {
  // Три разных claim + точный дубль id — и всё это одно наблюдение.
  const claims = [
    makeClaim({ id: "dup", observationId: "o1", value: PHONE_A }),
    makeClaim({ id: "dup", observationId: "o1", value: PHONE_A }),
    makeClaim({ id: "same-value", observationId: "o1", value: PHONE_A }),
    makeClaim({ id: "other-value", observationId: "o1", value: PHONE_B }),
  ];
  const provenance = new Map([["o1", "s1"]]);

  const group = singleGroup(assess(claims, provenance, { observationCount: 1 }));

  assert.equal(group.claimCount, 3, "точный дубль id схлопывается");
  assert.equal(
    group.distinctObservationCount,
    1,
    "§4.2: повторная проекция того же наблюдения не растит счётчик",
  );
  assert.equal(group.distinctSourceCount, 1);
  assert.equal(group.rule, "single_observation");
  assert.equal(group.corroboration, null);
  assert.deepEqual(group.contradictions, [], "§4.1: один источник не спорит сам с собой");
  assert.deepEqual(group.observations, ["o1"]);
  assert.deepEqual(group.sources, ["s1"]);
});

test("Test 14: повреждённое наблюдение пропускается, а не роняет bulk-оценку", async () => {
  const { userId, business, entityId } = await scenario("Кафе Оценка 14");
  const source = await createSource();
  await attachSource(entityId, source.sourceId);

  const good = await addObservation({
    entityId,
    sourceId: source.sourceId,
    content: RICH_A,
  });
  // content_hash из пробела проходит CHECK (1..128), но не даёт права на
  // Claim (§6): `toEvidence` отвечает 422, а bulk обязан это пережить,
  // а не отдать 503 на весь endpoint.
  const broken = await addObservation({
    entityId,
    sourceId: source.sourceId,
    content: RICH_A,
    contentHash: " ",
  });

  const result = await new OsintService(db).assessObservations(
    userId,
    business.public_id,
  );

  assert.equal(result.observationCount, 2, "обе строки попадают в scope");
  assert.equal(result.skippedObservations, 1, "битая строка идёт в skipped");
  assert.equal(result.reason, null);
  assert.ok(result.groups.length >= 1, "валидное наблюдение обработано");

  for (const group of result.groups) {
    assert.equal(group.distinctObservationCount, 1);
    assert.equal(group.rule, "single_observation");
    assert.ok(group.observations.includes(good));
    assert.ok(
      !group.observations.includes(broken),
      "битая строка не даёт claims",
    );
  }
});
