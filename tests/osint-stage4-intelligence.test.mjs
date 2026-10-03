/**
 * Stage 4 (§26): Facts → normalization → entity resolution → profile →
 * history → changes → contradictions.
 *
 * E2E на PGlite: детерминированная последовательность из четырёх
 * обогащений (Runs 1–4) над двумя наблюдаемыми источниками одного
 * домена. Проверяются и запись (state-based transitions, идемпотентность
 * §26.9), и чтение — проекция через OsintService.getIntel* (те же
 * методы, что вызывают production routes).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import {
  enqueueEnrichment,
  processQueuedEnrichments,
  runEnrichment,
} from "../src/server/intelligence/osint/enrichment.ts";
import {
  addObservation,
  attachSource,
  createSource,
  makeUser,
  scenario,
} from "./helpers/osint-stage3-fixtures.mjs";
import { AppError } from "../src/server/http/errors.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const service = new OsintService(db);

const PHONE_OLD = "73852551010";
const PHONE_NEW = "73852559999";
const PHONE_B = "73852552233";

const ORIGINS = new Set(["source_context", "source_url", "observation_text"]);

test("Stage 4: intelligence E2E — факты, изменения, противоречия, профиль", async (t) => {
  const ctx = await scenario(db, "Кафе Ромашка");
  const srcA = await createSource(db, "https://romashka.ru/");
  const srcB = await createSource(db, "https://romashka.ru");
  await attachSource(db, ctx.entityId, srcA.sourceId);
  await attachSource(db, ctx.entityId, srcB.sourceId);

  const publicId = ctx.business.public_id;
  let contradictionFirstSeen;

  await t.test("Run 1: первое наблюдение → 4 факта и FIRST_SEEN", async () => {
    await addObservation(db, {
      entityId: ctx.entityId,
      sourceId: srcA.sourceId,
      content:
        `${ctx.label}. Телефон: 8 (3852) 55-10-10. Сайт: https://romashka.ru/`,
      observedAt: new Date("2026-01-10T10:00:00Z"),
    });
    const outcome = await runEnrichment(db, { businessId: ctx.business.id });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.stats.observations, 1);
    assert.equal(outcome.stats.factsExtracted, 4, "имя, телефон, сайт, домен");
    assert.equal(outcome.stats.factsUpdated, 0);
    assert.equal(outcome.stats.factsChanged, 4);
    assert.equal(outcome.stats.contradictionsDetected, 0, "один источник");
    assert.equal(outcome.resolution.status, "AMBIGUOUS");
    assert.equal(outcome.resolution.entityId, ctx.entityId);

    const changes = await service.getIntelChanges(ctx.userId, publicId);
    assert.equal(changes.total, 4);
    assert.ok(
      changes.items.every((change) => change.changeKind === "FIRST_SEEN"),
      "только появления",
    );
    assert.deepEqual(
      new Set(changes.items.map((change) => change.factType)),
      new Set(["business_name", "phone", "website", "domain"]),
    );
  });

  await t.test("Run 2: второй источник → SOURCE_CHANGED и противоречие", async () => {
    await addObservation(db, {
      entityId: ctx.entityId,
      sourceId: srcB.sourceId,
      content:
        `${ctx.label}. Телефон: 8 (3852) 55-22-33. Сайт: https://romashka.ru/`,
      observedAt: new Date("2026-01-11T10:00:00Z"),
    });
    const outcome = await runEnrichment(db, { businessId: ctx.business.id });
    assert.equal(outcome.stats.observations, 2);
    assert.equal(outcome.stats.factsExtracted, 4, "строки источника B");
    assert.equal(outcome.stats.factsUpdated, 4, "строки источника A");
    assert.equal(
      outcome.stats.factsChanged,
      4,
      "FIRST_SEEN телефона + 3 SOURCE_CHANGED",
    );
    assert.equal(outcome.stats.contradictionsDetected, 1, "только телефон");

    const changes = await service.getIntelChanges(ctx.userId, publicId);
    assert.equal(changes.total, 8);
    const kinds = changes.items.map((change) => change.changeKind);
    assert.equal(
      kinds.filter((kind) => kind === "FIRST_SEEN").length,
      5,
      "4 из Run 1 + новый телефон источника B",
    );
    assert.equal(kinds.filter((kind) => kind === "SOURCE_CHANGED").length, 3);

    const contradictions = await service.getIntelContradictions(
      ctx.userId,
      publicId,
    );
    assert.equal(contradictions.contradictions.length, 1);
    const [phoneConflict] = contradictions.contradictions;
    assert.equal(phoneConflict.factType, "phone");
    assert.equal(phoneConflict.status, "unresolved");
    assert.equal(phoneConflict.valueCount, 2);
    assert.equal(phoneConflict.sourceCount, 2);
    assert.deepEqual(
      phoneConflict.sides.map((side) => side.value).sort(),
      [PHONE_OLD, PHONE_B],
    );
    contradictionFirstSeen = phoneConflict.detectedAt;
  });

  await t.test("Run 3: замена значения → VALUE_CHANGED и RETIRED", async () => {
    const obsA2 = await addObservation(db, {
      entityId: ctx.entityId,
      sourceId: srcA.sourceId,
      content:
        `${ctx.label}. Телефон: 8 (3852) 55-99-99. Сайт: https://romashka.ru/`,
      observedAt: new Date("2026-01-12T10:00:00Z"),
    });
    const outcome = await runEnrichment(db, { businessId: ctx.business.id });
    assert.equal(outcome.stats.observations, 2);
    assert.equal(outcome.stats.factsExtracted, 1, "новый телефон источника A");
    assert.equal(outcome.stats.factsUpdated, 7);
    assert.equal(outcome.stats.factsChanged, 1, "ровно один переход");
    assert.equal(outcome.stats.contradictionsDetected, 0, "обновление, не вставка");

    const changes = await service.getIntelChanges(ctx.userId, publicId);
    assert.equal(changes.total, 9);
    const replaced = changes.items.find(
      (change) => change.changeKind === "VALUE_CHANGED",
    );
    assert.ok(replaced, "VALUE_CHANGED записан");
    assert.equal(replaced.factType, "phone");
    assert.equal(replaced.oldValue, PHONE_OLD);
    assert.equal(replaced.newValue, PHONE_NEW);
    assert.ok(replaced.source, "переход привязан к источнику");
    assert.equal(replaced.observationId, obsA2, "новое значение видели здесь");

    const contradictions = await service.getIntelContradictions(
      ctx.userId,
      publicId,
    );
    assert.equal(contradictions.contradictions.length, 1, "строка не дублируется");
    const [updated] = contradictions.contradictions;
    assert.deepEqual(
      updated.sides.map((side) => side.value).sort(),
      [PHONE_B, PHONE_NEW],
      "сторона обновилась",
    );
    assert.equal(
      updated.detectedAt,
      contradictionFirstSeen,
      "detected_at пересчётом не двигается",
    );

    const phonePage = await service.getIntelFacts(ctx.userId, publicId, {
      factType: "phone",
    });
    assert.equal(phonePage.total, 3, "новый + активный B + retired");
    assert.deepEqual(
      phonePage.items.map((fact) => fact.value).sort(),
      [PHONE_OLD, PHONE_B, PHONE_NEW],
    );
    const retired = phonePage.items.find((fact) => fact.status === "RETIRED");
    assert.equal(retired.value, PHONE_OLD);
    assert.equal(retired.source.id, srcA.sourceId);
  });

  await t.test("Run 4: без изменений → идемпотентный пересчёт", async () => {
    const outcome = await runEnrichment(db, { businessId: ctx.business.id });
    assert.equal(outcome.stats.observations, 2);
    assert.equal(outcome.stats.factsExtracted, 0, "ничего не вставлено");
    assert.equal(outcome.stats.factsUpdated, 8, "все активные строки тронуты");
    assert.equal(outcome.stats.factsChanged, 0, "переходов нет");
    assert.equal(outcome.stats.contradictionsDetected, 0, "дубль не вставлен");

    const facts = await service.getIntelFacts(ctx.userId, publicId, {
      limit: "100",
    });
    assert.equal(facts.total, 9, "9 строк: 8 активных + 1 retired");
    assert.equal(
      facts.items.filter((fact) => fact.status === "ACTIVE").length,
      8,
    );
    const changes = await service.getIntelChanges(ctx.userId, publicId);
    assert.equal(changes.total, 9, "лента не разрослась");
    const contradictions = await service.getIntelContradictions(
      ctx.userId,
      publicId,
    );
    assert.equal(contradictions.contradictions.length, 1);
  });

  await t.test("Профиль: «кто это и что о нём известно»", async () => {
    const profile = await service.getIntelProfile(ctx.userId, publicId);
    assert.equal(profile.businessId, ctx.business.id);
    assert.deepEqual(profile.counts, {
      active: 8,
      stale: 0,
      retired: 1,
      changes: 9,
      contradictions: 1,
    });
    assert.deepEqual(profile.names, [ctx.label]);
    assert.deepEqual(profile.phones, [PHONE_B, PHONE_NEW], "только активные");
    assert.deepEqual(profile.websites, ["https://romashka.ru"]);
    assert.deepEqual(profile.domains, ["romashka.ru"]);
    assert.equal(profile.emails.length, 0);
    assert.equal(profile.socials.length, 0);
    assert.deepEqual(
      profile.byType.map((entry) => entry.factType),
      ["business_name", "domain", "phone", "website"],
    );
    assert.ok(
      profile.byType.every((entry) => entry.count === 2),
      "по два источника на значение",
    );
    assert.equal(profile.resolution.status, "AMBIGUOUS");
    assert.equal(profile.resolution.entityId, ctx.entityId);
    assert.ok(
      profile.resolution.signals.some(
        (signal) => signal.signal === "name_exact" && signal.matched,
      ),
      "имя совпало точно",
    );
    assert.equal(profile.lastRun.status, "completed");
    assert.equal(profile.lastRun.stats.factsChanged, 0);
  });

  await t.test("Постраничная выдача фактов с провенансом", async () => {
    const firstPage = await service.getIntelFacts(ctx.userId, publicId, {
      limit: "2",
      offset: "0",
    });
    assert.equal(firstPage.total, 9);
    assert.equal(firstPage.items.length, 2);
    assert.equal(firstPage.limit, 2);
    const secondPage = await service.getIntelFacts(ctx.userId, publicId, {
      limit: "2",
      offset: "2",
    });
    assert.notDeepEqual(
      firstPage.items.map((fact) => fact.id),
      secondPage.items.map((fact) => fact.id),
      "offset разбивает страницы",
    );

    for (const fact of firstPage.items) {
      assert.equal(fact.source.name, "Наблюдаемый источник");
      assert.ok(fact.source.url.length > 0);
      assert.ok(ORIGINS.has(fact.origin), `origin=${fact.origin}`);
      assert.ok(fact.observationId.length > 0, "drill-down к Stage 3");
      assert.match(fact.firstSeenAt, /^\d{4}-\d{2}-\d{2}T/);
    }

    const filtered = await service.getIntelFacts(ctx.userId, publicId, {
      factType: "rating",
    });
    assert.equal(filtered.total, 0, "неизвестный тип — пустая страница");
    assert.deepEqual(filtered.items, []);
  });

  await t.test("Тенантская изоляция read model", async () => {
    const other = await scenario(db, "Пекарня Тенант");
    const otherProfile = await service.getIntelProfile(
      other.userId,
      other.business.public_id,
    );
    assert.deepEqual(otherProfile.counts, {
      active: 0,
      stale: 0,
      retired: 0,
      changes: 0,
      contradictions: 0,
    });
    assert.equal(otherProfile.resolution, null, "обогащения не было");
    const otherFacts = await service.getIntelFacts(
      other.userId,
      other.business.public_id,
    );
    assert.equal(otherFacts.total, 0, "факты tenant A не утекают");

    const stranger = await makeUser(db, "Посторонний");
    await assert.rejects(
      () => service.getIntelProfile(stranger, publicId),
      (error) =>
        error instanceof AppError &&
        error.status === 404 &&
        error.code === "BUSINESS_NOT_FOUND",
      "без членства профиль неотличим от несуществующего бизнеса",
    );
    await assert.rejects(
      () => service.getIntelFacts(stranger, publicId),
      (error) =>
        error instanceof AppError && error.code === "BUSINESS_NOT_FOUND",
    );
  });

  await t.test("Очередь: один активный run и повтор без изменений", async () => {
    const first = await enqueueEnrichment(db, { businessId: ctx.business.id });
    assert.equal(first.created, true);
    const dup = await enqueueEnrichment(db, { businessId: ctx.business.id });
    assert.equal(dup.created, false, "дубль не создаётся");
    assert.equal(dup.runId, first.runId);

    const tick = await processQueuedEnrichments(db, { limit: 1 });
    assert.deepEqual(tick, { processed: 1, completed: 1, failed: 0 });

    const runRow = await db
      .selectFrom("osint_enrichment_runs")
      .selectAll()
      .where("id", "=", first.runId)
      .executeTakeFirstOrThrow();
    assert.equal(runRow.status, "completed");
    assert.equal(Number(runRow.attempts), 1);
    const stats =
      typeof runRow.stats === "string" ? JSON.parse(runRow.stats) : runRow.stats;
    assert.equal(stats.factsExtracted, 0);
    assert.equal(stats.factsUpdated, 8);
    assert.equal(stats.factsChanged, 0);
    assert.equal(stats.contradictionsDetected, 0);

    const profile = await service.getIntelProfile(ctx.userId, publicId);
    assert.deepEqual(
      profile.counts,
      { active: 8, stale: 0, retired: 1, changes: 9, contradictions: 1 },
      "счётчики после воркер-тика не изменились",
    );
    assert.equal(
      (await service.getIntelFacts(ctx.userId, publicId)).total,
      9,
      "строк фактов не прибавилось",
    );
  });

  await t.test("повторное обогащение обновляет происхождение факта", async () => {
    const target = await db
      .selectFrom("osint_intelligence_facts")
      .select(["id", "metadata"])
      .where("business_id", "=", ctx.business.id)
      .where("status", "=", "ACTIVE")
      .executeTakeFirstOrThrow();

    // Симулируем устаревшую провенанс-запись: путь обновления обязан
    // перезаписать origin/run_id свежими значениями, а не оставить
    // первую выдержку (оба update-пути: existing-ветка и doUpdateSet).
    await db
      .updateTable("osint_intelligence_facts")
      .set({ metadata: { origin: "tampered", run_id: "tampered" } })
      .where("id", "=", target.id)
      .execute();

    const enq = await enqueueEnrichment(db, { businessId: ctx.business.id });
    assert.equal(enq.created, true);
    const tick = await processQueuedEnrichments(db, { limit: 1 });
    assert.deepEqual(tick, { processed: 1, completed: 1, failed: 0 });

    const updated = await db
      .selectFrom("osint_intelligence_facts")
      .select("metadata")
      .where("id", "=", target.id)
      .executeTakeFirstOrThrow();
    const metadata =
      typeof updated.metadata === "string"
        ? JSON.parse(updated.metadata)
        : updated.metadata;
    assert.ok(
      ORIGINS.has(metadata.origin),
      `origin=${metadata.origin} после обновления`,
    );
    assert.equal(metadata.run_id, enq.runId, "run_id — свежий запуск");
  });
});
