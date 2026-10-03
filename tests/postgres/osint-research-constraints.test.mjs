/**
 * Паспорт OSINT-исследования — constraints и гонки на НАСТОЯЩЕЙ
 * PostgreSQL 17 (`npm run test:pg`, opt-in сьют).
 *
 * Что здесь проверяется иначе, чем на PGlite:
 *   - CHECK/UNIQUE таблиц 074 по именам ограничений;
 *   - частичный UNIQUE «один активный запуск на бизнес»;
 *   - идемпотентность миграций (повторный migrate без изменений);
 *   - гонку двух параллельных launch'ов через MVCC/блокировки — ровно
 *     один запуск создаётся, второй уходит в идемпотентный отказ.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import { OsintService } from "../../src/server/intelligence/osint-service.ts";
import { parsePassportContent } from "../../src/server/intelligence/osint/research-passport.ts";
import { AppError } from "../../src/server/http/errors.ts";
import {
  expectPgRejection,
  scenario,
} from "../helpers/osint-stage3-fixtures.mjs";

function passport(displayName = "Кафе Ограничения") {
  return parsePassportContent({
    formatVersion: 1,
    identification: {
      displayName,
      urls: [{ url: "https://limits.example/", role: "official" }],
      city: "Барнаул",
    },
    goals: { selected: ["contacts"], searchPhrases: ["ограничения фраза"] },
  });
}

test(
  "Research passport schema runs on a real PostgreSQL 17 server",
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
      "biznesoty_research_pg_" + randomBytes(8).toString("hex");
    const admin = new Pool({ connectionString: source.href, max: 1 });
    let db;
    let created = false;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      source.pathname = "/" + databaseName;
      // DROP ... WITH (FORCE) оборывает сокеты, которые pool.end() ещё
      // закрывает: pg-pool шлёт 'error' без слушателя, и Node превращает
      // это в uncaughtException уже после завершения теста. Ошибки обрыва
      // соединения на teardown гасим — падения запросов всё равно видны
      // по результатам самих запросов.
      const pool = new Pool({ connectionString: source.href, max: 6 });
      pool.on("error", (error) => {
        if (!/terminat/i.test(String(error?.message ?? error))) throw error;
      });
      db = new Kysely({
        dialect: new PostgresDialect({ pool }),
      });

      const migrations = new URL("../../migrations", import.meta.url).pathname;
      await migrate(db, migrations);
      await migrate(db, migrations);

      await t.test("migrations are idempotent — 074 applied once", async () => {
        const rows = await sql`select name from sreda_migration`.execute(db);
        const list = rows.rows.map((row) => String(row.name));
        assert.equal(
          list.filter((name) => name.startsWith("074_")).length,
          1,
          "074 записана ровно один раз",
        );
      });

      await t.test("074 constraints reject violations with named constraints", async () => {
        const ctx = await scenario(db, "Ограничения паспорта");

        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_passports")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                revision: 0,
                format_version: 1,
                content: {},
                created_by: null,
                updated_by: null,
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_research_passports_revision_check" },
        );

        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_passports")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                revision: 1,
                format_version: 0,
                content: {},
                created_by: null,
                updated_by: null,
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_research_passports_format_check" },
        );

        const passportId = randomUUID();
        await db
          .insertInto("osint_research_passports")
          .values({
            id: passportId,
            business_id: ctx.business.id,
            revision: 1,
            format_version: 1,
            content: {},
            created_by: null,
            updated_by: null,
            created_at: new Date(),
            updated_at: new Date(),
          })
          .execute();

        // Один паспорт на бизнес.
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_passports")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                revision: 1,
                format_version: 1,
                content: {},
                created_by: null,
                updated_by: null,
                created_at: new Date(),
                updated_at: new Date(),
              })
              .execute(),
          { code: "23505", constraint: "osint_research_passports_business_key" },
        );

        // История ревизий append-only и без дублей (passport_id, revision).
        await db
          .insertInto("osint_research_passport_revisions")
          .values({
            id: randomUUID(),
            business_id: ctx.business.id,
            passport_id: passportId,
            revision: 1,
            format_version: 1,
            content: {},
            created_by: null,
            created_at: new Date(),
          })
          .execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_passport_revisions")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                passport_id: passportId,
                revision: 1,
                format_version: 1,
                content: {},
                created_by: null,
                created_at: new Date(),
              })
              .execute(),
          { code: "23505", constraint: "osint_research_passport_revisions_key" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_passport_revisions")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                passport_id: passportId,
                revision: 0,
                format_version: 1,
                content: {},
                created_by: null,
                created_at: new Date(),
              })
              .execute(),
          { code: "23514", constraint: "osint_research_passport_revisions_revision_check" },
        );

        // Один активный запуск на бизнес (частичный UNIQUE).
        const launchRow = (overrides = {}) => ({
          id: randomUUID(),
          business_id: ctx.business.id,
          passport_id: passportId,
          passport_revision: 1,
          passport_snapshot: {},
          plan: {},
          run_id: null,
          status: "queued",
          error: null,
          created_by: null,
          created_at: new Date(),
          started_at: null,
          finished_at: null,
          updated_at: new Date(),
          ...overrides,
        });
        await db
          .insertInto("osint_research_launches")
          .values(launchRow())
          .execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_launches")
              .values(launchRow())
              .execute(),
          { code: "23505", constraint: "osint_research_launches_active_idx" },
        );
        // Завершённые и неактивные строки не конфликтуют с индексом.
        await db
          .insertInto("osint_research_launches")
          .values(launchRow({ status: "completed" }))
          .execute();
        await db
          .insertInto("osint_research_launches")
          .values(launchRow({ status: "failed" }))
          .execute();

        await expectPgRejection(
          () =>
            db
              .insertInto("osint_research_launches")
              .values(launchRow({ status: "weird", passport_id: null }))
              .execute(),
          { code: "23514", constraint: "osint_research_launches_status_check" },
        );

        // extra_queries существует и принимает jsonb-массив.
        await db
          .insertInto("osint_discovery_runs")
          .values({
            id: randomUUID(),
            business_id: ctx.business.id,
            status: "queued",
            profile: {},
            budget: {},
            providers: [],
            queries_count: 0,
            results_count: 0,
            candidates_count: 0,
            accepted_count: 0,
            review_count: 0,
            rejected_count: 0,
            duplicates_count: 0,
            error: null,
            started_at: null,
            finished_at: null,
            created_at: new Date(),
            updated_at: new Date(),
            depth: 0,
            max_depth: 2,
            stats: {},
            root_entity_id: null,
            // node-postgres превращает JS-массив в ARRAY-литерал — для
            // jsonb нужен JSON-текст, как делает jsonbArray() в проде.
            extra_queries: JSON.stringify([
              { templateId: "passport_phrase", intent: "any", text: "фраза" },
            ]),
          })
          .execute();
        const runRow = await db
          .selectFrom("osint_discovery_runs")
          .select("extra_queries")
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirstOrThrow();
        assert.equal(
          Array.isArray(runRow.extra_queries) &&
            runRow.extra_queries.length === 1,
          true,
          "extra_queries jsonb сохранился",
        );
      });

      await t.test("two concurrent launches — exactly one run is created", async () => {
        const ctx = await scenario(db, "Гонка запусков");
        const service = new OsintService(db);
        const content = passport("Гонка Запусков");

        const outcomes = await Promise.allSettled([
          service.launchResearch(ctx.userId, ctx.business.public_id, content, null),
          service.launchResearch(ctx.userId, ctx.business.public_id, content, null),
        ]);

        const created = outcomes.filter(
          (outcome) =>
            outcome.status === "fulfilled" && outcome.value.created === true,
        );
        assert.equal(created.length, 1, "ровно один созданный запуск");
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            assert.ok(
              outcome.reason instanceof AppError &&
                outcome.reason.status === 409,
              `проигравший получает идемпотентный отказ 409, не 5xx: ${outcome.reason}`,
            );
          } else if (!outcome.value.created) {
            assert.ok(outcome.value.runId, "существующий запуск отдан с runId");
          }
        }

        const runs = await db
          .selectFrom("osint_discovery_runs")
          .select("id")
          .where("business_id", "=", ctx.business.id)
          .execute();
        assert.equal(runs.length, 1, "run создан ровно один");
        const launches = await db
          .selectFrom("osint_research_launches")
          .select("id")
          .where("business_id", "=", ctx.business.id)
          .execute();
        assert.equal(launches.length, 1, "строка запуска ровно одна");
      });

      await t.test("passport history and launches stay tenant-scoped", async () => {
        const owner = await scenario(db, "Тенант паспорта");
        const stranger = await scenario(db, "Сосед паспорта");
        const service = new OsintService(db);

        const saved = await service.savePassport(
          owner.userId,
          owner.business.public_id,
          passport("Только мой паспорт"),
          null,
        );
        assert.equal(saved.revision, 1);

        const ownRevisions = await db
          .selectFrom("osint_research_passport_revisions")
          .select(["business_id", "passport_id"])
          .where("business_id", "=", owner.business.id)
          .execute();
        assert.ok(ownRevisions.length >= 1, "своя история есть");
        const strangerRevisions = await db
          .selectFrom("osint_research_passport_revisions")
          .select(["business_id"])
          .where("business_id", "=", stranger.business.id)
          .execute();
        assert.equal(strangerRevisions.length, 0, "истории соседа нет");

        // Чужой паспорт не читается и не пишется.
        await assert.rejects(
          service.getResearch(stranger.userId, owner.business.public_id),
          (error) => error instanceof AppError && error.status !== 500,
        );
        await assert.rejects(
          service.savePassport(
            stranger.userId,
            owner.business.public_id,
            passport("Взлом"),
            null,
          ),
          (error) => error instanceof AppError && error.status !== 500,
        );
        const strangerRows = await db
          .selectFrom("osint_research_passports")
          .select(["business_id", "revision"])
          .where("business_id", "=", stranger.business.id)
          .execute();
        assert.equal(strangerRows.length, 0, "паспорт соседа не появился");
        const ownerRows = await db
          .selectFrom("osint_research_passports")
          .select(["business_id", "revision"])
          .where("business_id", "=", owner.business.id)
          .execute();
        assert.equal(ownerRows.length, 1, "свой паспорт на месте");
        assert.equal(ownerRows[0].revision, 1);
      });
    } finally {
      await db?.destroy();
      if (created) {
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
      }
      await admin.end();
    }
  },
);
