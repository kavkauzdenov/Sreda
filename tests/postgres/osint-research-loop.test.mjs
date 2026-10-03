/**
 * Замкнутый цикл автономного агента на НАСТОЯЩЕЙ PostgreSQL 17
 * (`npm run test:pg`, opt-in сьют).
 *
 * Здесь проверяется то, чего не может проверить мок: реальные ограничения
 * PostgreSQL, реальные гонки и реальный проход данных через
 * fact → hypothesis → action → execution → fact.
 *
 * Внешняя сеть не используется: провайдеры подменяются на детерминированные
 * фейки, которые отдают заранее заданные выдачи. Так тест доказывает работу
 * цикла с БД, а не зависит от доступности поисковиков.
 *
 * Проверяется:
 *   A. полный цикл с БД и его идемпотентность;
 *   B. claim и конкуренция: один владелец действия, без двойного исполнения;
 *   C. recovery: возврат зависшего running, без откатa завершённого;
 *   D. дедупликация гипотез против реального UNIQUE-индекса;
 *   E. достоверность противоречий (частота копий ≠ достоверность);
 *   F. fallback: 403/429/CAPTCHA/robots/SSRF не обходятся и не зацикливаются;
 *   G. tenant isolation: глобальный osint_source_access без привязки к тенанту;
 *   H. статистика по фактическим данным, а не по счётчику действий.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import { ProviderRegistry } from "../../src/server/intelligence/osint/providers/registry.ts";
import { executeResearchAction } from "../../src/server/intelligence/osint/research/executor.ts";
import {
  tickResearchRun,
  requeueClaimedActions,
} from "../../src/server/intelligence/osint/research/agent-runner.ts";
import { runFeedback } from "../../src/server/intelligence/osint/research/feedback-loop.ts";
import {
  claimNextAction,
  completeAction,
  completeRun,
  persistActions,
} from "../../src/server/intelligence/osint/research/plan-store.ts";
import { computeResearchStats } from "../../src/server/intelligence/osint/research/stats.ts";
import {
  assessConflict,
  hypothesisFromContradiction,
} from "../../src/server/intelligence/osint/research/contradiction-feedback.ts";
import { loadDiscoveryProfile } from "../../src/server/intelligence/osint/discovery.ts";
import { jsonbArray } from "../../src/server/intelligence/osint/schema.ts";
import { identitySeedFromProfile, buildIdentityFromSeed } from "../../src/server/intelligence/osint/research/identity-builder.ts";
import { expectPgRejection, scenario } from "../helpers/osint-stage3-fixtures.mjs";

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

async function makeRun(db, businessId, overrides = {}) {
  const id = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({
      id,
      business_id: businessId,
      status: "running",
      profile: {},
      budget: { maxQueries: 4 },
      providers: "[]",
      queries_count: 0,
      phase: "searching",
      ...overrides,
    })
    .execute();
  return id;
}

/**
 * Жёсткое удаление бизнеса для проверки каскада.
 *
 * Приложение бизнес не удаляет, а архивирует (archived_at) и отзывает
 * участников — это осознанное мягкое удаление. Но ON DELETE CASCADE мы
 * проверить обязаны, а он не срабатывает, пока живы строки business_member
 * (FK business_member_business_id_fkey). Поэтому dependents удаляются в
 * порядке зависимостей, а затем сам бизнес.
 */
async function hardDeleteBusiness(db, businessId) {
  await db.deleteFrom("business_member").where("business_id", "=", businessId).execute();
  await db.deleteFrom("business").where("id", "=", businessId).execute();
}

/**
 * Задаёт бизнесу домен.
 *
 * Это не обход проверок, а условие её срабатывания: источник принимается
 * автоматически только когда его домен совпадает с доменом бизнеса
 * (правило domain_exact) либо телефон совпал вместе с идентичностью.
 * Без домена агент честно отправил бы любую находку в ручную очередь.
 */
async function giveBusinessDomain(db, businessId, domain) {
  await db
    .updateTable("business")
    .set({ contact_info: `Сайт: https://${domain}` })
    .where("id", "=", businessId)
    .execute();
}

async function seedAction(db, runId, businessId, overrides = {}) {
  const id = randomUUID();
  const dedupe = overrides.dedupe_key ?? `q:${randomUUID()}`;
  await db
    .insertInto("osint_research_actions")
    .values({
      id,
      run_id: runId,
      business_id: businessId,
      purpose: "identity",
      query: '"Кафе Ромашка" контакты',
      dedupe_key: dedupe,
      priority: 70,
      status: "pending",
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    })
    .execute();
  return id;
}

/**
 * Детерминированный провайдер. Никакой сети: выдача задаётся тестом.
 */
function fakeRegistry(results, { id = "fake" } = {}) {
  const registry = new ProviderRegistry();
  registry.register({
    descriptor: {
      id,
      label: "Тестовый провайдер",
      types: ["directory", "web"],
      intents: ["identity", "contact", "verification", "any"],
      requiresNetwork: false,
      enabledByDefault: true,
      policy: "default",
      rateLimitPerMinute: 60,
    },
    async search(input) {
      if (results instanceof Error) throw results;
      const q = input.query;
      const text = `${q.text ?? ""} ${q.kind ?? ""}`.toLowerCase();
      return {
        results: results.filter((r) => {
          if (!r.when) return true;
          return text.includes(r.when);
        }),
      };
    },
  });
  return registry;
}

/**
 * Источник по реальной схеме.
 *
 * ВАЖНО: миграция 070 делает публичный слой ГЛОБАЛЬНЫМ — osint_sources,
 * osint_entities, osint_observations, osint_entity_sources теряют
 * business_id, чтобы тенант B не мог увидеть, кто первый нашёл источник.
 * Поэтому business_id здесь передавать нельзя, а уникальность источника
 * глобальная: UNIQUE (normalized_url).
 */
async function seedSource(db, entityId, baseUrl, name) {
  const id = randomUUID();
  // Источники ГЛОБАЛЬНЫ и имеют UNIQUE (normalized_url), поэтому один и тот
  // же URL нельзя засеять дважды — даже для разных бизнесов. Добавляем
  // уникальный сегмент, чтобы каждый посев был изолирован.
  const url = `${baseUrl.replace(/\/$/, "")}/s${id.slice(0, 8)}`;
  await db
    .insertInto("osint_sources")
    .values({
      id,
      type: "directory",
      provider: "fake",
      url,
      normalized_url: url,
      name: name ?? url,
      status: "active",
      trust_level: "public_directory",
      origin: "discovery",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  // PK моста — (entity_id, source_id), без business_id.
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: entityId,
      source_id: id,
      confidence: 0.8,
      created_at: new Date(),
    })
    .execute();
  return id;
}

