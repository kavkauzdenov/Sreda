/**
 * Stage 4 (§26) — интеграционные проверки intelligence layer на НАСТОЯЩЕЙ
 * PostgreSQL 17. Отдельный opt-in сьют (`npm run test:pg`): PGlite здесь не
 * участвует, без `TEST_DATABASE_URL` сьют падает с явной ошибкой настройки.
 *
 * Что здесь проверяется иначе, чем на PGlite:
 *   - реальные CHECK/UNIQUE/FK таблиц 073 (facts/changes/contradictions/
 *     enrichment runs) по именам ограничений;
 *   - гонку двух claim'ов одного run'а и SKIP LOCKED claimNext тремя
 *     воркерами через независимые соединения пула;
 *   - upsert-идемпотентность enrichment (first_seen не двигается);
 *   - тенантскую изоляцию read model на серверных типах данных.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import { OsintService } from "../../src/server/intelligence/osint-service.ts";
import {
  claimEnrichment,
  claimNextEnrichment,
  enqueueEnrichment,
  releaseStaleEnrichmentRuns,
  runEnrichment,
} from "../../src/server/intelligence/osint/enrichment.ts";
import { releaseStaleDiscoveryRuns } from "../../src/server/intelligence/osint/discovery.ts";
import {
  addObservation,
  attachSource,
  createSource,
  expectPgRejection,
  scenario,
} from "../helpers/osint-stage3-fixtures.mjs";

test(
  "Stage 4 intelligence layer runs on a real PostgreSQL 17 server",
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
    assert.match(
      source.pathname,
      /test/i,
      "The source database must be explicitly named as a test database",
    );

    const databaseName =
      "biznesoty_stage4_intel_pg_" + randomBytes(8).toString("hex");
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

      await t.test("intelligence tables reject violations with named constraints", async () => {
        const ctx = await scenario(db, "Ограничения");
        const src = await createSource(db, "https://pg-constraints.example/");
        await attachSource(db, ctx.entityId, src.sourceId);
        const obsId = await addObservation(db, {
          entityId: ctx.entityId,
          sourceId: src.sourceId,
          content: "Страница ограничений",
          observedAt: new Date("2026-01-05T00:00:00Z"),
        });

        // Один активный enrichment run на бизнес (частичный UNIQUE).
        const enqueued = await enqueueEnrichment(db, {
          businessId: ctx.business.id,
        });
        assert.equal(enqueued.created, true);
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_enrichment_runs")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                status: "queued",
              })
              .execute(),
          { code: "23505", constraint: "osint_enrichment_active_idx" },
        );

        // attempts ограничен (< 10), статус — закрытый словарь.
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_enrichment_runs")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                status: "failed",
                attempts: 10,
              })
              .execute(),
          { code: "23514", constraint: "osint_enrichment_attempts" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_enrichment_runs")
              .values({
                id: randomUUID(),
                business_id: ctx.business.id,
                status: "weird",
              })
              .execute(),
          { code: "23514", constraint: "osint_enrichment_status_check" },
        );

        const factRow = (overrides = {}) => ({
          id: randomUUID(),
          business_id: ctx.business.id,
          entity_id: ctx.entityId,
          fact_type: "phone",
          fact_key: "79990000000",
          value: "79990000000",
          raw_value: "79990000000",
          source_id: src.sourceId,
          observation_id: obsId,
          status: "ACTIVE",
          fingerprint: "fp-" + randomUUID(),
          ...overrides,
        });

        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_facts")
              .values(factRow({ fact_type: "weather" }))
              .execute(),
          { code: "23514", constraint: "osint_intel_facts_type_check" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_facts")
              .values(factRow({ status: "LOST" }))
              .execute(),
          { code: "23514", constraint: "osint_intel_facts_status_check" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_facts")
              .values(factRow({ source_id: randomUUID() }))
              .execute(),
          { code: "23503", constraint: "osint_intelligence_facts_source_id_fkey" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_facts")
              .values(factRow({ observation_id: randomUUID() }))
              .execute(),
          {
            code: "23503",
            constraint: "osint_intelligence_facts_observation_id_fkey",
          },
        );

        // Двойная запись с одним отпечатком гасится UNIQUE.
        const first = factRow();
        await db.insertInto("osint_intelligence_facts").values(first).execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_facts")
              .values(factRow({ fingerprint: first.fingerprint }))
              .execute(),
          { code: "23505", constraint: "osint_intel_facts_unique" },
        );

        const changeRow = (overrides = {}) => ({
          id: randomUUID(),
          business_id: ctx.business.id,
          fact_type: "phone",
          fact_key: "79990000000",
          change_kind: "FIRST_SEEN",
          new_value: "79990000000",
          source_id: src.sourceId,
          observation_id: obsId,
          fingerprint: "cfp-" + randomUUID(),
          ...overrides,
        });
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_fact_changes")
              .values(changeRow({ change_kind: "INVENTED" }))
              .execute(),
          { code: "23514", constraint: "osint_changes_kind_check" },
        );
        const change = changeRow();
        await db.insertInto("osint_fact_changes").values(change).execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_fact_changes")
              .values(changeRow({ fingerprint: change.fingerprint }))
              .execute(),
          { code: "23505", constraint: "osint_changes_unique" },
        );

        const contradictionRow = (overrides = {}) => ({
          id: randomUUID(),
          business_id: ctx.business.id,
          fact_type: "phone",
          sides: "[]",
          value_count: 2,
          source_count: 2,
          ...overrides,
        });
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_contradictions")
              .values(contradictionRow({ status: "maybe" }))
              .execute(),
          { code: "23514", constraint: "osint_contradictions_status_check" },
        );
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_contradictions")
              .values(contradictionRow({ value_count: -1 }))
              .execute(),
          { code: "23514", constraint: "osint_contradictions_counts" },
        );
        await db
          .insertInto("osint_intelligence_contradictions")
          .values(contradictionRow())
          .execute();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_intelligence_contradictions")
              .values(contradictionRow())
              .execute(),
          { code: "23505", constraint: "osint_contradictions_unique" },
        );

        // Частичный UNIQUE уже проверен — закрываем активный run, чтобы он
        // не подхватился claimNext в соседнем подтесте.
        await db
          .updateTable("osint_enrichment_runs")
          .set({ status: "completed", finished_at: new Date(), updated_at: new Date() })
          .where("id", "=", enqueued.runId)
          .execute();
      });

      await t.test("upsert is idempotent: first_seen does not move", async () => {
        const ctx = await scenario(db, "Идемпотентность");
        const src = await createSource(db, "https://pg-idempotent.example/");
        await attachSource(db, ctx.entityId, src.sourceId);
        await addObservation(db, {
          entityId: ctx.entityId,
          sourceId: src.sourceId,
          content: `${ctx.label}. Телефон: 8 (999) 000-00-00`,
          observedAt: new Date("2026-01-06T00:00:00Z"),
        });

        const first = await runEnrichment(db, { businessId: ctx.business.id });
        assert.equal(first.status, "completed");
        assert.equal(first.stats.factsExtracted > 0, true);

        const readFact = async () =>
          await db
            .selectFrom("osint_intelligence_facts")
            .selectAll()
            .where("business_id", "=", ctx.business.id)
            .where("fact_type", "=", "phone")
            .executeTakeFirstOrThrow();
        const before = await readFact();

        const second = await runEnrichment(db, { businessId: ctx.business.id });
        assert.equal(second.status, "completed");
        assert.equal(second.stats.factsExtracted, 0, "новых строк нет");
        assert.equal(second.stats.factsChanged, 0, "переходов нет");
        const after = await readFact();
        assert.equal(after.id, before.id, "строка та же");
        assert.equal(
          after.first_seen_at.getTime(),
          before.first_seen_at.getTime(),
          "first_seen_at не сдвигается",
        );

        const total = await db
          .selectFrom("osint_intelligence_facts")
          .select(({ fn }) => fn.countAll().as("n"))
          .where("business_id", "=", ctx.business.id)
          .executeTakeFirstOrThrow();
        assert.equal(Number(total.n), first.stats.factsExtracted);
      });

      await t.test("two workers claim the same queued run — exactly one wins", async () => {
        const ctx = await scenario(db, "Конкурентный claim");
        const { runId } = await enqueueEnrichment(db, {
          businessId: ctx.business.id,
        });
        const [a, b] = await Promise.all([
          claimEnrichment(db, runId),
          claimEnrichment(db, runId),
        ]);
        const winners = [a, b].filter((entry) => entry !== null);
        assert.equal(winners.length, 1, "ровно один воркер выиграл");
        const winner = winners[0];
        assert.equal(winner.attempts, 1);
        assert.equal(winner.businessId, ctx.business.id);

        const outcome = await runEnrichment(db, {
          businessId: winner.businessId,
          runId: winner.id,
          attempts: winner.attempts,
        });
        assert.equal(outcome.status, "completed");
      });

      await t.test("claimNext with SKIP LOCKED never hands the same run twice", async () => {
        const ctxA = await scenario(db, "Очередь A");
        const ctxB = await scenario(db, "Очередь B");
        const first = await enqueueEnrichment(db, { businessId: ctxA.business.id });
        const second = await enqueueEnrichment(db, { businessId: ctxB.business.id });
        assert.equal(first.created, true);
        assert.equal(second.created, true);
        assert.notEqual(first.runId, second.runId);

        const claims = await Promise.all([
          claimNextEnrichment(db),
          claimNextEnrichment(db),
          claimNextEnrichment(db),
        ]);
        const taken = claims.filter((entry) => entry !== null);
        assert.equal(taken.length, 2, "две queued строки — два winner'а");
        assert.equal(
          new Set(taken.map((entry) => entry.id)).size,
          2,
          "один и тот же run не выдан дважды",
        );
        const sorted = taken.map((entry) => entry.id).sort();
        assert.deepEqual(
          sorted,
          [first.runId, second.runId].sort(),
          "выданы ровно наши run'ы",
        );

        for (const claim of taken) {
          const outcome = await runEnrichment(db, {
            businessId: claim.businessId,
            runId: claim.id,
            attempts: claim.attempts,
          });
          assert.equal(outcome.status, "completed");
        }
      });

      // TOCTOU (§26.11): release видит run как running, но к моменту
      // UPDATE строка уже завершена в НЕЗАКОММИЧЕННОЙ транзакции.
      // PostgreSQL после снятия блокировки перепроверяет квалификаторы
      // UPDATE (EvalPlanQual) — re-check `status` обязан отбросить строку,
      // иначе результат успешного прогона затирается в failed/requeued.
      // Проверки не зависят от тайминга: uncommitted коммит не виден
      // SELECT'у, а UPDATE гарантированно ждёт блокировку до коммита;
      // sleep лишь расширяет окно между SELECT и UPDATE.
      await t.test("discovery stale release never clobbers a run completed in the window", async () => {
        const ctx = await scenario(db, "TOCTOU discovery");
        const runId = randomUUID();
        const staleStart = new Date(Date.now() - 20 * 60_000);
        await db
          .insertInto("osint_discovery_runs")
          .values({
            id: runId,
            business_id: ctx.business.id,
            status: "running",
            started_at: staleStart,
            created_at: staleStart,
            updated_at: staleStart,
          })
          .execute();

        const txn = await db.startTransaction().execute();
        let committed = false;
        try {
          await txn
            .updateTable("osint_discovery_runs")
            .set({ status: "completed", updated_at: new Date() })
            .where("id", "=", runId)
            .execute();
          const pending = releaseStaleDiscoveryRuns(db);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await txn.commit().execute();
          committed = true;
          const released = await pending;
          assert.equal(released, 0, "завершённый run не выпущен как stale");
        } finally {
          if (!committed)
            await txn.rollback().execute().catch(() => undefined);
        }

        const row = await db
          .selectFrom("osint_discovery_runs")
          .selectAll()
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
        assert.equal(row.status, "completed", "статус не переписан задним числом");
        assert.equal(row.error, null, "ошибка не навязана завершённому run'у");
      });

      await t.test("stale enrichment release skips a run completed in the window", async () => {
        const ctx = await scenario(db, "TOCTOU enrichment");
        const runId = randomUUID();
        const staleStart = new Date(Date.now() - 11 * 60_000);
        await db
          .insertInto("osint_enrichment_runs")
          .values({
            id: runId,
            business_id: ctx.business.id,
            status: "running",
            attempts: 1,
            started_at: staleStart,
          })
          .execute();

        const txn = await db.startTransaction().execute();
        let committed = false;
        try {
          await txn
            .updateTable("osint_enrichment_runs")
            .set({
              status: "completed",
              finished_at: new Date(),
              updated_at: new Date(),
            })
            .where("id", "=", runId)
            .execute();
          const pending = releaseStaleEnrichmentRuns(db);
          await new Promise((resolve) => setTimeout(resolve, 250));
          await txn.commit().execute();
          committed = true;
          await pending;
        } finally {
          if (!committed)
            await txn.rollback().execute().catch(() => undefined);
        }

        const row = await db
          .selectFrom("osint_enrichment_runs")
          .select(["status", "error", "finished_at"])
          .where("id", "=", runId)
          .executeTakeFirstOrThrow();
        assert.equal(row.status, "completed", "completed не возвращается в queued");
        assert.ok(row.finished_at, "завершение не стёрто повторной выдачей");
      });

      await t.test("stale running runs are requeued or failed by attempts cap", async () => {
        const ctx = await scenario(db, "Застарелые run'ы");
        const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000);

        const retryable = randomUUID();
        await db
          .insertInto("osint_enrichment_runs")
          .values({
            id: retryable,
            business_id: ctx.business.id,
            status: "running",
            attempts: 1,
            started_at: elevenMinutesAgo,
          })
          .execute();

        const ctx2 = await scenario(db, "Застарелые run'ы два");
        const exhausted = randomUUID();
        await db
          .insertInto("osint_enrichment_runs")
          .values({
            id: exhausted,
            business_id: ctx2.business.id,
            status: "running",
            attempts: 3,
            started_at: elevenMinutesAgo,
          })
          .execute();

        const released = await releaseStaleEnrichmentRuns(db);
        assert.equal(released, 2);

        const rows = await db
          .selectFrom("osint_enrichment_runs")
          .select(["id", "status", "error", "finished_at"])
          .where("id", "in", [retryable, exhausted])
          .execute();
        const byId = new Map(rows.map((row) => [row.id, row]));
        assert.equal(byId.get(retryable).status, "queued", "попытка не исчерпана");
        assert.equal(byId.get(retryable).error, null);
        assert.equal(byId.get(exhausted).status, "failed", "attempts = max");
        assert.equal(byId.get(exhausted).error, "stale_run_expired");
        assert.ok(byId.get(exhausted).finished_at, "run закрыт");
      });

      await t.test("intel read model is tenant-scoped on PostgreSQL", async () => {
        const owner = await scenario(db, "Владелец фактов");
        const stranger = await scenario(db, "Сосед без фактов");
        const src = await createSource(db, "https://pg-tenant.example/");
        await attachSource(db, owner.entityId, src.sourceId);
        await addObservation(db, {
          entityId: owner.entityId,
          sourceId: src.sourceId,
          content: `${owner.label}. Телефон: 8 (999) 111-11-11`,
          observedAt: new Date("2026-01-07T00:00:00Z"),
        });
        await runEnrichment(db, { businessId: owner.business.id });

        const service = new OsintService(db);
        const own = await service.getIntelFacts(
          owner.userId,
          owner.business.public_id,
        );
        assert.equal(own.total > 0, true);
        const foreign = await service.getIntelFacts(
          stranger.userId,
          stranger.business.public_id,
        );
        assert.equal(foreign.total, 0, "чужие факты не видны");
        const ownProfile = await service.getIntelProfile(
          owner.userId,
          owner.business.public_id,
        );
        assert.equal(ownProfile.counts.active, own.total);
        const foreignProfile = await service.getIntelProfile(
          stranger.userId,
          stranger.business.public_id,
        );
        assert.equal(foreignProfile.counts.active, 0);
        assert.equal(foreignProfile.lastRun, null);
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
