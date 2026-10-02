/**
 * Stage 3 v2 — интеграционные проверки на НАСТОЯЩЕЙ PostgreSQL 17.
 *
 * Это отдельный opt-in сьют (`npm run test:pg`), а не продолжение юнитов:
 * `tests/*.test.mjs` гоняются на PGlite, здесь же PGlite не участвует вообще.
 * Если `TEST_DATABASE_URL` не задан — сьют падает с явной ошибкой
 * настройки, а не «тихо зеленеет» пропуском.
 *
 * Что здесь проверяется иначе, чем на PGlite:
 *   - реальные JOIN/LATERAL-запросы и `LEFT JOIN LATERAL ... ORDER BY ... LIMIT`
 *     в `OsintService.assessObservations` (прогон на другом движке ничего
 *     не доказывает);
 *   - настоящие CHECK / UNIQUE / Foreign Key вместо ожиданий об их наличии;
 *   - `ASSESSMENT_LIMIT` против таблицы с реальными строками;
 *   - идемпотентность Stage 2 observation writer'а на сервере PostgreSQL.
 *
 * Схема создаётся в ОДНОРАЗОВОЙ базе `biznesoty_stage3_pg_test_*` и в конце
 * удаляется: в тестовой базе CI не остаётся ни одной строки этих тестов.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { migrate } from "../../src/server/db/migrate.ts";
import { OsintService } from "../../src/server/intelligence/osint-service.ts";
import {
  ensureObservation,
} from "../../src/server/intelligence/osint/observations.ts";
import {
  NO_CLAIM_TEXT,
  PHONE_A,
  PHONE_B,
  addObservation,
  addObservations,
  attachSource,
  createSource,
  expectPgRejection,
  makeBusiness,
  makeUser,
  scenario,
} from "../helpers/osint-stage3-fixtures.mjs";

test(
  "Stage 3 v2 assessment runs on a real PostgreSQL 17 server",
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

    const databaseName = "biznesoty_stage3_pg_test_" + randomBytes(8).toString("hex");
    const admin = new Pool({ connectionString: source.href, max: 1 });
    let db;
    let created = false;

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      source.pathname = "/" + databaseName;
      db = new Kysely({
        dialect: new PostgresDialect({
          pool: new Pool({ connectionString: source.href, max: 4 }),
        }),
      });

      const migrations = new URL("../../migrations", import.meta.url).pathname;
      // Twice on purpose: the HTTP harness does the same, so a non-idempotent
      // migration would fail here before it ever reached CI.
      await migrate(db, migrations);
      await migrate(db, migrations);

      await t.test("the connected server is PostgreSQL 17, not PGlite", async () => {
        const rows = await sql`select version()`.execute(db);
        const version = rows.rows[0].version;
        assert.match(version, /PostgreSQL 17\./, version);
        assert.ok(
          !/pglite/i.test(version),
          `PGlite must not stand in for PostgreSQL here: ${version}`,
        );
        const current = await sql`select current_database() as db`.execute(db);
        assert.equal(current.rows[0].db, databaseName, "тесты идут в одноразовой базе");
      });

      await t.test("LATERAL ranking and provenance are read through real joins", async () => {
        const mine = await scenario(db, "Lateral прямой");
        const neighbour = await scenario(db, "Lateral сосед");

        // Общий источник: привязан и к нашей сущности, и к соседней.
        const shared = await createSource(db);
        await attachSource(db, mine.entityId, shared.sourceId);
        await attachSource(db, neighbour.entityId, shared.sourceId);

        // Собственный источник только для нашей сущности.
        const own = await createSource(db);
        await attachSource(db, mine.entityId, own.sourceId);

        // Наблюдение записано на СОСЕДНЮЮ сущность — для нас оно доступно
        // только через fallback-ветку LATERAL (`be.entity_id IN
        // (SELECT es.entity_id ... WHERE es.source_id = o.source_id)`).
        const viaFallback = await addObservation(db, {
          entityId: neighbour.entityId,
          sourceId: shared.sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-10-10.",
        });
        const direct = await addObservation(db, {
          entityId: mine.entityId,
          sourceId: own.sourceId,
          content: "Кафе. Телефон: +7 (3852) 55-10-10.",
        });

        const service = new OsintService(db);
        const mineResult = await service.assessObservations(
          mine.userId,
          mine.business.public_id,
        );

        assert.equal(mineResult.observationCount, 2, "обе строки в scope тенанта");
        assert.equal(mineResult.skippedObservations, 0);
        assert.equal(mineResult.groups.length >= 1, true);

        for (const group of mineResult.groups) {
          // Субъект берётся из ранжированной строки LATERAL, а не из
          // entity_id наблюдения: наблюдение соседней сущности отнесено к нам.
          assert.equal(group.subject, mine.label, group.predicate);
          assert.ok(group.observations.includes(viaFallback));
          assert.ok(group.observations.includes(direct));
          assert.deepEqual(
            group.sources.sort(),
            [own.sourceId, shared.sourceId].sort(),
            "provenance: оба источника читаются через JOIN",
          );
          assert.equal(group.distinctObservationCount, 2);
          assert.equal(group.distinctSourceCount, 2);
          assert.equal(group.rule, "distinct_sources");
          assert.ok(group.corroboration, "два источника подтверждают факт");

          assert.equal(group.provenance.length, group.claimCount);
          for (const pointer of group.provenance) {
            assert.equal(pointer.observationId, pointer.evidenceRef.observationId);
            assert.ok(group.observations.includes(pointer.observationId));
            assert.ok(group.sources.includes(pointer.sourceId));
          }
        }

        // Тот же наблюдение видно и соседним тенантом — через точное
        // совпадение entity_id (первая ветка LATERAL, приоритет в ORDER BY).
        const neighbourResult = await service.assessObservations(
          neighbour.userId,
          neighbour.business.public_id,
        );
        assert.equal(neighbourResult.observationCount, 1, "своя строка + общая");
        const neighbourOwn = neighbourResult.groups.find((group) =>
          group.observations.includes(viaFallback),
        );
        assert.ok(neighbourOwn, "сосед читает своё наблюдение");
        assert.equal(neighbourOwn.subject, neighbour.label);
        // Наше наблюдение соседу не досталось: источник own ни к чему не ведёт.
        assert.ok(!JSON.stringify(neighbourResult).includes(direct));
      });

      await t.test("cross-tenant observations, sources and claims never mix", async () => {
        const a = await scenario(db, "Изоляция А");
        const b = await scenario(db, "Изоляция Б");

        const sourceA = await createSource(db);
        await attachSource(db, a.entityId, sourceA.sourceId);
        const sourceB = await createSource(db);
        await attachSource(db, b.entityId, sourceB.sourceId);

        await addObservation(db, {
          entityId: a.entityId,
          sourceId: sourceA.sourceId,
          content: "Кафе А. Телефон: 8 (3852) 55-10-10. Сайт: https://tenant-a.ru/",
        });
        await addObservation(db, {
          entityId: b.entityId,
          sourceId: sourceB.sourceId,
          content: "Пекарня Б. Телефон: 8 (3852) 55-99-99. Сайт: https://tenant-b.ru/",
        });

        const service = new OsintService(db);
        const resultA = await service.assessObservations(
          a.userId,
          a.business.public_id,
        );
        assert.equal(resultA.observationCount, 1, "чужая строка не читается");
        assert.equal(resultA.skippedObservations, 0);
        const serialisedA = JSON.stringify(resultA);
        assert.ok(!serialisedA.includes("55-99-99"), "значение tenant B не утекает");
        assert.ok(!serialisedA.includes("tenant-b.ru"));
        assert.ok(!serialisedA.includes(sourceB.sourceId), "источник B не утёк");
        assert.ok(!serialisedA.includes(b.business.id));
        assert.ok(!serialisedA.includes(b.entityId));
        for (const group of resultA.groups) {
          assert.equal(group.subject, a.label);
        }

        const resultB = await service.assessObservations(
          b.userId,
          b.business.public_id,
        );
        assert.equal(resultB.observationCount, 1);
        const serialisedB = JSON.stringify(resultB);
        assert.ok(!serialisedB.includes("55-10-10"));
        assert.ok(!serialisedB.includes("tenant-a.ru"));
        assert.ok(!serialisedB.includes(sourceA.sourceId));

        // Бизнес без моста к сущности не видит вообще ничего.
        const bystander = await makeUser(db, "Bystander");
        const empty = await makeBusiness(db, bystander, "Чужой бизнес пустой");
        const emptyResult = await service.assessObservations(
          bystander,
          empty.public_id,
        );
        assert.equal(emptyResult.observationCount, 0);
        assert.deepEqual(emptyResult.groups, []);
        assert.equal(emptyResult.reason, "insufficient_evidence");
      });

      await t.test("missing access is answered 404 without leaking existence", async () => {
        const owner = await scenario(db, "Доступ к владельцу");
        const stranger = await makeUser(db, "Посторонний");
        const service = new OsintService(db);

        await assert.rejects(
          () => service.assessObservations(stranger, owner.business.public_id),
          (error) =>
            error.status === 404 && error.code === "BUSINESS_NOT_FOUND",
          "авторизованный, но не состоящий в бизнесе — 404",
        );

        await assert.rejects(
          () => service.assessObservations(owner.userId, "biz_0000000000000000"),
          (error) =>
            error.status === 404 && error.code === "BUSINESS_NOT_FOUND",
          "несуществующий public_id неотличим от чужого",
        );

        // Отозванное членство: requireBusiness фильтрует status = 'active'.
        const revokedUser = await makeUser(db, "Отозванный");
        await db
          .insertInto("business_member")
          .values({
            business_id: owner.business.id,
            user_id: revokedUser,
            role: "admin",
            status: "revoked",
          })
          .execute();
        await assert.rejects(
          () => service.assessObservations(revokedUser, owner.business.public_id),
          (error) => error.status === 404 && error.code === "BUSINESS_NOT_FOUND",
          "отозванное членство не даёт доступ",
        );

        // Архивный бизнес закрыт для чтения.
        const archivedOwner = await scenario(db, "Архивный бизнес");
        await db
          .updateTable("business")
          .set({ archived_at: new Date() })
          .where("id", "=", archivedOwner.business.id)
          .execute();
        await assert.rejects(
          () =>
            service.assessObservations(
              archivedOwner.userId,
              archivedOwner.business.public_id,
            ),
          (error) => error.status === 404 && error.code === "BUSINESS_NOT_FOUND",
          "архивный бизнес не читается",
        );
      });

      await t.test("observation writer stays idempotent on PostgreSQL", async () => {
        const ctx = await scenario(db, "Идемпотентность writer");
        const url = "https://idem-stage3-pg.ru/";
        const { sourceId } = await createSource(db, url);
        await attachSource(db, ctx.entityId, sourceId);

        const observed = {
          url,
          title: ctx.label,
          snippet: "кофе и выпечка",
          provider: "mock_search",
          method: "search",
        };

        const first = await ensureObservation(db, {
          businessId: ctx.business.id,
          entityId: ctx.entityId,
          sourceId,
          observed,
        });
        assert.equal(first.created, true, first.skipped ?? "");
        assert.ok(first.id);

        const repeat = await ensureObservation(db, {
          businessId: ctx.business.id,
          entityId: ctx.entityId,
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

        // Идемпотентная запись видна в оценке ровно одной строкой.
        const result = await new OsintService(db).assessObservations(
          ctx.userId,
          ctx.business.public_id,
        );
        assert.equal(result.observationCount, 1, "writer не плодит наблюдения");
        assert.equal(result.skippedObservations, 0, "контент даёт website-claim");
        assert.equal(result.groups.length >= 1, true);
        for (const group of result.groups) {
          assert.ok(group.observations.includes(first.id));
        }
      });

      await t.test("damaged and claim-less rows are skipped, not fatal", async () => {
        const ctx = await scenario(db, "Битые строки");
        const { sourceId } = await createSource(db);
        await attachSource(db, ctx.entityId, sourceId);

        const good = await addObservation(db, {
          entityId: ctx.entityId,
          sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-10-10.",
        });
        // char_length(' ') = 1 — проходит CHECK 069, но `toEvidence`
        // отвечает 422: строка не даёт права на Claim (§6).
        const damaged = await addObservation(db, {
          entityId: ctx.entityId,
          sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-10-10.",
          contentHash: " ",
        });
        // Валидная строка без единого извлекаемого факта.
        const claimless = await addObservation(db, {
          entityId: ctx.entityId,
          sourceId,
          content: NO_CLAIM_TEXT,
        });

        const result = await new OsintService(db).assessObservations(
          ctx.userId,
          ctx.business.public_id,
        );

        assert.equal(result.observationCount, 3, "все строки в scope");
        assert.equal(result.skippedObservations, 2, "битая + без фактов");
        assert.equal(result.reason, null, "bulk не превратился в пустой ответ");
        assert.equal(result.groups.length >= 1, true, "валидная строка обработана");

        for (const group of result.groups) {
          assert.equal(group.distinctObservationCount, 1);
          assert.equal(group.rule, "single_observation");
          assert.ok(group.observations.includes(good));
          assert.ok(!group.observations.includes(damaged), "битая строка не даёт claims");
          assert.ok(!group.observations.includes(claimless), "строка без фактов не даёт claims");
        }
      });

      await t.test("real CHECK, UNIQUE and FK constraints reject violations", async () => {
        const ctx = await scenario(db, "Constraints");
        const { sourceId } = await createSource(db);
        await attachSource(db, ctx.entityId, sourceId);
        const existing = await addObservation(db, {
          entityId: ctx.entityId,
          sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-10-10.",
        });

        const insert = (values) => () =>
          db
            .insertInto("osint_observations")
            .values({
              id: randomUUID(),
              source_id: sourceId,
              entity_id: ctx.entityId,
              content: "x",
              content_hash: randomUUID(),
              kind: "page",
              ...values,
            })
            .execute();

        // UNIQUE (source_id, content_hash)
        const duplicate = await db
          .selectFrom("osint_observations")
          .select(["content", "content_hash"])
          .where("id", "=", existing)
          .executeTakeFirstOrThrow();
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_observations")
              .values({
                id: randomUUID(),
                source_id: sourceId,
                entity_id: ctx.entityId,
                content: duplicate.content,
                content_hash: duplicate.content_hash,
                kind: "page",
              })
              .execute(),
          { code: "23505", constraint: "osint_observations_source_hash_idx" },
        );

        // CHECK char_length(content_hash) BETWEEN 1 AND 128
        await expectPgRejection(insert({ content_hash: "" }), {
          code: "23514",
          constraint: "osint_observations_hash_len",
        });
        await expectPgRejection(insert({ content_hash: "x".repeat(129) }), {
          code: "23514",
          constraint: "osint_observations_hash_len",
        });

        // CHECK kind IN (...)
        await expectPgRejection(insert({ kind: "unmapped_kind" }), {
          code: "23514",
          constraint: "osint_observations_kind_check",
        });

        // Foreign key на источник
        await expectPgRejection(
          insert({ source_id: randomUUID(), content_hash: randomUUID() }),
          { code: "23503", constraint: "osint_observations_source_fkey" },
        );

        // CHECK business_member.role — ровно три значения, других ролей нет.
        const otherUser = await makeUser(db, "Роль-нарушитель");
        const member = () =>
          db
            .insertInto("business_member")
            .values({
              business_id: ctx.business.id,
              user_id: otherUser,
              role: "viewer",
              status: "active",
            })
            .execute();
        const roleError = await expectPgRejection(member, {
          code: "23514",
          constraint: "business_member_role_check",
        });
        assert.match(
          [roleError.message, roleError.cause?.message].filter(Boolean).join(" "),
          /business_member_role_check/,
        );

        // PK (entity_id, source_id) на мосте источник↔сущность
        await expectPgRejection(
          () =>
            db
              .insertInto("osint_entity_sources")
              .values({
                entity_id: ctx.entityId,
                source_id: sourceId,
                confidence: "1",
                created_at: new Date(),
              })
              .execute(),
          { code: "23505", constraint: "osint_entity_sources_pkey" },
        );
      });

      await t.test("ASSESSMENT_LIMIT bounds the read to 200 observations", async () => {
        const ctx = await scenario(db, "Лимит чтения");
        const { sourceId } = await createSource(db);
        await attachSource(db, ctx.entityId, sourceId);

        const total = 205;
        await addObservations(db, {
          entityId: ctx.entityId,
          sourceId,
          count: total,
          contentOf: (index) => `Кафе №${index}. Телефон: 8 (3852) 55-10-10.`,
        });

        const rows = await db
          .selectFrom("osint_observations")
          .select("id")
          .where("entity_id", "=", ctx.entityId)
          .execute();
        assert.equal(rows.length, total, "в таблице действительно 205 строк");

        const result = await new OsintService(db).assessObservations(
          ctx.userId,
          ctx.business.public_id,
        );
        assert.equal(result.observationCount, 200, "LIMIT 200, а не полный скан");
        assert.ok(result.groups.length >= 1);
        for (const group of result.groups) {
          assert.ok(
            group.distinctObservationCount <= 200,
            "счётчик не выходит за предел чтения",
          );
        }
      });

      await t.test("re-running the assessment on unchanged data is deterministic", async () => {
        const ctx = await scenario(db, "Детерминизм");
        const first = await createSource(db);
        const second = await createSource(db);
        await attachSource(db, ctx.entityId, first.sourceId);
        await attachSource(db, ctx.entityId, second.sourceId);

        await addObservation(db, {
          entityId: ctx.entityId,
          sourceId: first.sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-10-10.",
        });
        await addObservation(db, {
          entityId: ctx.entityId,
          sourceId: second.sourceId,
          content: "Кафе. Телефон: 8 (3852) 55-22-33.",
        });

        const service = new OsintService(db);
        const run1 = await service.assessObservations(ctx.userId, ctx.business.public_id);
        const run2 = await service.assessObservations(ctx.userId, ctx.business.public_id);
        const run3 = await service.assessObservations(ctx.userId, ctx.business.public_id);

        assert.deepEqual(run2, run1, "повторный запуск байт-в-байт тот же");
        assert.deepEqual(run3, run1, "и третий тоже");

        const group = run1.groups.find((candidate) => candidate.predicate === "phone");
        assert.ok(group, "phone-группа присутствует");
        assert.equal(group.rule, "value_mismatch");
        assert.equal(group.contradictions.length, 1);
        const contradiction = group.contradictions[0];
        assert.equal(contradiction.resolution, "unresolved");
        assert.equal(contradiction.status, "unresolved");
        assert.equal(
          contradiction.id,
          run2.groups.find((candidate) => candidate.predicate === "phone")
            .contradictions[0].id,
          "id противоречия выводится из данных, а не из часов",
        );
        assert.deepEqual(
          group.provenance.map((pointer) => pointer.claimId).sort(),
          run3.groups
            .find((candidate) => candidate.predicate === "phone")
            .provenance.map((pointer) => pointer.claimId)
            .sort(),
          "provenance стабильна между запусками",
        );
        // Проверяем, что обе стороны действительно читаются из БД.
        assert.deepEqual(
          contradiction.sides.map((side) => side.value).sort(),
          [PHONE_A, PHONE_B].sort(),
        );
      });
    } finally {
      if (db) await db.destroy();
      if (created) {
        // Не рвём клиенты принудительно: поздний unhandled pool error после
        // успешных проверках сломал бы прогон уже после зелёного результата.
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
