/**
 * Паспорт OSINT-исследования (research brief) — §2/§3 задачи Stage 4.
 *
 * На PGlite (in-memory PostgreSQL): строгая валидация, создание и
 * изменение паспорта, восстановление конфигурации, предпросмотр без
 * запуска, обязательные данные запуска, snapshot параметров, идемпотентность
 * дублей запуска, неподдерживаемые цели, исключение URL из seed-очереди и
 * tenant isolation между двумя бизнесами.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import { AppError } from "../src/server/http/errors.ts";
import {
  GOAL_CATALOG,
  buildResearchPlan,
  excludedIndex,
  goalLevel,
  parsePassportContent,
  passportEquals,
  researchCapabilities,
  sanitizePhrases,
} from "../src/server/intelligence/osint/research-passport.ts";
import { createBuiltinRegistry } from "../src/server/intelligence/osint/providers/builtin.ts";
import {
  attachSource,
  createSource,
  makeUser,
  scenario,
} from "./helpers/osint-stage3-fixtures.mjs";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const service = new OsintService(db);

function passport(overrides = {}) {
  return {
    formatVersion: 1,
    identification: {
      displayName: "Кафе Ромашка",
      legalName: null,
      aliases: ["Ромашка кофе"],
      category: "Кафе",
      country: "Россия",
      region: "Алтайский край",
      city: "Барнаул",
      address: null,
      urls: [
        { url: "https://romashka.example/", role: "official" },
        { url: "https://2gis.example/listing/1", role: "candidate" },
        { url: "https://excluded.example/", role: "excluded" },
      ],
      domains: [],
      phones: ["8 (3852) 55-10-10"],
      emails: ["info@romashka.example"],
      notes: "Не путать с Ромашкой в Новосибирске.",
    },
    goals: {
      selected: ["contacts", "reviews"],
      importantNotes: "Телефон и адрес.",
      excludeNotes: null,
      geoLimits: "Только Барнаул",
      searchPhrases: ["ромашка барнаул меню"],
    },
    ...overrides,
  };
}

test("Паспорт: строгая серверная валидация и санитизация", async () => {
  const content = parsePassportContent(passport());
  assert.equal(content.identification.displayName, "Кафе Ромашка");
  assert.equal(content.identification.urls.length, 3);
  assert.ok(
    content.identification.domains.includes("romashka.example"),
    "домены выводятся из активных URL",
  );
  assert.ok(
    !content.identification.domains.includes("excluded.example"),
    "исключённый URL не попадает в домены",
  );

  assert.throws(
    () =>
      parsePassportContent(
        passport({ identification: { displayName: "x".repeat(201) } }),
      ),
    (error) => error instanceof AppError && error.status === 400,
    "displayName > 200 символов",
  );
  assert.throws(
    () =>
      parsePassportContent(
        passport({ goals: { selected: ["mind_control"] } }),
      ),
    (error) =>
      error instanceof AppError &&
      error.status === 400 &&
      error.code === "INVALID_PASSPORT",
    "неизвестная цель",
  );
  assert.throws(
    () =>
      parsePassportContent(
        passport({
          identification: { urls: [{ url: "javascript:alert(1)", role: "official" }] },
        }),
      ),
    (error) => error instanceof AppError && error.status === 400,
    "не-http URL",
  );
  assert.throws(
    () =>
      parsePassportContent(
        passport({ formatVersion: 2 }),
      ),
    (error) => error instanceof AppError && error.status === 400,
    "неизвестная версия формата",
  );

  const phrases = sanitizePhrases([
    "короткая фраза",
    "x".repeat(121),
    "https://site.example/page",
    42,
  ]);
  assert.deepEqual(phrases.phrases, ["короткая фраза"]);
  assert.equal(phrases.invalid.length, 3, "длинная, URL и не-текст");

  const excluded = excludedIndex(content);
  assert.deepEqual(excluded.urls, ["https://excluded.example/"]);
  assert.ok(excluded.domains.includes("excluded.example"));

  assert.ok(passportEquals({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }));
  assert.ok(!passportEquals({ a: 1 }, { a: 2 }));
});

test("Паспорт: уровни целей детерминированы реестром провайдеров", async () => {
  const registry = createBuiltinRegistry();
  const caps = researchCapabilities(registry);
  const byId = new Map(
    GOAL_CATALOG.map((goal) => [goal.id, goalLevel(goal, caps)]),
  );
  assert.equal(byId.get("contacts").level, "supported");
  for (const goal of GOAL_CATALOG) {
    const runtime = byId.get(goal.id);
    assert.ok(
      ["supported", "partial", "unsupported"].includes(runtime.level),
      `${goal.id}: уровень из допустимого набора`,
    );
    if (runtime.level === "unsupported")
      assert.ok(runtime.reason, `${goal.id}: недоступность объяснена`);
  }
  const plan = buildResearchPlan(parsePassportContent(passport()), registry);
  assert.ok(plan.unsupported.length > 0, "план честно перечисляет пределы");
  assert.ok(
    plan.unsupported.some((item) => item.includes("Временной горизонт")),
    "временной горизонт неподдерживаем явно",
  );
  assert.equal(plan.needsConfirmation[0]?.url, "https://2gis.example/listing/1");
  assert.equal(plan.identification.hasOfficialUrl, true);
  assert.equal(plan.queries[0].templateId, "passport_phrase", "фразы первыми");
});

test("Паспорт: GET без паспорта отдаёт prefill карточки, не пустоту", async () => {
  const ctx = await scenario(db, "Паспорт префилл");
  const research = await service.getResearch(ctx.userId, ctx.business.public_id);
  assert.equal(research.passport, null);
  assert.equal(research.prefill.displayName, ctx.label);
  assert.equal(research.history.length, 0);
  assert.equal(research.launch, null);
  assert.equal(research.goals.length, GOAL_CATALOG.length);
  assert.ok(research.providers.length > 0);
});

test("Паспорт: создание, изменение, восстановление и revision-контракт", async (t) => {
  const ctx = await scenario(db, "Паспорт ревизии");
  const publicId = ctx.business.public_id;
  const content = parsePassportContent(passport());

  const saved = await service.savePassport(ctx.userId, publicId, content, null);
  assert.equal(saved.revision, 1, "первое сохранение — ревизия 1");

  const restored = await service.getResearch(ctx.userId, publicId);
  assert.deepEqual(restored.passport.content, content, "конфигурация восстановлена");
  assert.equal(restored.history.length, 1);

  await t.test("без изменений новая ревизия не создаётся", async () => {
    const again = await service.savePassport(ctx.userId, publicId, content, 1);
    assert.equal(again.revision, 1);
    const after = await service.getResearch(ctx.userId, publicId);
    assert.equal(after.history.length, 1, "история не раздувается");
  });

  await t.test("изменение контента → ревизия 2 и история", async () => {
    const changed = parsePassportContent(passport());
    changed.identification.aliases = ["Ромашка кофе", "Кафе у Ромашки"];
    const result = await service.savePassport(ctx.userId, publicId, changed, 1);
    assert.equal(result.revision, 2);
    const after = await service.getResearch(ctx.userId, publicId);
    assert.equal(after.passport.revision, 2);
    assert.equal(after.history.length, 2);
    assert.deepEqual(after.passport.content, changed);
  });

  await t.test("устаревший или пустой expectedRevision → 409", async () => {
    await assert.rejects(
      service.savePassport(ctx.userId, publicId, content, null),
      (error) =>
        error instanceof AppError &&
        error.status === 409 &&
        error.code === "PASSPORT_REVISION_CONFLICT",
      "null при существующем паспорте",
    );
    await assert.rejects(
      service.savePassport(ctx.userId, publicId, content, 1),
      (error) => error instanceof AppError && error.status === 409,
      "rev 1 уже устарела",
    );
    await assert.rejects(
      service.savePassport(ctx.userId, publicId, content, 99),
      (error) => error instanceof AppError && error.status === 409,
    );
  });

  await t.test("битый expectedRevision → 400", async () => {
    await assert.rejects(
      service.savePassport(ctx.userId, publicId, content, "abc"),
      (error) =>
        error instanceof AppError &&
        error.status === 400 &&
        error.code === "INVALID_EXPECTED_REVISION",
    );
  });
});

test("Паспорт: предпросмотр строит план без записи и без запуска", async () => {
  const ctx = await scenario(db, "Паспорт предпросмотр");
  const publicId = ctx.business.public_id;
  const before = {
    runs: await db
      .selectFrom("osint_discovery_runs")
      .select("id")
      .where("business_id", "=", ctx.business.id)
      .execute(),
    launches: await db
      .selectFrom("osint_research_launches")
      .select("id")
      .where("business_id", "=", ctx.business.id)
      .execute(),
  };
  assert.equal(before.runs.length, 0);
  assert.equal(before.launches.length, 0);

  const { plan } = await service.previewResearch(
    ctx.userId,
    publicId,
    passport(),
  );
  assert.ok(plan.queries.length > 0, "запросы сформированы");
  assert.equal(plan.queries[0].templateId, "passport_phrase");
  assert.deepEqual(
    plan.goals.map((goal) => goal.id).sort(),
    ["contacts", "reviews"],
    "в плане только выбранные цели",
  );
  assert.equal(plan.crawl.enabled, true, "есть стартовые URL и провайдер страниц");

  const after = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("business_id", "=", ctx.business.id)
    .execute();
  assert.equal(after.length, 0, "предпросмотр не создаёт run");
  const passportRows = await db
    .selectFrom("osint_research_passports")
    .select("id")
    .where("business_id", "=", ctx.business.id)
    .execute();
  assert.equal(passportRows.length, 0, "предпросмотр не сохраняет паспорт");
});

test("Паспорт: запуск требует обязательных данных", async () => {
  const ctx = await scenario(db, "Паспорт обязательные");
  const publicId = ctx.business.public_id;

  await assert.rejects(
    service.launchResearch(ctx.userId, publicId, passport({ identification: { displayName: "   " } }), null),
    (error) =>
      error instanceof AppError &&
      error.status === 422 &&
      error.code === "RESEARCH_NAME_REQUIRED",
    "без названия",
  );
  await assert.rejects(
    service.launchResearch(ctx.userId, publicId, passport({ goals: { selected: [] } }), null),
    (error) =>
      error instanceof AppError &&
      error.status === 422 &&
      error.code === "RESEARCH_GOALS_REQUIRED",
    "без целей",
  );
  await assert.rejects(
    service.launchResearch(
      ctx.userId,
      publicId,
      passport({ goals: { selected: ["services_goods", "prices"] } }),
      null,
    ),
    (error) =>
      error instanceof AppError &&
      error.status === 422 &&
      error.code === "RESEARCH_GOALS_UNSUPPORTED",
    "все выбранные цели неподдерживаемы",
  );
  const runs = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("business_id", "=", ctx.business.id)
    .execute();
  assert.equal(runs.length, 0, "отказы не создали run");
});

test("Паспорт: запуск фиксирует snapshot, дубль идемпотентен, настройки заморожены", async (t) => {
  const ctx = await scenario(db, "Паспорт запуск");
  const publicId = ctx.business.public_id;
  const content = parsePassportContent(passport());
  const saved = await service.savePassport(ctx.userId, publicId, content, null);
  let firstLaunchId = null;

  const prior = await createSource(db, "https://excluded.example/page");
  await attachSource(db, ctx.entityId, prior.sourceId);

  await t.test("первый запуск: snapshot, extra_queries, seed-исключения", async () => {
    const outcome = await service.launchResearch(
      ctx.userId,
      publicId,
      content,
      saved.revision,
    );
    assert.equal(outcome.created, true);
    assert.equal(outcome.status, "queued");
    assert.ok(outcome.runId);

    const launch = await db
      .selectFrom("osint_research_launches")
      .selectAll()
      .where("id", "=", outcome.launchId)
      .executeTakeFirstOrThrow();
    assert.deepEqual(launch.passport_snapshot, content, "снимок паспорта");
    assert.ok(launch.plan, "снимок плана");
    assert.equal(launch.run_id, outcome.runId);
    assert.equal(launch.status, "queued");
    firstLaunchId = launch.id;

    const run = await db
      .selectFrom("osint_discovery_runs")
      .selectAll()
      .where("id", "=", outcome.runId)
      .executeTakeFirstOrThrow();
    assert.equal(run.status, "queued");
    const extra = run.extra_queries;
    assert.ok(Array.isArray(extra) && extra.length === 1, "фраза в extra_queries");
    assert.equal(extra[0].text, "ромашка барнаул меню");

    const queue = await db
      .selectFrom("osint_crawl_queue")
      .select("url")
      .where("run_id", "=", outcome.runId)
      .execute();
    const urls = queue.map((row) => row.url);
    assert.ok(
      urls.some((url) => url.startsWith("https://romashka.example/")),
      "официальный сайт в очереди",
    );
    assert.ok(
      !urls.some((url) => url.includes("excluded.example")),
      "исключённый домен не попадает в очередь (включая prior source)",
    );
  });

  await t.test("дубль запуска возвращает существующий", async () => {
    const runsBefore = await db
      .selectFrom("osint_discovery_runs")
      .select("id")
      .where("business_id", "=", ctx.business.id)
      .execute();
    const again = await service.launchResearch(
      ctx.userId,
      publicId,
      content,
      saved.revision,
    );
    assert.equal(again.created, false, "повторный запрос не создаёт второй запуск");
    const runsAfter = await db
      .selectFrom("osint_discovery_runs")
      .select("id")
      .where("business_id", "=", ctx.business.id)
      .execute();
    assert.equal(runsAfter.length, runsBefore.length, "run не задвоен");
    assert.equal(again.launchId, firstLaunchId, "тот же активный запуск");
  });

  await t.test("изменение паспорта не меняет снимок запущенного", async () => {
    const launchRow = await db
      .selectFrom("osint_research_launches")
      .selectAll()
      .where("business_id", "=", ctx.business.id)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirstOrThrow();
    const snapshotBefore = launchRow.passport_snapshot;

    const changed = parsePassportContent(passport());
    changed.identification.notes = "Изменено ПОСЛЕ запуска.";
    const saved2 = await service.savePassport(
      ctx.userId,
      publicId,
      changed,
      launchRow.passport_revision,
    );
    assert.ok(saved2.revision > launchRow.passport_revision);

    const launchAfter = await db
      .selectFrom("osint_research_launches")
      .selectAll()
      .where("id", "=", launchRow.id)
      .executeTakeFirstOrThrow();
    assert.deepEqual(
      launchAfter.passport_snapshot,
      snapshotBefore,
      "снимок запуска не изменился",
    );
    assert.notDeepEqual(
      launchAfter.passport_snapshot,
      changed,
      "текущий паспорт и снимок запуска разные",
    );
  });
});

test("Паспорт: tenant isolation — чужой бизнес недоступен", async () => {
  const ctxA = await scenario(db, "Паспорт тенант А");
  const ctxB = await scenario(db, "Паспорт тенант Б");
  const publicA = ctxA.business.public_id;

  await assert.rejects(
    service.getResearch(ctxB.userId, publicA),
    (error) => error instanceof AppError && error.status !== 500,
    "GET чужого паспорта",
  );
  await assert.rejects(
    service.savePassport(ctxB.userId, publicA, passport(), null),
    (error) => error instanceof AppError && error.status !== 500,
    "PUT чужого паспорта",
  );
  await assert.rejects(
    service.previewResearch(ctxB.userId, publicA, passport()),
    (error) => error instanceof AppError && error.status !== 500,
    "preview чужого паспорта",
  );

  const outcome = await service.launchResearch(
    ctxA.userId,
    publicA,
    passport(),
    null,
  );
  assert.equal(outcome.created, true);

  const researchB = await service.getResearch(
    ctxB.userId,
    ctxB.business.public_id,
  );
  assert.equal(researchB.launch, null, "чужой запуск не виден");
  assert.equal(researchB.passport, null);

  // Свой паспорт B по-прежнему работает.
  const savedB = await service.savePassport(
    ctxB.userId,
    ctxB.business.public_id,
    passport({ identification: { displayName: "Свой бизнес Б" } }),
    null,
  );
  assert.equal(savedB.revision, 1);
});

test("Паспорт: неоднозначные источники не выдаются за подтверждённые", async () => {
  const ctx = await scenario(db, "Паспорт неоднозначные");
  const content = passport({
    identification: {
      urls: [{ url: "https://unknown-candidate.example/", role: "candidate" }],
      domains: [],
    },
  });
  const { plan } = await service.previewResearch(
    ctx.userId,
    ctx.business.public_id,
    content,
  );
  assert.equal(plan.identification.hasOfficialUrl, false, "нет официального URL");
  assert.deepEqual(
    plan.officialSources,
    [],
    "кандидат не считается официальным источником",
  );
  assert.equal(plan.needsConfirmation.length, 1, "кандидат требует подтверждения");
});

test("Паспорт: makeUser без бизнеса не получает никаких данных", async () => {
  const stranger = await makeUser(db, "Паспорт чужак");
  const ctx = await scenario(db, "Паспорт владелец");
  await service.savePassport(ctx.userId, ctx.business.public_id, passport(), null);
  await assert.rejects(
    service.getResearch(stranger, ctx.business.public_id),
    (error) => error instanceof AppError && error.status !== 500,
    "пользователь без членства",
  );
});