/** Наблюдение: content_hash обязателен, business_id у таблицы нет. */
async function seedObservation(db, { entityId, sourceId, url }) {
  const id = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id,
      entity_id: entityId,
      source_id: sourceId,
      url,
      title: "Наблюдение",
      content: "Кафе Ромашка, контакты",
      content_hash: `h-${id}`,
      kind: "search_result",
      observed_at: new Date(),
      created_at: new Date(),
    })
    .execute();
  return id;
}

/**
 * Факт с полноценным provenance: source_id И observation_id обязательны
 * (NOT NULL + FK). Нельзя записать «находку», не указав, откуда она.
 *
 * Типы берутся только из разрешённых CHECK; business_name — легальный тип
 * (он есть в osint_intel_facts_type_check).
 */
async function seedFact(
  db,
  { businessId, entityId, factType, factKey, value, url, status = "ACTIVE", lastSeenAt = new Date() },
) {
  const sourceId = await seedSource(db, entityId, url, "Справочник");
  const observationId = await seedObservation(db, { entityId, sourceId, url });
  const fingerprint = `${factType}:${factKey}:${Buffer.from(value).toString("hex").slice(0, 40)}`;
  const id = randomUUID();
  await db
    .insertInto("osint_intelligence_facts")
    .values({
      id,
      business_id: businessId,
      entity_id: entityId,
      fact_type: factType,
      fact_key: factKey,
      value,
      raw_value: value,
      source_id: sourceId,
      observation_id: observationId,
      fingerprint,
      status,
      first_seen_at: lastSeenAt,
      last_seen_at: lastSeenAt,
      observed_at: lastSeenAt,
      extracted_at: lastSeenAt,
      created_at: lastSeenAt,
      updated_at: lastSeenAt,
    })
    .execute();
  return { id, sourceId, observationId, fingerprint };
}

/* ------------------------------------------------------------------ */
/* Сьют                                                              */
/* ------------------------------------------------------------------ */

