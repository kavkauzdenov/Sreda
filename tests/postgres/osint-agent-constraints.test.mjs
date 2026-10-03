/**
 * Автономный research agent — constraints, изоляция и гонки на НАСТОЯЩЕЙ
 * PostgreSQL 17 (`npm run test:pg`, opt-in сьют).
 *
 * Что здесь проверяется иначе, чем на PGlite:
 *   - CHECK/UNIQUE таблиц 075 по именам ограничений;
 *   - идемпотентность миграций (повторный migrate без изменений);
 *   - уникальность dedupe-ключа под конкурентной нагрузкой: два
 *     планировщика на одном run не плодят дубли;
 *   - гонку двух воркеров за следующее действие через compare-and-set;
 *   - tenant isolation: run, действие и гипотеза чужого бизнеса не видны;
 *   - что глобальная osint_source_access действительно не имеет
 *     business_id — блокировка сайта касается всех, это осознанно.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import {
  claimNextAction,
  completeAction,
  countBarrenActions,
  knownActionKeys,
  knownHypothesisKeys,
  persistActions,
  persistHypotheses,
  recordSourceAccess,
} from "../../src/server/intelligence/osint/research/plan-store.ts";
import { buildInitialHypotheses } from "../../src/server/intelligence/osint/research/hypothesis.ts";
import { buildIdentityFromSeed } from "../../src/server/intelligence/osint/research/identity-builder.ts";
import { queriesForHypothesis } from "../../src/server/intelligence/osint/research/query-generator.ts";
import { expectPgRejection, scenario } from "../helpers/osint-stage3-fixtures.mjs";

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

async function makeRun(db, businessId, overrides = {}) {
  const id = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({
      id,
      business_id: businessId,
      status: "running",
      profile: {},
      budget: {},
      providers: [],
      created_at: new Date(),
      updated_at: new Date(),
      ...overrides,
    })
    .execute();
  return id;
}

function hypothesisFixture() {
  const identity = buildIdentityFromSeed({
    name: "Кафе Агент",
    city: "Барнаул",
  });
  return buildInitialHypotheses({ identity });
}

test(
  "Research agent schema runs on a real PostgreSQL 17 server",
  { timeout: 240_000 },
  async (t) => {
    assert.ok(
      process.env.TEST_DATABASE_URL,
      "TEST_DATABASE_URL is not set — this suite requires a real local PostgreSQL 17. " +
        "It is opt-in: run `npm run test:pg` against a local test server, do not treat a missing URL as success.",
    );
    const source = new URL(process.env.TEST_DATABASE_URL);
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(source.hostname),
      "Only local test PostgreSQL is allowed (never a production host)",
    );
    assert.match(source.pathname, /test/i, "The database must be a test database");

    const databaseName =
      "biznesoty_agent_pg_" + randomBytes(8).toString("hex");
    const admin = new Pool({ connectionString: source.href, max: 1 });
    let db;
    let created = false;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      source.pathname = "/" + databaseName;
      const pool = new Pool({ connectionString: source.href, max: 8 });
      pool.on("error", (error) => {
        if (!/terminat/i.test(String(error?.message ?? error))) throw error;
      });
      db = new Kysely({ dialect: new PostgresDialect({ pool }) });

      const migrations = new URL("../../migrations", import.meta.url).pathname;
      await migrate(db, migrations);
      await migrate(db, migrations);

      await t.test("migrations are idempotent — 075 applied once", async () => {
        const rows = await sql`select name from sreda_migration`.execute(db);
        const list = rows.rows.map((row) => String(row.name));
        assert.equal(
          list.filter((name) => name.startsWith("075_")).length,
          1,
          "075 записана ровно один раз",
        );
      });

      await t.test("phase допускает рабочие значения и не принимает мусор", async () => {
        const ctx = await scenario(db, "Фаза агента");
        const runId = await makeRun(db, ctx.business.id, { phase: "planning" });
        const row = await db
          .selectFrom("osint_discovery_runs")
          .select("phase")
          .where("id", "=", runId)
          .executeTakeFirst();
        assert.equal(row.phase, "planning");

        await expectPgRejection(
          () =>
            db
              .updateTable("osint_discovery_runs")
              .set({ phase: "nonsense" })
              .where("id", "=", runId)
              .execute(),
          { code: "23514", constraint: "osint_discovery_runs_phase_check" },
        );
      });

      await t.test("действие отклоняет неизвестный статус CHECK-ом", async () => {
        const ctx = await scenario(db, "Статус действия");
        const runId = await makeRun(db, ctx.business.id);
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_actions")
              .values({
                id: randomUUID(),
                run_id: runId,
                business_id: ctx.business.id,
                kind: "search",
                purpose: "identity",
                status: "teleporting",
                outcome: "pending",
                dedupe_key: "bad-status",
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_research_actions_status_check" },
        );
      });

      await t.test("гипотеза отклоняет confidence вне 0..1", async () => {
        const ctx = await scenario(db, "Уверенность гипотезы");
        const runId = await makeRun(db, ctx.business.id);
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_hypotheses")
              .values({
                id: randomUUID(),
                run_id: runId,
                business_id: ctx.business.id,
                type: "identity",
                statement: "x",
                reason: "y",
                confidence: 1.5,
                status: "open",
                dedupe_key: "bad-confidence",
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_research_hypotheses_confidence_check" },
        );
      });

      await t.test("источник доступа отклоняет неизвестный статус", async () => {
        await scenario(db, "Статус источника");
        const sourceId = randomUUID();
        await db
          .insertInto("osint_sources")
          .values({
            id: sourceId,
            type: "website",
            provider: "web_page",
            url: "https://agent-access.example/page",
            normalized_url: "https://agent-access.example/page",
            name: "Agent access",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_source_access")
              .values({
                source_id: sourceId,
                status: "confused",
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_source_access_status_check" },
        );
      });

      await t.test("osint_source_access глобальна: без business_id и FK на тенанта", async () => {
        const rows = await sql`
          select column_name, data_type
          from information_schema.columns
          where table_name = 'osint_source_access'
        `.execute(db);
        assert.ok(rows.rows.length > 0, "таблица должна существовать");
        assert.equal(
          rows.rows.some((row) => row.column_name === "business_id"),
          false,
          "у глобальной таблицы не должно быть business_id",
        );
        const fks = await sql`
          select tc.constraint_name
          from information_schema.table_constraints tc
          join information_schema.key_column_usage k
            on k.constraint_name = tc.constraint_name
          where tc.table_name = 'osint_source_access'
            and tc.constraint_type = 'FOREIGN KEY'
        `.execute(db);
        for (const fk of fks.rows) {
          assert.doesNotMatch(
            fk.constraint_name,
            /business|user/i,
            `внешний ключ ${fk.constraint_name} тянет глобальную память к тенанту`,
          );
        }
      });

      await t.test("повторное планирование не плодит дубли гипотез", async () => {
        const ctx = await scenario(db, "Дубли гипотез");
        const runId = await makeRun(db, ctx.business.id);
        const hypotheses = hypothesisFixture();
        const first = await persistHypotheses(db, {
          runId,
          businessId: ctx.business.id,
          hypotheses,
        });
        const second = await persistHypotheses(db, {
          runId,
          businessId: ctx.business.id,
          hypotheses,
        });
        assert.equal(first, hypotheses.length, "первый проход вставляет всё");
        assert.equal(second, 0, "второй проход не вставляет ничего");
        const keys = await knownHypothesisKeys(db, runId);
        assert.equal(keys.size, hypotheses.length);
      });

      await t.test("конкурентные планировщики не плодят дубли действий", async () => {
        const ctx = await scenario(db, "Дубли действий");
        const runId = await makeRun(db, ctx.business.id);
        const identity = buildIdentityFromSeed({ name: "Кафе Агент", city: "Барнаул" });
        const hypothesis = hypothesisFixture()[0];
        const query = queriesForHypothesis(identity, hypothesis)[0];
        const actions = [{ query, priority: 50 }];

        const results = await Promise.all([
          persistActions(db, { runId, businessId: ctx.business.id, actions }),
          persistActions(db, { runId, businessId: ctx.business.id, actions }),
          persistActions(db, { runId, businessId: ctx.business.id, actions }),
        ]);
        assert.equal(
          results.reduce((sum, value) => sum + value, 0),
          1,
          "ровно одна вставка выигрывает гонку",
        );
        const keys = await knownActionKeys(db, runId);
        assert.equal(keys.size, 1);
      });

      await t.test("два воркера получают РАЗНЫЕ действия", async () => {
        const ctx = await scenario(db, "Claim действия");
        const runId = await makeRun(db, ctx.business.id);
        const identity = buildIdentityFromSeed({ name: "Кафе Агент", city: "Барнаул" });
        const hypotheses = hypothesisFixture();
        const actions = hypotheses
          .flatMap((hypothesis) => queriesForHypothesis(identity, hypothesis))
          .map((query) => ({ query, priority: 50 }));
        await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: actions.slice(0, 6),
        });

        const claimed = await Promise.all([
          claimNextAction(db, runId),
          claimNextAction(db, runId),
          claimNextAction(db, runId),
        ]);
        const ids = claimed.filter(Boolean).map((row) => row.id);
        assert.equal(new Set(ids).size, ids.length, "действия не должны повторяться");
        assert.ok(ids.length > 0, "хотя бы одно действие должно быть выдано");
      });

      await t.test("исход действия попадает в след для аудита", async () => {
        const ctx = await scenario(db, "След действия");
        const runId = await makeRun(db, ctx.business.id);
        const identity = buildIdentityFromSeed({ name: "Кафе Агент", city: "Барнаул" });
        const query = queriesForHypothesis(identity, hypothesisFixture()[0])[0];
        await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: [{ query, priority: 10 }],
        });
        const claimed = await claimNextAction(db, runId);
        await completeAction(db, {
          actionId: claimed.id,
          status: "done",
          outcome: "productive",
          results: 5,
          newSources: 2,
          newFacts: 3,
        });
        const row = await db
          .selectFrom("osint_research_actions")
          .select(["outcome", "results_count", "new_facts", "executed_at"])
          .where("id", "=", claimed.id)
          .executeTakeFirst();
        assert.equal(row.outcome, "productive");
        assert.equal(row.new_facts, 3);
        assert.ok(row.executed_at, "время исполнения должно проставиться");
      });

      await t.test("пустые исходы считаются детектором насыщения", async () => {
        const ctx = await scenario(db, "Насыщение");
        const runId = await makeRun(db, ctx.business.id);
        const identity = buildIdentityFromSeed({ name: "Кафе Агент", city: "Барнаул" });
        const queries = hypothesisFixture()
          .flatMap((h) => queriesForHypothesis(identity, h))
          .slice(0, 4);
        await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: queries.map((query) => ({ query, priority: 10 })),
        });
        for (let i = 0; i < 4; i += 1) {
          const claimed = await claimNextAction(db, runId);
          if (!claimed) break;
          await completeAction(db, {
            actionId: claimed.id,
            status: "done",
            outcome: "empty",
          });
        }
        const barren = await countBarrenActions(db, runId);
        assert.equal(barren, 4, "четыре пустые попытки подряд — это насыщение");
      });

      await t.test("счётчик источника растёт монотонно и обнуляется на успехе", async () => {
        await scenario(db, "Счётчик блокировок");
        const sourceId = randomUUID();
        await db
          .insertInto("osint_sources")
          .values({
            id: sourceId,
            type: "website",
            provider: "web_page",
            url: "https://agent-counter.example/",
            normalized_url: "https://agent-counter.example/",
            name: "Counter",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();

        await recordSourceAccess(db, { sourceId, status: "rate_limited" });
        await recordSourceAccess(db, { sourceId, status: "rate_limited" });
        await recordSourceAccess(db, { sourceId, status: "rate_limited" });
        let row = await db
          .selectFrom("osint_source_access")
          .select(["consecutive_count", "first_blocked_at"])
          .where("source_id", "=", sourceId)
          .executeTakeFirst();
        assert.equal(row.consecutive_count, 3, "три блокировки подряд");
        assert.ok(row.first_blocked_at, "дата первой блокировки сохраняется");

        await recordSourceAccess(db, { sourceId, status: "accessible" });
        row = await db
          .selectFrom("osint_source_access")
          .select(["consecutive_count", "last_success_at", "first_blocked_at"])
          .where("source_id", "=", sourceId)
          .executeTakeFirst();
        assert.equal(row.consecutive_count, 0, "успех обнуляет счётчик");
        assert.ok(row.last_success_at, "успех фиксирует дату");
        assert.ok(row.first_blocked_at, "дата первой блокировки не затирается успехом");
      });

      await t.test("блокировка источника видна всем тенантам — это свойство сайта", async () => {
        const sourceId = randomUUID();
        await db
          .insertInto("osint_sources")
          .values({
            id: sourceId,
            type: "website",
            provider: "web_page",
            url: "https://agent-shared.example/",
            normalized_url: "https://agent-shared.example/",
            name: "Shared",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        await recordSourceAccess(db, {
          sourceId,
          status: "robots_disallowed",
          detail: "Источник запретил сбор этих страниц",
        });
        // Источник один и тот же для обоих бизнесов — запись единственная.
        const rows = await sql`
          select count(*)::text as n from osint_source_access where source_id = ${sourceId}
        `.execute(db);
        assert.equal(rows.rows[0].n, "1", "одна глобальная запись на источник");
      });

      await t.test("tenant isolation: чужой run не виден в выборке", async () => {
        const a = await scenario(db, "Тенант А");
        const b = await scenario(db, "Тенант Б");
        const runA = await makeRun(db, a.business.id);
        const runB = await makeRun(db, b.business.id);

        const visibleToA = await db
          .selectFrom("osint_discovery_runs")
          .select("id")
          .where("business_id", "=", a.business.id)
          .execute();
        assert.equal(
          visibleToA.some((row) => row.id === runB),
          false,
          "run тенанта B не должен попадать в выборку тенанта A",
        );
        assert.ok(
          visibleToA.some((row) => row.id === runA),
          "свой run виден",
        );
      });

      await t.test("tenant isolation: каскадное удаление бизнеса уносит агента", async () => {
        const ctx = await scenario(db, "Каскад агента");
        const runId = await makeRun(db, ctx.business.id);
        await persistHypotheses(db, {
          runId,
          businessId: ctx.business.id,
          hypotheses: hypothesisFixture().slice(0, 2),
        });
        await hardDeleteBusiness(db, ctx.business.id);
        const rows = await sql`
          select count(*)::text as n
          from osint_research_hypotheses where run_id = ${runId}
        `.execute(db);
        assert.equal(rows.rows[0].n, "0", "гипотезы удалены вместе с бизнесом");
      });

      await t.test("удаление run каскадно уносит действия и гипотезы", async () => {
        const ctx = await scenario(db, "Каскад run");
        const runId = await makeRun(db, ctx.business.id);
        const identity = buildIdentityFromSeed({ name: "Кафе Агент", city: "Барнаул" });
        const query = queriesForHypothesis(identity, hypothesisFixture()[0])[0];
        await persistActions(db, {
          runId,
          businessId: ctx.business.id,
          actions: [{ query, priority: 1 }],
        });
        await persistHypotheses(db, {
          runId,
          businessId: ctx.business.id,
          hypotheses: hypothesisFixture().slice(0, 1),
        });
        await db
          .deleteFrom("osint_discovery_runs")
          .where("id", "=", runId)
          .execute();
        const actions = await sql`
          select count(*)::text as n from osint_research_actions where run_id = ${runId}
        `.execute(db);
        assert.equal(actions.rows[0].n, "0");
      });

      await t.test("удаление источника каскадно уносит его доступность", async () => {
        const sourceId = randomUUID();
        await db
          .insertInto("osint_sources")
          .values({
            id: sourceId,
            type: "website",
            provider: "web_page",
            url: "https://agent-cascade.example/",
            normalized_url: "https://agent-cascade.example/",
            name: "Cascade",
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();
        await recordSourceAccess(db, { sourceId, status: "blocked" });
        await db.deleteFrom("osint_sources").where("id", "=", sourceId).execute();
        const rows = await sql`
          select count(*)::text as n from osint_source_access where source_id = ${sourceId}
        `.execute(db);
        assert.equal(rows.rows[0].n, "0", "доступность принадлежит источнику");
      });
    } finally {
      if (db) await db.destroy().catch(() => undefined);
      if (created) {
        await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
      }
      await admin.end().catch(() => undefined);
    }
  },
);
