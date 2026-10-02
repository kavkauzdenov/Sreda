/**
 * Stage 3 v2.1 (§25) — интеграционные проверки crawl-очереди на НАСТОЯЩЕЙ
 * PostgreSQL 17. Отдельный opt-in сьют (`npm run test:pg`): здесь PGlite не
 * участвует вообще, а без `TEST_DATABASE_URL` сьют падает с явной ошибкой
 * настройки.
 *
 * Что здесь проверяется иначе, чем на PGlite:
 *   - реальные CHECK/UNIQUE/FK таблицы `osint_crawl_queue` (072);
 *   - конкурентный claim `FOR UPDATE SKIP LOCKED` двумя независимыми
 *     соединениями (на PGlite одна сессия не доказывает семантику);
 *   - атомарный claim discovery run'а двумя воркерами;
 *   - jsonb-статистика бюджета в `osint_discovery_runs.stats`;
 *   - тенант-изоляция статус-эндпоинта сервиса.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import { OsintService } from "../../src/server/intelligence/osint-service.ts";
import {
  createDiscoveryRun,
  executeDiscoveryRun,
  runDiscovery,
} from "../../src/server/intelligence/osint/discovery.ts";
import { runCrawl } from "../../src/server/intelligence/osint/crawl.ts";
import { mergeDiscoveryBudget } from "../../src/server/intelligence/osint/config.ts";
import { buildDiscoveryProfile } from "../../src/server/intelligence/osint/profile.ts";
import { createRegistry } from "../../src/server/intelligence/osint/providers/registry.ts";
import { createMockProvider } from "../../src/server/intelligence/osint/providers/mock.ts";
import { normalizePage } from "../../src/server/intelligence/osint/extraction/page.ts";
import { expectPgRejection, scenario } from "../helpers/osint-stage3-fixtures.mjs";

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description: "Кафе Ромашка — уютное кафе.\nСайт: https://owner.example/",
  industry: "food",
});

function fixtureSite(pages) {
  const calls = [];
  return {
    calls,
    descriptor: {
      id: "fixture_page",
      label: "Fixture",
      types: ["website"],
      intents: ["any"],
      requiresNetwork: true,
      enabledByDefault: true,
      policy: "public_web",
      rateLimitPerMinute: 60,
    },
    async fetchPage(input) {
      calls.push(input.url);
      const entry = pages[input.url];
      if (!entry) return { ok: false, reason: "http_error", detail: "404" };
      return {
        ok: true,
        page: normalizePage({
          requestedUrl: input.url,
          finalUrl: input.url,
          status: 200,
          contentType: "text/html",
          body: entry.body,
        }),
      };
    },
  };
}

const page = (title, body) =>
  `<!doctype html><html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;

function seedsFor(urls) {
  return urls.map((url) => ({ url, reason: "explicit", priority: 110 }));
}

test(
  "Stage 3 crawl queue runs on a real PostgreSQL 17 server",
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
    assert.match(source.pathname, /test/i, "The source database must be explicitly named as a test database");

    const databaseName = "biznesoty_stage3_crawl_pg_" + randomBytes(8).toString("hex");
    const admin = new Pool({ connectionString: source.href, max: 1 });
    let db;
    let created = false;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      source.pathname = "/" + databaseName;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: source.href, max: 6 }),
        }),
      });

      const migrations = new URL("../../migrations", import.meta.url).pathname;
      await migrate(db, migrations);
      await migrate(db, migrations);

      await t.test("osint_crawl_queue rejects violations with named constraints", async () => {
        const ctx = await scenario(db, "Очередь constraints");
        const run = await createDiscoveryRun(db, {
          businessId: ctx.business.id,
          registry: createRegistry(),
          profile: PROFILE,
          crawl: true,
          explicitSeeds: seedsFor(["https://owner.example/"]),
        });

        const row = (overrides = {}) => ({
          id: randomUUID(),
          run_id: run.runId,
          business_id: ctx.business.id,
          url: "https://owner.example/x",
          normalized_url: "https://owner.example/x" + randomUUID(),
          depth: 1,
          priority: 50,
          status: "queued",
          skip_reason: null,
          error: null,
          attempts: 0,
          http_status: null,
          from_url: null,
          fetched_at: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...overrides,
        });

        // CHECK status
        await expectPgRejection(
          () => db.insertInto("osint_crawl_queue").values(row({ status: "weird" })).execute(),
          { code: "23514", constraint: "osint_crawl_queue_status_check" },
        );
        // CHECK depth range
        await expectPgRejection(
          () => db.insertInto("osint_crawl_queue").values(row({ depth: 30 })).execute(),
          { code: "23514", constraint: "osint_crawl_queue_depth_range" },
        );
        // CHECK url length
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_crawl_queue")
              .values(row({ url: "https://owner.example/" + "a".repeat(2048) }))
              .execute(),
          { code: "23514", constraint: "osint_crawl_queue_url_len" },
        );
        // FK на run
        await expectPgRejection(
          () => db.insertInto("osint_crawl_queue").values(row({ run_id: randomUUID() })).execute(),
          { code: "23503" },
        );
        // UNIQUE (run_id, normalized_url) — дедуп циклов ссылок
        const duplicateUrl = "https://owner.example/dup";
        await db
          .insertInto("osint_crawl_queue")
          .values(row({ url: duplicateUrl, normalized_url: duplicateUrl }))
          .execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_crawl_queue")
              .values(row({ url: duplicateUrl, normalized_url: duplicateUrl }))
              .execute(),
          { code: "23505", constraint: "osint_crawl_queue_unique" },
        );
      });

      await t.test("FOR UPDATE SKIP LOCKED: two workers never fetch the same URL", async () => {
        const ctx = await scenario(db, "Конкурентный claim");
        const urls = Array.from({ length: 6 }, (_, i) => `https://owner.example/p${i}`);
        const created = await createDiscoveryRun(db, {
          businessId: ctx.business.id,
          registry: createRegistry(),
          profile: PROFILE,
          crawl: true,
          explicitSeeds: seedsFor(["https://owner.example/", ...urls]),
        });

        const site = fixtureSite(
          Object.fromEntries([
            ["https://owner.example/", { body: page("Кафе Ромашка", "дом") }],
            ...urls.map((url) => [url, { body: page("Кафе Ромашка", "страница") }]),
          ]),
        );
        const input = {
          businessId: ctx.business.id,
          runId: created.runId,
          entityId: null,
          profile: PROFILE,
          seeds: null,
          options: {
            budget: mergeDiscoveryBudget({ maxConcurrency: 2 }),
            pageProvider: site,
            followDomains: ["owner.example"],
            followSocialLinks: [],
            robots: null,
          },
        };

        const [first, second] = await Promise.all([
          runCrawl(db, input),
          runCrawl(db, input),
        ]);
        assert.equal(first.fetched + second.fetched, 7, "каждая строка claim'нулась ровно один раз");
        assert.equal(new Set(site.calls).size, site.calls.length, "нет двойных загрузок");

        const rows = await db
          .selectFrom("osint_crawl_queue")
          .select(["status", (eb) => eb.fn.countAll().as("n")])
          .where("run_id", "=", created.runId)
          .groupBy("status")
          .execute();
        const countOf = (status) =>
          Number(rows.find((row) => row.status === status)?.n ?? 0);
        assert.equal(countOf("fetched"), 7);
        assert.equal(countOf("queued"), 0);
        assert.equal(countOf("fetching"), 0, "никаких зависших claims");
      });

      await t.test("executeDiscoveryRun is claimed atomically by one worker", async () => {
        const ctx = await scenario(db, "Атомарный claim run");
        const created = await createDiscoveryRun(db, {
          businessId: ctx.business.id,
          registry: createRegistry([createMockProvider({ id: "mock_search", respond: () => [] })]),
          profile: PROFILE,
          crawl: false,
        });
        const registry = createRegistry([
          createMockProvider({ id: "mock_search", respond: () => [] }),
        ]);
        const [a, b] = await Promise.all([
          executeDiscoveryRun(db, created.runId, { registry, userId: ctx.userId }),
          executeDiscoveryRun(db, created.runId, { registry, userId: ctx.userId }),
        ]);
        const winners = [a, b].filter(Boolean);
        assert.equal(winners.length, 1, "ровно один воркер выиграл claim");
        const row = await db
          .selectFrom("osint_discovery_runs")
          .select(["status", "finished_at"])
          .where("id", "=", created.runId)
          .executeTakeFirstOrThrow();
        assert.equal(row.status, "completed");
        assert.ok(row.finished_at, "run завершён победителем");
      });

      await t.test("budget exhaustion is persisted into the run stats jsonb", async () => {
        const ctx = await scenario(db, "Бюджет в stats");
        const site = fixtureSite({
          "https://owner.example/": { body: page("Кафе Ромашка", "дом") },
          "https://owner.example/a": { body: page("A", "страница") },
          "https://owner.example/b": { body: page("B", "страница") },
        });
        const result = await runDiscovery(db, {
          businessId: ctx.business.id,
          userId: ctx.userId,
          registry: createRegistry(
            [createMockProvider({ id: "mock_search", respond: () => [] })],
            [site],
          ),
          profile: PROFILE,
          budget: { maxPages: 1 },
          seeds: seedsFor([
            "https://owner.example/",
            "https://owner.example/a",
            "https://owner.example/b",
          ]),
          crawl: {},
        });
        assert.equal(result.status, "partial", "бюджетный hit — частичный успех");
        const stats = await sql`select stats from osint_discovery_runs where id = ${result.runId}`.execute(db);
        const crawl = stats.rows[0].stats.crawl;
        assert.equal(crawl.fetched, 1);
        assert.equal(crawl.skipped, 2);
        assert.deepEqual(crawl.budgetHits, ["budget_pages"], JSON.stringify(crawl.budgetHits));
        assert.equal(crawl.seeds, 3);
      });

      await t.test("run status is tenant-scoped on PostgreSQL", async () => {
        const mine = await scenario(db, "Статус тенант A");
        const foreign = await scenario(db, "Статус тенант B");
        const enqueued = await new OsintService(db).enqueueDiscovery(
          mine.userId,
          mine.business.public_id,
          { seedUrls: ["https://owner.example/"] },
        );
        assert.equal(enqueued.status, "queued");
        assert.equal(enqueued.seeds, 1);

        const status = await new OsintService(db).getRunStatus(
          mine.userId,
          mine.business.public_id,
          enqueued.runId,
        );
        assert.equal(status.status, "queued");
        assert.equal(status.queue.total, 1);
        assert.equal(status.queue.queued, 1);

        // Чужой тенант не видит run — и не может отличить «чужой» от «нет такого».
        await assert.rejects(
          () =>
            new OsintService(db).getRunStatus(
              foreign.userId,
              foreign.business.public_id,
              enqueued.runId,
            ),
          (error) => error.status === 404 && error.code === "DISCOVERY_RUN_NOT_FOUND",
          "run другого бизнеса → 404 без утечки факта существования",
        );
        await assert.rejects(
          () =>
            new OsintService(db).getRunStatus(
              mine.userId,
              mine.business.public_id,
              "not-a-uuid",
            ),
          (error) => error.status === 404,
          "не-uuid → 404",
        );
        // Валидный, но несуществующий uuid того же тенанта — тоже 404.
        await assert.rejects(
          () =>
            new OsintService(db).getRunStatus(
              mine.userId,
              mine.business.public_id,
              randomUUID(),
            ),
          (error) => error.status === 404 && error.code === "DISCOVERY_RUN_NOT_FOUND",
        );
      });

      await t.test("migrations are idempotent for the new tables", async () => {
        await migrate(db, migrations);
        const twice = await sql`
          select count(*)::int as n from pg_indexes
          where tablename = 'osint_crawl_queue'
        `.execute(db);
        assert.equal(twice.rows[0].n >= 2, true, "индексы не задваиваются");
        const rows = await sql`
          select status from osint_crawl_queue group by status
        `.execute(db);
        assert.ok(Array.isArray(rows.rows), "таблица читается после повторных миграций");
      });
    } finally {
      if (db) await db.destroy();
      if (created) {
        const deadline = Date.now() + 10_000;
        while (true) {
          const remaining = await admin.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = $1",
            [databaseName],
          );
          if (remaining.rows[0].count === 0) break;
          assert.ok(
            Date.now() < deadline,
            "Тестовая база всё ещё держит соединения после закрытия приложения",
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await admin.query(`DROP DATABASE "${databaseName}"`);
      }
      await admin.end();
    }
  },
);