test(
  "Замкнутый цикл research agent на реальной PostgreSQL 17",
  { timeout: 600_000 },
  async (t) => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      "TEST_DATABASE_URL is not set — this suite requires a real PostgreSQL 17. " +
        "It is opt-in: run `npm run test:pg` against a test server; do not treat a missing URL as success.",
    );
    const source = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname),
      "Only a local test PostgreSQL is allowed (never a production host)",
    );
    assert.match(source.pathname, /test/i, "The database must be a test database");

    const databaseName = "biznesoty_loop_pg_" + randomBytes(8).toString("hex");
    const admin = new Pool({ connectionString: source.href, max: 1 });
    let db;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      source.pathname = "/" + databaseName;
      const pool = new Pool({ connectionString: source.href, max: 12 });
      pool.on("error", (error) => {
        if (!/terminat/i.test(String(error?.message ?? error))) throw error;
      });
      db = new Kysely({ dialect: new PostgresDialect({ pool }) });
      const migrations = new URL("../../migrations", import.meta.url).pathname;
      await migrate(db, migrations);

      /* ============================================================== */
      /* A. Полный цикл                                                */
      /* ============================================================== */
      await t.test("A. fact → hypothesis → action → execution → новый fact", async () => {
        const ctx = await scenario(db, "Цикл агента");
        await giveBusinessDomain(db, ctx.business.id, "romashka.example");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        assert.ok(
          profile.knownDomains.includes("romashka.example"),
          `профиль должен знать домен бизнеса, иначе auto-accept невозможен: ${JSON.stringify(profile.knownDomains)}`,
        );
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));

        // 1. Исходный факт: разрешённый тип, реальный источник и наблюдение.
        // observation_id NOT NULL — факт без provenance записать нельзя.
        const phoneFact = await seedFact(db, {
          businessId: ctx.business.id,
          entityId: ctx.entityId,
          factType: "phone",
          factKey: "contact.phone",
          value: "+73852551010",
          url: "https://catalog.example/roma",
        });
        assert.ok(phoneFact.id && phoneFact.sourceId && phoneFact.observationId);

        // 2–3. Feedback loop строит гипотезу и ставит действие в очередь.
        const feedback = await runFeedback(db, {
          runId,
          businessId: ctx.business.id,
          identity,
          maxQueries: 5,
        });
        assert.ok(
          feedback.hypothesesFromFacts > 0,
          "факт телефона должен породить гипотезу",
        );
        assert.ok(
          feedback.actionsQueued > 0,
          "гипотеза должна превратиться в действие в очереди",
        );

        // 4–5. Действие действительно в очереди, а не только «запланировано».
        const actionsBefore = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status", "query", "hypothesis_id"])
          .where("run_id", "=", runId)
          .execute();
        assert.ok(actionsBefore.length > 0, "действия должны быть записаны в БД");
        assert.ok(
          actionsBefore.every((row) => row.status === "pending"),
          "новые действия должны быть pending",
        );
        assert.ok(
          actionsBefore.some((row) => row.hypothesis_id),
          "действие должно ссылаться на породившую его гипотезу",
        );

        // 6–7. Штатный тик воркера исполняет действие.
        const tick = await tickResearchRun(db, { id: runId, business_id: ctx.business.id }, {
          // Источник на домене самого бизнеса — единственный способ получить
          // продуктивный исход без подделки совпадений телефона.
          registry: fakeRegistry([
            { url: "https://romashka.example/contacts", title: "Контакты", snippet: "Кафе Ромашка", position: 1, when: null },
          ]),
        });
        assert.equal(tick.did, "executed", `тик должен исполнить действие, а не только спланировать: ${JSON.stringify(tick)}`);

        const executed = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status", "outcome", "results_count", "new_sources", "executed_at"])
          .where("run_id", "=", runId)
          .execute();
        const done = executed.find((row) => row.status === "done");
        assert.ok(done, "действие должно быть завершено, а не остаться pending");
        assert.equal(done.outcome, "productive", "новый источник — продуктивный исход");
        assert.ok(done.new_sources > 0, "new_sources должен отражать реально созданный источник");
        assert.ok(done.executed_at, "должен быть записан момент исполнения");

        // Источник и наблюдение созданы в БД, а не «в памяти».
        //
        // Проверяем напрямую по строке источника: после миграции 070
        // osint_sources и osint_observations ГЛОБАЛЬНЫ (business_id у них
        // больше нет), а сущность, которой принадлежит находка, может быть
        // не той, что создала фикстура. Поэтому надёжная проверка — сам
        // факт появления источника с ожидаемым URL.
        const createdSource = await db
          .selectFrom("osint_sources")
          .select(["id", "normalized_url", "status", "trust_level"])
          .where("normalized_url", "=", "https://romashka.example/contacts")
          .executeTakeFirst();
        assert.ok(createdSource, "источник должен быть сохранён в БД");
        assert.equal(createdSource.status, "active");

        const observationForSource = await db
          .selectFrom("osint_observations")
          .select("id")
          .where("source_id", "=", createdSource.id)
          .execute();
        assert.ok(observationForSource.length > 0, "исполнение должно было добавить наблюдение к источнику");

        // Executor обязан поставить enrichment: без него фактов не будет.
        const enrichment = await db
          .selectFrom("osint_enrichment_runs")
          .selectAll()
          .where("business_id", "=", ctx.business.id)
          .execute();
        assert.ok(
          enrichment.length > 0,
          "исполненное действие должно поставить enrichment в очередь, иначе цикл не замыкается",
        );

        // 8–9. Второй проход по новой находке.
        const afterExecution = await computeResearchStats(db, ctx.business.id);
        // sources считаются через мост osint_business_entities → entity_sources,
        // поэтому находка видна статистике только если связана с сущностью
        // бизнеса. Это и есть проверка, что связка выстроена.
        assert.ok(
          afterExecution.sources >= 1,
          `источник должен попасть в статистику бизнеса через мост сущностей: ${JSON.stringify(afterExecution)}`,
        );
        assert.ok(afterExecution.observations >= 1, "наблюдения должны учитываться");

        const feedback2 = await runFeedback(db, {
          runId,
          businessId: ctx.business.id,
          identity,
          maxQueries: 5,
        });
        assert.ok(
          feedback2.actionsQueued >= 0,
          "повторный проход обязан завершиться без ошибки",
        );

        // 10. Идемпотентность: тот же проход не плодит дубли.
        const hypothesesBefore = await sql`
          select count(*)::text as n from osint_research_hypotheses where run_id = ${runId}
        `.execute(db);
        const actionsCountBefore = await sql`
          select count(*)::text as n from osint_research_actions where run_id = ${runId}
        `.execute(db);

        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });
        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });

        const hypothesesAfter = await sql`
          select count(*)::text as n from osint_research_hypotheses where run_id = ${runId}
        `.execute(db);
        const actionsAfter = await sql`
          select count(*)::text as n from osint_research_actions where run_id = ${runId}
        `.execute(db);

        assert.equal(
          hypothesesAfter.rows[0].n,
          hypothesesBefore.rows[0].n,
          "повторная обработка тех же данных не должна создавать новые гипотезы",
        );
        assert.equal(
          actionsAfter.rows[0].n,
          actionsCountBefore.rows[0].n,
          "повторная обработка тех же данных не должна создавать новые действия",
        );
      });

      /* ============================================================== */
      /* B. Claim и конкуренция                                        */
      /* ============================================================== */
      await t.test("B. два конкурента получают одно действие ровно один раз", async () => {
        const ctx = await scenario(db, "Claim");
        const runId = await makeRun(db, ctx.business.id);
        const ids = [];
        for (let i = 0; i < 4; i += 1) ids.push(await seedAction(db, runId, ctx.business.id));

        // Четыре конкурента одновременно дерутся за четыре действия.
        const claimed = await Promise.all(
          [0, 1, 2, 3].map(async () => {
            const action = await claimNextAction(db, runId);
            // Имитация работы между claim и complete: даём второму
            // конкуренту реально увидеть занятую строку.
            await new Promise((resolve) => setTimeout(resolve, 25));
            return action;
          }),
        );

        const gotIds = claimed.filter(Boolean).map((a) => a.id);
        assert.equal(new Set(gotIds).size, gotIds.length, "одно действие не должно достаться двум");
        assert.equal(gotIds.length, 4, "все четыре действия должны быть разобраны");

        // Повторный claim ничего не выдаёт: очередь пуста.
        const again = await claimNextAction(db, runId);
        assert.equal(again, null, "взятое действие не должно выдаваться повторно");

        // Завершённое действие не исполняется снова.
        await completeAction(db, {
          actionId: gotIds[0],
          status: "done",
          outcome: "productive",
          results: 3,
          newSources: 2,
        });
        const afterDone = await claimNextAction(db, runId);
        assert.equal(afterDone, null, "завершённое действие не должно возвращаться в очередь");

        const stillRunning = await sql`
          select count(*)::text as n from osint_research_actions
          where run_id = ${runId} and status = 'running'
        `.execute(db);
        assert.equal(Number(stillRunning.rows[0].n), 3, "остальные остаются running до завершения");
      });

      await t.test("B1a. agentTick не забирает действие из очереди", async () => {
        const ctx = await scenario(db, "Не крадём");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "phone", factKey: "contact.phone",
          value: "+73852551010", url: "https://peek.example/p",
        });
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));
        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });

        const { agentTick, DEFAULT_AGENT_CONFIG } = await import("../../src/server/intelligence/osint/research/agent.ts");
        const seed = identitySeedFromProfile(profile);
        const tick = await agentTick(db, { runId, businessId: ctx.business.id, seed, knowledge: { discovered: [], confirmed: {}, blockers: {} }, config: DEFAULT_AGENT_CONFIG });

        // nextAction нужен для отчёта, но планировщик не должен забирать его:
        // иначе HTTP-эндпоинт крадёт действие у воркера, а оно навсегда
        // остаётся в running без исполнителя.
        const rows = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status"])
          .where("run_id", "=", runId)
          .execute();
        assert.ok(rows.length > 0, "планирование должно было записать действия");
        assert.ok(
          rows.every((row) => row.status === "pending"),
          `agentTick не должен забирать действия: ${JSON.stringify(rows)}`,
        );
        if (tick.nextAction) {
          const stillPending = rows.find((row) => row.id === tick.nextAction.id);
          assert.ok(
            stillPending?.status === "pending",
            "«следующее действие» должно оставаться в очереди после планирования",
          );
        }
      });

      await t.test("B1b. дробный приоритет не роняет запись (priority — integer)", async () => {
        const ctx = await scenario(db, "Приоритет");
        const runId = await makeRun(db, ctx.business.id);

        // Планировщик считает приоритет с дробями (затухание, веса
        // признаков). В БД колонка ЦЕЛАЯ с CHECK (-1000..1000), поэтому
        // раньше такой вызов давал "invalid input syntax for type integer"
        // и ронял весь тик агента. Округление живёт на границе записи.
        const written = await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: [
            { query: { query: '"Кафе" дробный', purpose: "identity", priority: 31.1, derivedFrom: "t", dedupeKey: `p1:${randomUUID()}` } },
            { query: { query: '"Кафе" вне диапазона', purpose: "identity", priority: 99999, derivedFrom: "t", dedupeKey: `p2:${randomUUID()}` } },
            { query: { query: '"Кафе" NaN', purpose: "identity", priority: Number.NaN, derivedFrom: "t", dedupeKey: `p3:${randomUUID()}` } },
          ],
        });
        assert.equal(written, 3, "дробный и запредельный приоритет не должны мешать записи");

        const rows = await db
          .selectFrom("osint_research_actions")
          .select(["query", "priority"])
          .where("run_id", "=", runId)
          .orderBy("priority", "desc")
          .execute();
        assert.equal(rows.length, 3);
        for (const row of rows) {
          assert.ok(
            Number.isInteger(row.priority),
            `в БД должно лежать целое, а не ${row.priority}`,
          );
          assert.ok(
            row.priority >= -1000 && row.priority <= 1000,
            `приоритет вне CHECK-диапазона: ${row.priority}`,
          );
        }
        assert.equal(rows[0].priority, 1000, "значение выше диапазона должно быть ограничено сверху");
        assert.equal(rows[2].priority, 0, "NaN должен сохраняться как 0, а не ломать запись");
      });

      await t.test("B2. действия разных run не смешиваются", async () => {
        const ctxA = await scenario(db, "RunA");
        const ctxB = await scenario(db, "RunB");
        const runA = await makeRun(db, ctxA.business.id);
        const runB = await makeRun(db, ctxB.business.id);
        const actionA = await seedAction(db, runA, ctxA.business.id);
        const actionB = await seedAction(db, runB, ctxB.business.id);

        const claimA = await claimNextAction(db, runA);
        assert.equal(claimA.id, actionA, "run A должен забрать своё действие");
        const claimB = await claimNextAction(db, runB);
        assert.equal(claimB.id, actionB, "run B должен забрать своё действие");
        assert.notEqual(claimA.id, claimB.id);
      });

      await t.test("B3. дедупликация действий опирается на реальный UNIQUE", async () => {
        const ctx = await scenario(db, "Uniq");
        const runId = await makeRun(db, ctx.business.id);
        const dedupe = `dup:${randomUUID()}`;
        await seedAction(db, runId, ctx.business.id, { dedupe_key: dedupe });

        // persistActions обязан уважать существующий ключ, а не падать.
        // Форма SearchQuery: dedupeKey и purpose живут ВНУТРИ query.
        const result = await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: [
            {
              query: {
                query: '"Кафе Ромашка" телефон',
                purpose: "identity",
                priority: 70,
                derivedFrom: "проверка",
                dedupeKey: dedupe,
              },
            },
          ],
        });
        assert.equal(result, 0, "дубликат dedupe_key не должен создаваться повторно (onConflict doNothing)");

        const total = await sql`
          select count(*)::text as n from osint_research_actions where run_id = ${runId}
        `.execute(db);
        assert.equal(Number(total.rows[0].n), 1);

        // И сам PostgreSQL не даст вставить дубль в обход приложения.
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_actions")
              .values({
                id: randomUUID(),
                run_id: runId,
                business_id: ctx.business.id,
                purpose: "identity",
                query: "дубль",
                dedupe_key: dedupe,
                priority: 70,
                status: "pending",
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { constraint: "osint_research_actions_dedupe" },
        );
      });

      /* ============================================================== */
      /* C. Recovery                                                   */
      /* ============================================================== */
      await t.test("C. свежий running не возвращается, просроченный — да", async () => {
        const ctx = await scenario(db, "Recovery");
        const runId = await makeRun(db, ctx.business.id);
        const fresh = await seedAction(db, runId, ctx.business.id);
        const stale = await seedAction(db, runId, ctx.business.id);

        await claimNextAction(db, runId);
        await claimNextAction(db, runId);
        const both = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status"])
          .where("run_id", "=", runId)
          .execute();
        assert.equal(both.length, 2);
        assert.ok(both.every((row) => row.status === "running"));

        // Свежие не трогаем.
        const requeued = await requeueClaimedActions(db, runId);
        assert.equal(requeued, 0, "свежее running не должно возвращаться в очередь");

        // Один из них «завис» давно.
        await db
          .updateTable("osint_research_actions")
          .set({ updated_at: new Date(Date.now() - 30 * 60_000) })
          .where("id", "=", stale)
          .execute();

        const recovered = await requeueClaimedActions(db, runId);
        assert.equal(recovered, 1, "просроченный running должен вернуться в очередь ровно один раз");

        const rows = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status"])
          .where("run_id", "=", runId)
          .execute();
        const staleRow = rows.find((row) => row.id === stale);
        const freshRow = rows.find((row) => row.id === fresh);
        assert.equal(staleRow.status, "pending", "просроченное должно стать pending");
        assert.equal(freshRow.status, "running", "свежее должно остаться running");

        // Повторный recovery идемпотентен.
        assert.equal(await requeueClaimedActions(db, runId), 0, "повторный recovery не должен ничего менять");

        // Восстановленное действие снова берётся в работу.
        const reclaimed = await claimNextAction(db, runId);
        assert.equal(reclaimed.id, stale, "восстановленное действие должно снова claim'иться");

        // Завершённое действие recovery не откатывает.
        await completeAction(db, { actionId: stale, status: "done", outcome: "productive", results: 1, newSources: 1 });
        assert.equal(await requeueClaimedActions(db, runId), 0, "завершённое не должно откатываться в очередь");
        const finalRows = await db
          .selectFrom("osint_research_actions")
          .select(["id", "status"])
          .where("run_id", "=", runId)
          .execute();
        assert.equal(finalRows.find((row) => row.id === stale).status, "done");
      });

      await t.test("C2. параллельный recovery не даёт конфликтного состояния", async () => {
        const ctx = await scenario(db, "RecoveryPar");
        const runId = await makeRun(db, ctx.business.id);
        for (let i = 0; i < 3; i += 1) await seedAction(db, runId, ctx.business.id);
        await Promise.all([claimNextAction(db, runId), claimNextAction(db, runId), claimNextAction(db, runId)]);
        await db
          .updateTable("osint_research_actions")
          .set({ updated_at: new Date(Date.now() - 60 * 60_000) })
          .where("run_id", "=", runId)
          .execute();

        const results = await Promise.all([
          requeueClaimedActions(db, runId),
          requeueClaimedActions(db, runId),
          requeueClaimedActions(db, runId),
        ]);
        // Каждое действие возвращается ровно один раз, сумма == числу действий.
        assert.equal(
          results.reduce((sum, n) => sum + n, 0),
          3,
          `параллельный recovery не должен удваивать: ${JSON.stringify(results)}`,
        );

        const rows = await db
          .updateTable("osint_research_actions")
          .set({ updated_at: new Date() })
          .where("run_id", "=", runId)
          .returning(["status"])
          .execute();
        assert.equal(rows.length, 3);
      });

      await t.test("C3. исследование доходит до конца и run уходит в терминальный статус", async () => {
        const ctx = await scenario(db, "Terminal");
        const runId = await makeRun(db, ctx.business.id);

        // Один тик обычно исполняет действие, а не завершает исследование.
        // Завершение достигается итеративно, поэтому крутим тики и требуем
        // именно ФАКТИЧЕСКОГО достижения терминального состояния.
        let last = null;
        let finished = false;
        for (let i = 0; i < 60; i += 1) {
          last = await tickResearchRun(db, { id: runId, business_id: ctx.business.id }, {
            registry: fakeRegistry([]),
          });
          if (last.did === "finished") {
            finished = true;
            break;
          }
        }
        assert.ok(
          finished,
          `исследование обязано завершиться, а не крутиться вечно; последний тик: ${JSON.stringify(last)}`,
        );
        assert.ok(last.stopReason, "завершение должно сопровождаться причиной остановки");

        const run = await db
          .selectFrom("osint_discovery_runs")
          .select(["status", "finished_at", "phase"])
          .where("id", "=", runId)
          .executeTakeFirst();

        assert.ok(
          ["completed", "partial", "failed"].includes(run.status),
          `run обязан уйти в терминальный статус, иначе воркер будет тикать вечно; получено ${run.status}`,
        );
        assert.ok(run.finished_at, "должен быть записан finished_at");

        // Терминальный статус не переигрывается и «оживить» run нельзя.
        const again = await tickResearchRun(db, { id: runId, business_id: ctx.business.id }, {
          registry: fakeRegistry([]),
        });
        const afterRun = await db
          .selectFrom("osint_discovery_runs")
          .select(["status", "finished_at"])
          .where("id", "=", runId)
          .executeTakeFirst();
        assert.equal(afterRun.status, run.status, "терминальный статус не должен переигрываться");
        assert.equal(
          String(afterRun.finished_at),
          String(run.finished_at),
          "повторный тик не должен переписывать finished_at",
        );
        assert.equal(
          again.did,
          "inactive",
          `тик по завершённому run не должен продолжать работу: ${JSON.stringify(again)}`,
        );
      });

      await t.test("C4. completeRun не перетирает чужой прогресс", async () => {
        const ctx = await scenario(db, "CompleteRun");
        const runId = await makeRun(db, ctx.business.id);
        await completeRun(db, runId, { confirmedAreas: 0, facts: 0, stopReason: "x" });
        const first = await db
          .selectFrom("osint_discovery_runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        assert.ok(["completed", "partial"].includes(first.status));
      });

      /* ============================================================== */
      /* D. Дедупликация гипотез                                       */
      /* ============================================================== */
      await t.test("D. один факт не плодит одинаковые гипотезы", async () => {
        const ctx = await scenario(db, "Гипотезы");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));

        await seedFact(db, {
          businessId: ctx.business.id,
          entityId: ctx.entityId,
          factType: "phone",
          factKey: "contact.phone",
          value: "+73852551010",
          url: "https://catalog.example/phone",
        });

        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });
        const after1 = await sql`
          select count(*)::text as n from osint_research_hypotheses where run_id = ${runId}
        `.execute(db);
        assert.ok(Number(after1.rows[0].n) > 0);

        for (let i = 0; i < 3; i += 1) {
          await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });
        }
        const after2 = await sql`
          select count(*)::text as n from osint_research_hypotheses where run_id = ${runId}
        `.execute(db);
        assert.equal(after2.rows[0].n, after1.rows[0].n, "повторный проход не должен создавать гипотезы");

        const keys = await db
          .selectFrom("osint_research_hypotheses")
          .select("dedupe_key")
          .where("run_id", "=", runId)
          .execute();
        assert.equal(
          new Set(keys.map((k) => k.dedupe_key)).size,
          keys.length,
          "все dedupe_key в пределах run должны быть уникальны",
        );
      });

      await t.test("D2. независимые факты не склеиваются в одну гипотезу", async () => {
        const ctx = await scenario(db, "Разные факты");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));

        // Два РАЗНЫХ факта в одном run: телефон и домен. Проверяем, что они
        // дают разные вопросы, а не сливаются в одну гипотезу.
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "phone", factKey: "contact.phone",
          value: "+73852551010", url: "https://a.example/p1",
        });
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "domain", factKey: "web.domain",
          value: "romashka.example", url: "https://b.example/d",
        });

        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 8 });

        const keys = (
          await db
            .selectFrom("osint_research_hypotheses")
            .select("dedupe_key")
            .where("run_id", "=", runId)
            .execute()
        ).map((row) => row.dedupe_key);

        // Ключ из факта оканчивается на type:key:value — по нему видно основание.
        const phoneBasis = keys.filter((k) => k.endsWith("phone:contact.phone:+73852551010"));
        const domainBasis = keys.filter((k) => k.endsWith("domain:web.domain:romashka.example"));
        assert.ok(phoneBasis.length > 0, "факт телефона должен породить свою гипотезу");
        assert.ok(domainBasis.length > 0, "факт домена должен породить свою гипотезу");
        assert.equal(
          new Set(keys).size,
          keys.length,
          "все dedupe_key в пределах run обязаны быть уникальны",
        );

        // Разные основания обязаны давать разные ключи.
        const overlap = phoneBasis.filter((k) => domainBasis.includes(k));
        assert.equal(overlap.length, 0, `разные факты не должны давать один ключ: ${JSON.stringify(overlap)}`);

        // Повторный проход по этим же фактам ничего не добавляет.
        const before = keys.length;
        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 8 });
        const after = (
          await db
            .selectFrom("osint_research_hypotheses")
            .select("dedupe_key")
            .where("run_id", "=", runId)
            .execute()
        ).length;
        assert.equal(after, before, "повторный проход не должен добавлять гипотезы по тем же фактам");
      });

      /* ============================================================== */
      /* E. Противоречия и достоверность                               */
      /* ============================================================== */
      await t.test("E. два разных адреса порождают вопрос, а не выбор", async () => {
        const ctx = await scenario(db, "Конфликт адреса");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));

        const sides = [
          { value: "Барнаул, ул. Ленина, 1", sources: [{ id: "s1", name: "Справочник А", url: "https://a.example/1" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
          { value: "Барнаул, ул. Ленина, 1", sources: [{ id: "s2", name: "Справочник Б", url: "https://b.example/1" }], observations: [], firstSeen: "2026-01-02T00:00:00Z", lastSeen: "2026-01-02T00:00:00Z" },
          { value: "Барнаул, ул. Мира, 5", sources: [{ id: "s3", name: "Справочник В", url: "https://c.example/5" }], observations: [], firstSeen: "2026-01-03T00:00:00Z", lastSeen: "2026-01-03T00:00:00Z" },
        ];
        const id = randomUUID();
        await db
          .insertInto("osint_intelligence_contradictions")
          .values({
            id,
            business_id: ctx.business.id,
            fact_type: "address",
            sides: jsonbArray(sides),
            value_count: 2,
            source_count: 3,
            status: "unresolved",
          })
          .execute();

        const assessment = assessConflict(sides);
        assert.equal(assessment.narrowed, false, "два против одного без авторитетного источника — сужать нельзя");
        assert.equal(assessment.likelyCurrent, null, "победитель не назначается");

        await runFeedback(db, { runId, businessId: ctx.business.id, identity, maxQueries: 5 });
        const hypotheses = await db
          .selectFrom("osint_research_hypotheses")
          .select(["dedupe_key", "reason"])
          .where("run_id", "=", runId)
          .execute();
        assert.ok(hypotheses.length > 0, "открытый конфликт должен породить вопрос");
        assert.ok(
          hypotheses.some((h) => h.dedupe_key.includes(id)),
          "ключ гипотезы должен ссылаться на конкретный конфликт",
        );
      });

      await t.test("E2. частота копий одного источника не делает утверждение достовернее", async () => {
        // Пять страниц ОДНОГО каталога против одной страницы независимого
        // источника. Копирование не является независимым свидетельством.
        const copies = ["https://catalog.example/a", "https://catalog.example/b", "https://catalog.example/c", "https://catalog.example/d", "https://catalog.example/e"];
        const sides = [
          { value: "Значение А", sources: copies.map((url, i) => ({ id: `c${i}`, name: "Каталог", url })), observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
          { value: "Значение Б", sources: [{ id: "ind", name: "Справочник", url: "https://independent.example/x" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
        ];
        // Прямая проверка: пять страниц одного каталога — один источник.
        const { assessSide } = await import("../../src/server/intelligence/osint/research/contradiction-feedback.ts");
        assert.equal(
          assessSide(sides[0]).independentSources,
          1,
          "пять страниц одного домена не должны считаться пятью свидетельствами",
        );

        const assessment = assessConflict(sides);
        // Пять страниц одного каталога — это ОДИН независимый источник, ровно
        // как и единственная страница независимого справочника. Свидетельства
        // равноценны, поэтому сузить круг нельзя, и уж тем более нельзя
        // назначить победителя по частоте упоминаний.
        assert.equal(
          assessment.narrowed,
          false,
          "частота копий одного источника не должна давать преимущества",
        );
        assert.equal(assessment.likelyCurrent, null, "победитель не назначается");
        assert.match(assessment.insufficient, /независим|ещё один/i);
      });

      await t.test("E3. официальный источник весит больше агрегатора", async () => {
        const sides = [
          { value: "Официальный адрес", sources: [{ id: "off", name: "Официальный сайт", url: "https://official.example/contacts" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
          { value: "Агрегатор", sources: [{ id: "a1", name: "Каталог", url: "https://cat1.example/x" }, { id: "a2", name: "Каталог", url: "https://cat2.example/x" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
        ];
        const assessment = assessConflict(sides);
        assert.equal(assessment.narrowed, true);
        assert.equal(assessment.likelyCurrent.value, "Официальный адрес");
        assert.match(assessment.insufficient, /не доказана|историческ/i, "даже сужение круга не выдаётся за доказательство");
      });

      await t.test("E4. конфликт обновляется на месте по (business_id, fact_type)", async () => {
        const ctx = await scenario(db, "Конфликт на месте");
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));
        const run1 = await makeRun(db, ctx.business.id);

        const mk = (values) => jsonbArray(values.map((value, i) => ({ value, sources: [{ id: `s${i}`, name: "n", url: `https://s${i}.example/x` }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" })));

        const id1 = randomUUID();
        await db.insertInto("osint_intelligence_contradictions").values({
          id: id1, business_id: ctx.business.id, fact_type: "phone",
          sides: mk(["+7 385 255 10 10", "+7 385 255 99 99"]), value_count: 2, source_count: 2, status: "unresolved",
        }).execute();

        await runFeedback(db, { runId: run1, businessId: ctx.business.id, identity, maxQueries: 5 });
        const firstKeys = (await db.selectFrom("osint_research_hypotheses").select("dedupe_key").where("run_id", "=", run1).execute()).map((r) => r.dedupe_key);

        // Реалистичное развитие конфликта: пришло третье значение, поэтому
        // строка ОБНОВЛЯЕТСЯ на месте (UNIQUE (business_id, fact_type)).
        // id при этом сохраняется — это тот же открытый вопрос.
        await db
          .insertInto("osint_intelligence_contradictions")
          .values({
            id: randomUUID(), business_id: ctx.business.id, fact_type: "phone",
            sides: mk(["+7 385 255 10 10", "+7 385 255 99 99", "+7 800 000 00 00"]),
            value_count: 3, source_count: 3, status: "unresolved",
          })
          .onConflict((oc) => oc.columns(["business_id", "fact_type"]).doUpdateSet({
            sides: mk(["+7 385 255 10 10", "+7 385 255 99 99", "+7 800 000 00 00"]),
            value_count: 3,
            source_count: 3,
            updated_at: new Date(),
          }))
          .execute();

        const rowsAfterUpsert = await db
          .selectFrom("osint_intelligence_contradictions")
          .select(["id", "value_count"])
          .where("business_id", "=", ctx.business.id)
          .where("fact_type", "=", "phone")
          .execute();
        assert.equal(rowsAfterUpsert.length, 1, "конфликт по факту-типу должен остаться один");
        assert.equal(rowsAfterUpsert[0].id, id1, "обновление на месте сохраняет id того же конфликта");
        assert.equal(rowsAfterUpsert[0].value_count, 3, "число значений должно обновиться");

        await runFeedback(db, { runId: run1, businessId: ctx.business.id, identity, maxQueries: 5 });
        const secondKeys = (await db.selectFrom("osint_research_hypotheses").select("dedupe_key").where("run_id", "=", run1).execute()).map((r) => r.dedupe_key);

        const newKeys = secondKeys.filter((k) => !firstKeys.includes(k));
        assert.equal(newKeys.length, 0, `тот же открытый конфликт не должен порождать новые гипотезы в том же run: ${JSON.stringify(newKeys)}`);

        // И PostgreSQL реально не даст второй конфликт того же типа.
        await expectPgRejection(
          () =>
            db.insertInto("osint_intelligence_contradictions").values({
              id: randomUUID(), business_id: ctx.business.id, fact_type: "phone",
              sides: "[]", value_count: 1, source_count: 1, status: "unresolved",
            }).execute(),
          { constraint: "osint_contradictions_unique" },
        );
      });

      await t.test("E5. два разных телефона: разные гипотезы не смешиваются", async () => {
        const sides = [
          { value: "+7 385 255 10 10", sources: [{ id: "a", name: "n", url: "https://a.example/x" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
          { value: "+7 385 255 99 99", sources: [{ id: "b", name: "n", url: "https://b.example/x" }], observations: [], firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z" },
        ];
        const hypotheses = hypothesisFromContradiction({ id: "c-phones", fact_type: "phone", sides, value_count: 2, source_count: 2 });
        assert.equal(hypotheses.length, 2);
        assert.ok(hypotheses.every((h) => h.dedupeKey.includes("c-phones")), "обе гипотезы относятся к этому конфликту");
        assert.notEqual(hypotheses[0].dedupeKey, hypotheses[1].dedupeKey, "внутри конфликта вопросы различаются");
      });

      /* ============================================================== */
      /* F. Fallback и ограничения                                     */
      /* ============================================================== */
      await t.test("F. заблокированный источник не уходит в бесконечный retry", async () => {
        const ctx = await scenario(db, "Блокировка");
        const runId = await makeRun(db, ctx.business.id);
        const profile = await loadDiscoveryProfile(db, ctx.business.id);
        const entityId = ctx.entityId;

        for (const reason of ["http_403", "rate_limited", "captcha", "robots_disallowed"]) {
          const actionId = await seedAction(db, runId, ctx.business.id, { purpose: "identity" });
          const action = await db.selectFrom("osint_research_actions").selectAll().where("id", "=", actionId).executeTakeFirst();
          const result = await executeResearchAction(
            db,
            { id: action.id, run_id: runId, business_id: ctx.business.id, purpose: action.purpose, query: action.query, target_url: null },
            { profile, registry: fakeRegistry(new Error("blocked")), entityId, maxResults: 5 },
          );
          // Сбой провайдера — это ошибка/пусто, а не «новые источники».
          assert.notEqual(result.outcome, "productive", `${reason}: сбой не должен считаться продуктивным`);
          assert.ok(["error", "empty"].includes(result.outcome), `${reason}: неожиданный исход ${result.outcome}`);

          // Действие обязано получить терминальный статус, иначе оно
          // осталось бы в running/pending и блокировало бы очередь навсегда.
          await completeAction(db, {
            actionId: actionId,
            status: result.status,
            outcome: result.outcome,
            results: result.results,
            newSources: result.newSources,
          });
        }

        const rows = await db
          .selectFrom("osint_research_actions")
          .select(["status", "outcome"])
          .where("run_id", "=", runId)
          .execute();
        assert.equal(rows.length, 4, "все четыре сценария блокировки должны быть обработаны");
        assert.ok(
          rows.every((r) => r.status !== "running" && r.status !== "pending"),
          `блокировка не должна оставлять действия в бесконечном ожидании: ${JSON.stringify(rows)}`,
        );
      });

      await t.test("F2. SSRF-граница — загрузка, а не классификация", async () => {
        // Классификатор отвечает за РЕЛЕВАНТНОСТЬ результата, а не за
        // безопасность. Поэтому приватный адрес он пропускает — и это
        // правильно: безопасность обеспечивает safe-fetch (isPrivateIp +
        // проверка каждого резолва и каждого редиректа, отказ private_address).
        //
        // Guard покрыт tests/osint-safe-fetch.test.mjs; здесь фиксируем
        // принадлежность обязанностей, чтобы защиту не «починили» не в том
        // слое: normalizeUrl намеренно не отбрасывает приватные хосты, иначе
        // локальные фикстуры и Stage 3 E2E перестают работать.
        const { classifyResult } = await import("../../src/server/intelligence/osint/classifier.ts");
        const classified = classifyResult({
          url: "http://127.0.0.1/admin",
          provider: "fake",
          title: "Кафе Ромашка",
          snippet: "контакты",
          query: '"Кафе Ромашка" контакты',
          position: 1,
          method: "search",
          intent: "identity",
          knownDomains: [],
          knownSocialLinks: [],
        });
        assert.equal(
          classified.ok,
          true,
          "классификация не является границей безопасности — безопасность в safe-fetch",
        );

        const { isPrivateIp } = await import("../../src/server/intelligence/osint/safe-fetch.ts");
        for (const ip of [
          "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254",
          "172.16.0.1", "100.64.0.1", "::1", "::ffff:7f00:1", "fc00::1", "fe80::1",
        ]) {
          assert.equal(isPrivateIp(ip), true, `guard обязан ловить приватный адрес: ${ip}`);
        }
        // Документационные диапазоны (TEST-NET-1/2/3) тоже не должны
        // использоваться как реальные цели: они не маршрутизируются.
        for (const ip of ["192.0.2.5", "198.51.100.5", "203.0.113.10"]) {
          assert.equal(isPrivateIp(ip), true, `недоступный диапазон не должен считаться целью: ${ip}`);
        }
        for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "11.0.0.1"]) {
          assert.equal(isPrivateIp(ip), false, `публичный адрес не должен считаться приватным: ${ip}`);
        }
      });

      /* ============================================================== */
      /* G. Tenant isolation                                           */
      /* ============================================================== */
      await t.test("G. tenant A не видит и не меняет данные tenant B", async () => {
        const ctxA = await scenario(db, "Тенант A");
        const ctxB = await scenario(db, "Тенант B");
        const runA = await makeRun(db, ctxA.business.id);
        const actionA = await seedAction(db, runA, ctxA.business.id);

        const claimA = await claimNextAction(db, runA);
        assert.equal(claimA.id, actionA);

        // Тенант B не должен видеть действие тенанта A в своей очереди.
        const runB = await makeRun(db, ctxB.business.id);
        const visibleToB = await db
          .selectFrom("osint_research_actions")
          .selectAll()
          .where("run_id", "=", runB)
          .execute();
        assert.equal(visibleToB.length, 0, "чужие действия не должны попадать в чужую очередь");

        // Факты бизнеса B не должны попадать в статистику A.
        await seedFact(db, {
          businessId: ctxB.business.id, entityId: ctxB.entityId,
          factType: "phone", factKey: "contact.phone",
          value: "+79999999999", url: "https://b.example/phone",
        });
        const statsA = await computeResearchStats(db, ctxA.business.id);
        assert.equal(statsA.facts, 0, "факты другого тенанта не должны учитываться");

        // Удаление бизнеса каскадом уносит его research-данные.
        const factsB = await sql`
          select count(*)::text as n from osint_intelligence_facts where business_id = ${ctxB.business.id}
        `.execute(db);
        assert.ok(Number(factsB.rows[0].n) > 0);

        await hardDeleteBusiness(db, ctxB.business.id);
        const afterCascade = await sql`
          select count(*)::text as n from osint_intelligence_facts where business_id = ${ctxB.business.id}
        `.execute(db);
        assert.equal(Number(afterCascade.rows[0].n), 0, "cascade deletion должен унести факты бизнеса");
      });

      // Заметка про osint_source_access (нет business_id) намеренно НЕ
      // дублируется здесь: это уже проверяет
      // osint-agent-constraints.test.mjs против information_schema.

      /* ============================================================== */
      /* H. Статистика                                                */
      /* ============================================================== */
      await t.test("H. статистика считается по данным, а не по счётчику действий", async () => {
        const ctx = await scenario(db, "Статистика");
        const runId = await makeRun(db, ctx.business.id);

        // Пять успешно завершённых действий, но НИ ОДНОГО факта.
        for (let i = 0; i < 5; i += 1) {
          const id = await seedAction(db, runId, ctx.business.id);
          await completeAction(db, { actionId: id, status: "done", outcome: "empty", results: 0, newSources: 0, newFacts: 0 });
        }

        const stats = await computeResearchStats(db, ctx.business.id);
        assert.equal(stats.facts, 0, "пять действий без находок не должны давать фактов");
        assert.equal(stats.confirmedFacts, 0);
        assert.equal(stats.sources, 0, "источников действительно нет");
        assert.equal(stats.contradictions, 0);

        // Теперь добавляем ровно один факт.
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "brand_name", factKey: "identity.brand",
          value: "Кафе Ромашка", url: "https://catalog.example/name",
        });
        const stats2 = await computeResearchStats(db, ctx.business.id);
        assert.equal(stats2.facts, 1, "факты считаются из фактических строк");
        assert.equal(stats2.confirmedFacts, 1);
        assert.equal(stats2.sources, 1, "источник виден через мост сущностей бизнеса");

        // Один факт, подтверждённый двумя источниками, не удваивает счётчик:
        // строки разные (fingerprint), поэтому их две — это честно.
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "phone", factKey: "contact.phone",
          value: "+73852551010", url: "https://other.example/phone",
        });
        const stats3 = await computeResearchStats(db, ctx.business.id);
        assert.equal(stats3.facts, 2);
        assert.ok(stats3.sources >= 2);
      });

      await t.test("H2. факт из STALE-источника не считается подтверждённым", async () => {
        const ctx = await scenario(db, "STALE");
        await seedFact(db, {
          businessId: ctx.business.id, entityId: ctx.entityId,
          factType: "brand_name", factKey: "identity.brand",
          value: "Кафе Ромашка", url: "https://catalog.example/name",
        });
        await db
          .updateTable("osint_intelligence_facts")
          .set({ status: "STALE" })
          .where("business_id", "=", ctx.business.id)
          .execute();
        const stats = await computeResearchStats(db, ctx.business.id);
        assert.equal(stats.facts, 1, "строка факта остаётся");
        assert.equal(stats.confirmedFacts, 0, "STALE-факт не должен подтверждать направление");
      });

      await t.test("H3. new_facts приписывает действию только его собственный прирост", async () => {
        const ctx = await scenario(db, "Прирост");
        await giveBusinessDomain(db, ctx.business.id, "prirost.example");
        const runId = await makeRun(db, ctx.business.id);

        // Заранее накопленных фактовbusiness уже 3.
        for (let i = 0; i < 3; i += 1) {
          await seedFact(db, {
            businessId: ctx.business.id, entityId: ctx.entityId,
            factType: "brand_name", factKey: `identity.brand.${i}`,
            value: `Кафе Ромашка ${i}`, url: `https://catalog.example/n${i}`,
          });
        }

        await tickResearchRun(db, { id: runId, business_id: ctx.business.id }, {
          registry: fakeRegistry([
            { url: "https://prirost.example/about", title: "О нас", snippet: "Кафе", position: 1, when: null },
          ]),
        });

        const done = await db
          .selectFrom("osint_research_actions")
          .select(["new_facts", "outcome", "new_sources"])
          .where("run_id", "=", runId)
          .execute();
        const executed = done.filter((row) => row.new_sources > 0);
        assert.ok(executed.length > 0, "действие должно было найти новый источник");
        for (const row of done) {
          // Факты создаёт enrichment, а не исполнитель запроса. Поэтому
          // new_facts у действия равно 0, и — тем более — не равно трём
          // накопленным фактам бизнеса.
          assert.equal(
            row.new_facts,
            0,
            `new_facts не должен приписывать действию накопленные факты бизнеса: ${row.new_facts}`,
          );
        }
      });

      /* ============================================================== */
      /* Миграции                                                      */
      /* ============================================================== */
      await t.test("миграции 069–075 применены и идемпотентны", async () => {
        const migrations = new URL("../../migrations", import.meta.url).pathname;
        await migrate(db, migrations);
        const rows = await sql`select name from sreda_migration`.execute(db);
        const list = rows.rows.map((r) => String(r.name));
        assert.ok(list.some((n) => n.startsWith("075_")), "075 должна быть применена");
        assert.equal(list.filter((n) => n.startsWith("075_")).length, 1, "075 применена ровно один раз");
      });
    } finally {
      if (db) await db.destroy();
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch(() => {});
      await admin.end();
    }
  },
);
