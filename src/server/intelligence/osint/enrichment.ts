import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { log } from "../../observability/log.ts";
import { extractFacts, type StructuredSourceContext } from "./facts.ts";
import {
  changeFingerprint,
  factFingerprint,
  normalizeFactValue,
} from "./normalize.ts";
import {
  resolveEntityMatch,
  type EntityMatchResult,
  type ExtractedIdentity,
  type MatchableEntity,
} from "./entity-match.ts";
import { tenantObservationScope } from "./scope.ts";
import {
  jsonbArray,
  type OsintChangeKind,
  type OsintFactType,
} from "./schema.ts";

/**
 * Deterministic enrichment Stage 4 (§26.11): наблюдения → facts → changes →
 * contradictions → profile. Только чтение уже разрешённых Stage 3
 * наблюдений: ни сети, ни LLM (§26.19).
 *
 * Инварианты:
 *  - идемпотентность (§26.9): детерминированные fingerprint'ы + UNIQUE +
 *    state-based переходы stored → post; повторный запуск без изменений не
 *    даёт ни новой fact, ни нового change event;
 *  - тенантская изоляция (§7): наблюдения читаются через единый тенантский
 *    скоуп `tenantObservationScope` — 070 сделал целевые таблицы глобальными;
 *  - конкурентная безопасность (§26.16): partial UNIQUE «один активный run
 *    на бизнес» + FOR UPDATE SKIP LOCKED при claim — два воркера не выполняют
 *    enrichment одновременно; даже прямой параллельный вызов безопасен за
 *    счёт fingerprint-UNIQUE;
 *  - contradiction — не отказ пайплайна (§26.18): run завершается completed.
 */

export const ENRICHMENT_MAX_ATTEMPTS = 3;
const STALE_RUNNING_MS = 10 * 60 * 1000;

export type EnrichmentStats = {
  observations: number;
  factsExtracted: number;
  factsUpdated: number;
  factsChanged: number;
  contradictionsDetected: number;
  skippedCandidates: number;
};

const emptyStats = (): EnrichmentStats => ({
  observations: 0,
  factsExtracted: 0,
  factsUpdated: 0,
  factsChanged: 0,
  contradictionsDetected: 0,
  skippedCandidates: 0,
});

export type EnrichmentStatus = "completed" | "failed" | "in_progress";

export type EnrichmentOutcome = {
  runId: string;
  businessId: string;
  status: EnrichmentStatus;
  stats: EnrichmentStats;
  resolution: EntityMatchResult | null;
  error: string | null;
};

/* ========================================================================
 * Queue (§26.11): queued → running → completed/failed, ограниченный retry.
 * ====================================================================== */

/**
 * Ставит enrichment в очередь. Один активный run на бизнес: если queued/
 * running уже есть — возвращается он (created:false), дубль не создаётся.
 */
export async function enqueueEnrichment(
  db: Kysely<Database>,
  input: { businessId: string; discoveryRunId?: string | null },
): Promise<{ runId: string; created: boolean }> {
  const selectActive = () =>
    db
      .selectFrom("osint_enrichment_runs")
      .select("id")
      .where("business_id", "=", input.businessId)
      .where("status", "in", ["queued", "running"])
      .orderBy("created_at")
      .executeTakeFirst();

  const active = await selectActive();
  if (active) return { runId: active.id, created: false };

  try {
    const id = randomUUID();
    await db
      .insertInto("osint_enrichment_runs")
      .values({
        id,
        business_id: input.businessId,
        discovery_run_id: input.discoveryRunId ?? null,
        status: "queued",
      })
      .execute();
    return { runId: id, created: true };
  } catch (error) {
    // Гонка двух enqueue: partial UNIQUE гасит дубль — отдаём существующий.
    if ((error as { code?: string }).code === "23505") {
      const existing = await selectActive();
      if (existing) return { runId: existing.id, created: false };
    }
    throw error;
  }
}

type ClaimedRun = { id: string; businessId: string; attempts: number };

function toClaimed(row: {
  id: string;
  business_id: string;
  attempts: number;
}): ClaimedRun {
  return {
    id: row.id,
    businessId: row.business_id,
    attempts: Number(row.attempts),
  };
}

/** Переводит queued → running; null — run уже занят другим воркером. */
export async function claimEnrichment(
  db: Kysely<Database>,
  runId: string,
): Promise<ClaimedRun | null> {
  const result = await sql<{ id: string; business_id: string; attempts: number }>`
    UPDATE osint_enrichment_runs
    SET status = 'running',
        attempts = attempts + 1,
        started_at = now(),
        updated_at = now()
    WHERE id = ${runId} AND status = 'queued'
    RETURNING id, business_id, attempts
  `.execute(db);
  const row = result.rows[0];
  return row ? toClaimed(row) : null;
}

/** Следующий queued run для воркера: атомарный claim с SKIP LOCKED. */
export async function claimNextEnrichment(
  db: Kysely<Database>,
): Promise<ClaimedRun | null> {
  const result = await sql<{ id: string; business_id: string; attempts: number }>`
    UPDATE osint_enrichment_runs
    SET status = 'running',
        attempts = attempts + 1,
        started_at = now(),
        updated_at = now()
    WHERE id = (
      SELECT id FROM osint_enrichment_runs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, business_id, attempts
  `.execute(db);
  const row = result.rows[0];
  return row ? toClaimed(row) : null;
}

/**
 * Run'ы, упавшие вместе с процессом: при attempts < max возвращаются в
 * очередь, иначе закрываются как failed. Быстрые падения (исключение
 * до attempts) не крутятся вечно — ретраи ограничены.
 */
export async function releaseStaleEnrichmentRuns(
  db: Kysely<Database>,
): Promise<number> {
  const stale = await db
    .selectFrom("osint_enrichment_runs")
    .select(["id", "attempts"])
    .where("status", "=", "running")
    .where("started_at", "<", new Date(Date.now() - STALE_RUNNING_MS))
    .execute();

  let released = 0;
  for (const row of stale) {
    const next =
      Number(row.attempts) < ENRICHMENT_MAX_ATTEMPTS ? "queued" : "failed";
    // Re-check статуса в самом UPDATE: run, завершившийся в окне
    // SELECT→UPDATE, не возвращается в queued и не закрывается failed
    // после фактически успешного выполнения (TOCTOU).
    const updated = await db
      .updateTable("osint_enrichment_runs")
      .set({
        status: next,
        error: next === "failed" ? "stale_run_expired" : null,
        finished_at: next === "failed" ? new Date() : null,
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .where("status", "=", "running")
      .executeTakeFirst();
    if (Number(updated?.numUpdatedRows ?? 0) > 0) released += 1;
  }
  return released;
}

/**
 * Фоновый тик (§26.11): выполняет queued enrichment'ы. Retry ограничен
 * ENRICHMENT_MAX_ATTEMPTS — бесконечных повторов нет.
 */
export async function processQueuedEnrichments(
  db: Kysely<Database>,
  options: { limit?: number } = {},
): Promise<{ processed: number; completed: number; failed: number }> {
  const limit = options.limit ?? 1;
  await releaseStaleEnrichmentRuns(db);

  let processed = 0;
  let completed = 0;
  let failed = 0;
  while (processed < limit) {
    const claimed = await claimNextEnrichment(db);
    if (!claimed) break;
    processed += 1;
    const outcome = await runEnrichment(db, {
      businessId: claimed.businessId,
      runId: claimed.id,
      attempts: claimed.attempts,
    });
    if (outcome.status === "completed") completed += 1;
    else if (outcome.status === "failed") failed += 1;
  }
  return { processed, completed, failed };
}

/* ========================================================================
 * Core pipeline: load → extract → resolve → transaction(upsert/changes/
 * contradictions) → finish run.
 * ====================================================================== */

type LoadedObservation = {
  id: string;
  source_id: string;
  entity_id: string | null;
  content: string;
  observed_at: Date;
  entity_name: string | null;
  source_url: string | null;
  source_name: string | null;
};

type ExtractedDetail = {
  factType: OsintFactType;
  key: string;
  value: string;
  raw: string;
  sourceId: string;
  observationId: string;
  observedAt: Date;
  entityId: string | null;
  origin: string;
};

type RunEnrichmentInput = {
  businessId: string;
  /** Если run уже claimed воркером — работаем под ним. */
  runId?: string | null;
  /** Attempts из claim (для решения requeue/failed). */
  attempts?: number;
  discoveryRunId?: string | null;
};

export async function runEnrichment(
  db: Kysely<Database>,
  input: RunEnrichmentInput,
): Promise<EnrichmentOutcome> {
  let runId = input.runId ?? null;
  let attempts = input.attempts ?? 1;

  if (!runId) {
    // Прямой вызов (юнит-тесты, инструменты): ставим в очередь сами.
    const enqueued = await enqueueEnrichment(db, {
      businessId: input.businessId,
      discoveryRunId: input.discoveryRunId ?? null,
    });
    runId = enqueued.runId;
    const claimed = await claimEnrichment(db, runId);
    if (!claimed) {
      const row = await db
        .selectFrom("osint_enrichment_runs")
        .select("status")
        .where("id", "=", runId)
        .executeTakeFirst();
      const busy = row?.status === "running";
      return {
        runId,
        businessId: input.businessId,
        status: busy ? "in_progress" : "failed",
        stats: emptyStats(),
        resolution: null,
        error: busy ? "enrichment_in_progress" : "enrichment_not_claimable",
      };
    }
    attempts = claimed.attempts;
  }

  log("info", "OSINT_ENRICHMENT_STARTED", {
    run_id: runId,
    business_id: input.businessId,
    attempt: attempts,
  });

  try {
    const outcome = await executeEnrichment(db, input.businessId, runId);
    await finishRun(
      db,
      runId,
      "completed",
      outcome.stats,
      outcome.resolution,
      null,
    );
    log("info", "OSINT_ENRICHMENT_COMPLETED", {
      run_id: runId,
      business_id: input.businessId,
      observations: outcome.stats.observations,
      facts_extracted: outcome.stats.factsExtracted,
      facts_updated: outcome.stats.factsUpdated,
      facts_changed: outcome.stats.factsChanged,
      contradictions_detected: outcome.stats.contradictionsDetected,
      resolution: outcome.resolution.status,
    });
    return {
      runId,
      businessId: input.businessId,
      status: "completed",
      stats: outcome.stats,
      resolution: outcome.resolution,
      error: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message.slice(0, 500) : String(error);
    let next: "queued" | "failed";
    if (attempts < ENRICHMENT_MAX_ATTEMPTS) {
      next = await requeueOrFail(db, runId, attempts, message);
    } else {
      await markFailed(db, runId, message);
      next = "failed";
    }
    log("error", "OSINT_ENRICHMENT_FAILED", {
      run_id: runId,
      business_id: input.businessId,
      attempt: attempts,
      next,
      error: message,
    });
    return {
      runId,
      businessId: input.businessId,
      status: "failed",
      stats: emptyStats(),
      resolution: null,
      error: message,
    };
  }
}

async function requeueOrFail(
  db: Kysely<Database>,
  runId: string,
  attempts: number,
  error: string,
): Promise<"queued" | "failed"> {
  if (attempts >= ENRICHMENT_MAX_ATTEMPTS) {
    await markFailed(db, runId, error);
    return "failed";
  }
  await db
    .updateTable("osint_enrichment_runs")
    .set({
      status: "queued",
      error,
      started_at: null,
      updated_at: new Date(),
    })
    .where("id", "=", runId)
    .execute();
  return "queued";
}

async function markFailed(
  db: Kysely<Database>,
  runId: string,
  error: string,
): Promise<void> {
  await db
    .updateTable("osint_enrichment_runs")
    .set({
      status: "failed",
      error,
      finished_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", runId)
    .execute();
}

async function finishRun(
  db: Kysely<Database>,
  runId: string,
  status: "completed" | "failed",
  stats: EnrichmentStats,
  resolution: EntityMatchResult | null,
  error: string | null,
): Promise<void> {
  await db
    .updateTable("osint_enrichment_runs")
    .set({
      status,
      error,
      stats: { ...stats, resolution },
      finished_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", runId)
    .execute();
}

/**
 * Материал для извлечения: ПОСЛЕДНЕЕ наблюдение каждого источника (§26.3).
 *
 * Наблюдения append-only (новый краул добавляет строку, старая остаётся в
 * истории), а fact-жизненный цикл отвечает на вопрос «что источник
 * сообщает СЕЙЧАС». Берём по одной самой свежей строке на источник — тогда
 * обновление страницы (новое значение телефона) закрывает старое, а
 * исчезнувшие значения честно уходят в STALE/VALUE_DISAPPEARED. Единый
 * тенант-скоуп §7; по строке на источник — выборка ограничена числом
 * источников, весь граф в память не грузится (§26.20).
 */
async function loadObservations(
  db: Kysely<Database>,
  businessId: string,
): Promise<LoadedObservation[]> {
  const result = await sql<LoadedObservation>`
    SELECT DISTINCT ON (o.source_id)
           o.id, o.source_id, o.entity_id, o.content, o.observed_at,
           e.display_name AS entity_name,
           s.normalized_url AS source_url,
           s.name AS source_name
    FROM osint_observations o
    LEFT JOIN osint_entities e ON e.id = o.entity_id
    LEFT JOIN osint_sources s ON s.id = o.source_id
    WHERE ${tenantObservationScope(businessId)}
    ORDER BY o.source_id, o.observed_at DESC, o.id DESC
  `.execute(db);
  return result.rows;
}

async function loadSourceContexts(
  db: Kysely<Database>,
  sourceIds: string[],
): Promise<Map<string, StructuredSourceContext>> {
  const map = new Map<string, StructuredSourceContext>();
  if (sourceIds.length === 0) return map;
  const rows = await db
    .selectFrom("osint_source_context")
    .select([
      "source_id",
      "canonical_name",
      "category",
      "city",
      "region",
      "country",
      "address",
      "contacts",
      "domains",
      "social_links",
    ])
    .where("source_id", "in", sourceIds)
    .execute();
  for (const row of rows) {
    map.set(row.source_id, {
      canonical_name: row.canonical_name,
      category: row.category,
      city: row.city,
      region: row.region,
      country: row.country,
      address: row.address,
      contacts: row.contacts,
      domains: row.domains,
      social_links: row.social_links,
    });
  }
  return map;
}

async function loadBridgeEntities(
  db: Kysely<Database>,
  businessId: string,
): Promise<MatchableEntity[]> {
  const rows = await db
    .selectFrom("osint_business_entities as be")
    .innerJoin("osint_entities as e", "e.id", "be.entity_id")
    .select([
      "e.id as id",
      "e.display_name as display_name",
      "e.phone as phone",
      "e.website as website",
      "e.city as city",
      "e.identity_key as identity_key",
    ])
    .where("be.business_id", "=", businessId)
    .where("be.status", "<>", "rejected")
    .orderBy("be.created_at")
    .orderBy("be.entity_id")
    .limit(50)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    displayName: row.display_name,
    phone: row.phone,
    website: row.website,
    city: row.city,
    identityKey: row.identity_key,
  }));
}

type ExecutionResult = {
  stats: EnrichmentStats;
  resolution: EntityMatchResult;
};

async function executeEnrichment(
  db: Kysely<Database>,
  businessId: string,
  runId: string,
): Promise<ExecutionResult> {
  const stats = emptyStats();

  // --- Load + extract (вне транзакции) -----------------------------------
  const observations = await loadObservations(db, businessId);
  stats.observations = observations.length;

  const sourceIds = [...new Set(observations.map((row) => row.source_id))];
  const contexts = await loadSourceContexts(db, sourceIds);

  // Детерминированный порядок: по id наблюдения → стабильный выбор raw.
  const extractedByKey = new Map<string, ExtractedDetail>();
  for (const observation of observations) {
    const candidates = extractFacts({
      content: observation.content,
      entityName: observation.entity_name,
      sourceUrl: observation.source_url,
      sourceContext: contexts.get(observation.source_id) ?? null,
    });
    for (const candidate of candidates) {
      const normalized = normalizeFactValue(
        candidate.factType,
        candidate.rawValue,
      );
      if (!normalized) {
        stats.skippedCandidates += 1;
        continue;
      }
      const mapKey = `${observation.source_id}\u0000${candidate.factType}\u0000${normalized.key}`;
      if (extractedByKey.has(mapKey)) continue;
      extractedByKey.set(mapKey, {
        factType: candidate.factType,
        key: normalized.key,
        value: normalized.value,
        raw: candidate.rawValue,
        sourceId: observation.source_id,
        observationId: observation.id,
        observedAt: observation.observed_at,
        entityId: observation.entity_id,
        origin: candidate.origin,
      });
    }
  }

  // --- Entity resolution (§26.6) ------------------------------------------
  const identity = buildExtractedIdentity([...extractedByKey.values()]);
  const entities = await loadBridgeEntities(db, businessId);
  const resolution = resolveEntityMatch(entities, identity);

  // --- Transaction: upsert → transitions → changes → contradictions -------
  await db.transaction().execute(async (trx) => {
    const stored = await trx
      .selectFrom("osint_intelligence_facts")
      .select([
        "id",
        "fact_type",
        "fact_key",
        "value",
        "source_id",
        "observation_id",
        "entity_id",
        "status",
        "last_seen_at",
      ])
      .where("business_id", "=", businessId)
      .orderBy("fact_type")
      .orderBy("fact_key")
      .orderBy("source_id")
      .execute();

    const storedByFingerprint = new Map(
      stored.map((row) => [
        factFingerprint({
          businessId,
          factType: row.fact_type,
          factKey: row.fact_key,
          sourceId: row.source_id,
        }),
        row,
      ]),
    );

    // before-состояние (state-based детекция → идемпотентность §26.9)
    const beforeActive = new Map<
      string,
      { sources: Set<string>; rep: (typeof stored)[number] }
    >();
    const beforeAll = new Set<string>();
    for (const row of stored) {
      const composite = `${row.fact_type}\u0000${row.fact_key}`;
      beforeAll.add(composite);
      if (row.status !== "ACTIVE") continue;
      const bucket = beforeActive.get(composite);
      if (bucket) bucket.sources.add(row.source_id);
      else
        beforeActive.set(composite, {
          sources: new Set([row.source_id]),
          rep: row,
        });
    }

    // Upsert каждой извлечённой fact-строки.
    const afterActive = new Map<
      string,
      { sources: Set<string>; detail: ExtractedDetail }
    >();
    for (const detail of extractedByKey.values()) {
      const composite = `${detail.factType}\u0000${detail.key}`;
      const bucket = afterActive.get(composite);
      if (bucket) bucket.sources.add(detail.sourceId);
      else afterActive.set(composite, { sources: new Set([detail.sourceId]), detail });

      const fingerprint = factFingerprint({
        businessId,
        factType: detail.factType,
        factKey: detail.key,
        sourceId: detail.sourceId,
      });
      const existing = storedByFingerprint.get(fingerprint);
      const now = new Date();
      if (existing) {
        stats.factsUpdated += 1;
        await trx
          .updateTable("osint_intelligence_facts")
          .set({
            status: "ACTIVE",
            last_seen_at: now,
            observed_at: detail.observedAt,
            extracted_at: now,
            raw_value: detail.raw,
            observation_id: detail.observationId,
            entity_id: detail.entityId,
            updated_at: now,
          })
          .where("id", "=", existing.id)
          .execute();
      } else {
        stats.factsExtracted += 1;
        await trx
          .insertInto("osint_intelligence_facts")
          .values({
            id: randomUUID(),
            business_id: businessId,
            entity_id: detail.entityId,
            fact_type: detail.factType,
            fact_key: detail.key,
            value: detail.value,
            raw_value: detail.raw,
            source_id: detail.sourceId,
            observation_id: detail.observationId,
            status: "ACTIVE",
            fingerprint,
            first_seen_at: now,
            last_seen_at: now,
            observed_at: detail.observedAt,
            extracted_at: now,
            metadata: { origin: detail.origin, run_id: runId },
          })
          .onConflict((oc) =>
            oc.columns(["business_id", "fingerprint"]).doUpdateSet({
              status: "ACTIVE",
              last_seen_at: now,
              observed_at: detail.observedAt,
              extracted_at: now,
              raw_value: detail.raw,
              observation_id: detail.observationId,
              entity_id: detail.entityId,
              updated_at: now,
            }),
          )
          .execute();
      }
    }

    // --- State-based transitions (§26.9) -----------------------------------
    const changes: {
      factType: OsintFactType;
      factKey: string;
      changeKind: OsintChangeKind;
      oldValue: string | null;
      newValue: string | null;
      sourceId: string | null;
      observationId: string | null;
      entityId: string | null;
    }[] = [];

    const byType = (composite: string): OsintFactType =>
      composite.split("\u0000")[0] as OsintFactType;
    const keyOf = (composite: string): string =>
      composite.slice(composite.indexOf("\u0000") + 1);

    const types = [
      ...new Set(
        [...beforeActive.keys(), ...afterActive.keys()].map(byType),
      ),
    ].sort();

    for (const type of types) {
      const beforeKeys = [...beforeActive.keys()]
        .filter((c) => byType(c) === type)
        .sort();
      const afterKeys = [...afterActive.keys()]
        .filter((c) => byType(c) === type)
        .sort();
      const appeared = afterKeys.filter((c) => !beforeKeys.includes(c));
      const disappeared = beforeKeys.filter((c) => !afterKeys.includes(c));

      // Ровно одно исчезло и ровно одно появилось — это замена значения.
      const pairValueChange = appeared.length === 1 && disappeared.length === 1;

      for (const composite of appeared) {
        const key = keyOf(composite);
        const detail = afterActive.get(composite)!.detail;
        if (pairValueChange) {
          const oldRep = beforeActive.get(disappeared[0]!)!.rep;
          changes.push({
            factType: type,
            factKey: key,
            changeKind: "VALUE_CHANGED",
            oldValue: oldRep.value,
            newValue: detail.value,
            sourceId: detail.sourceId,
            observationId: detail.observationId,
            entityId: detail.entityId,
          });
          continue;
        }
        const reappeared = beforeAll.has(composite);
        changes.push({
          factType: type,
          factKey: key,
          changeKind: reappeared ? "VALUE_REAPPEARED" : "FIRST_SEEN",
          oldValue: null,
          newValue: detail.value,
          sourceId: detail.sourceId,
          observationId: detail.observationId,
          entityId: detail.entityId,
        });
      }

      if (!pairValueChange) {
        for (const composite of disappeared) {
          const rep = beforeActive.get(composite)!.rep;
          changes.push({
            factType: type,
            factKey: keyOf(composite),
            changeKind: "VALUE_DISAPPEARED",
            oldValue: rep.value,
            newValue: null,
            sourceId: rep.source_id,
            observationId: rep.observation_id,
            entityId: rep.entity_id,
          });
        }
      }

      // Закрытые before-строки: RETIRED при замене, STALE при исчезновении.
      for (const composite of disappeared) {
        const nextStatus = pairValueChange ? "RETIRED" : "STALE";
        await trx
          .updateTable("osint_intelligence_facts")
          .set({ status: nextStatus, updated_at: new Date() })
          .where("business_id", "=", businessId)
          .where("fact_type", "=", type)
          .where("fact_key", "=", keyOf(composite))
          .where("status", "=", "ACTIVE")
          .execute();
      }

      // Новый источник подтверждает уже известное значение → SOURCE_CHANGED.
      for (const composite of afterKeys.filter((c) => beforeKeys.includes(c))) {
        const after = afterActive.get(composite)!;
        const before = beforeActive.get(composite)!;
        for (const sourceId of [...after.sources].sort()) {
          if (before.sources.has(sourceId)) continue;
          changes.push({
            factType: type,
            factKey: keyOf(composite),
            changeKind: "SOURCE_CHANGED",
            oldValue: null,
            newValue: after.detail.value,
            sourceId,
            observationId: after.detail.observationId,
            entityId: after.detail.entityId,
          });
        }
      }
    }

    for (const change of changes) {
      stats.factsChanged += 1;
      await trx
        .insertInto("osint_fact_changes")
        .values({
          id: randomUUID(),
          business_id: businessId,
          entity_id: change.entityId,
          fact_type: change.factType,
          fact_key: change.factKey,
          change_kind: change.changeKind,
          old_value: change.oldValue,
          new_value: change.newValue,
          source_id: change.sourceId,
          observation_id: change.observationId,
          fingerprint: changeFingerprint({
            businessId,
            factType: change.factType,
            factKey: change.factKey,
            changeKind: change.changeKind,
            oldValue: change.oldValue,
            newValue: change.newValue,
            sourceId: change.sourceId,
          }),
          metadata: { run_id: runId },
        })
        .onConflict((oc) => oc.columns(["business_id", "fingerprint"]).doNothing())
        .execute();
    }

    // --- Contradictions (§26.10) -------------------------------------------
    stats.contradictionsDetected = await reconcileContradictions(
      trx,
      businessId,
    );
    if (stats.contradictionsDetected > 0) {
      log("info", "OSINT_CONTRADICTION_DETECTED", {
        business_id: businessId,
        run_id: runId,
        count: stats.contradictionsDetected,
      });
    }
  });

  return { stats, resolution };
}

type ContradictionSide = {
  value: string;
  sources: { id: string; name: string; url: string }[];
  observations: string[];
  firstSeen: string;
  lastSeen: string;
};

function sidesEqual(a: unknown, b: readonly ContradictionSide[]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i += 1) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i]!;
    if (x.value !== y.value) return false;
    if (x.firstSeen !== y.firstSeen || x.lastSeen !== y.lastSeen) return false;
    const xObs = x.observations;
    if (
      !Array.isArray(xObs) ||
      xObs.join("\u0000") !== y.observations.join("\u0000")
    )
      return false;
    const xSources = x.sources;
    if (!Array.isArray(xSources) || xSources.length !== y.sources.length)
      return false;
    for (let j = 0; j < y.sources.length; j += 1) {
      const xs = xSources[j] as Record<string, unknown> | undefined;
      if (
        !xs ||
        xs.id !== y.sources[j]!.id ||
        xs.name !== y.sources[j]!.name ||
        xs.url !== y.sources[j]!.url
      )
        return false;
    }
  }
  return true;
}

/**
 * Пересчёт противоречий (§26.10): ≥2 активных значения, ≥2 источника и НЕ
 * одинаковые множества источников у всех значений (один источник с двумя
 * номерами — его собственный список, не противоречие). Победитель не
 * выбирается; detected_at и resolved-статус пересчёт не трогает.
 *
 * Возвращает число ВНОВЫХ записей — повторный пересчёт без изменений даёт 0.
 */
async function reconcileContradictions(
  trx: Kysely<Database>,
  businessId: string,
): Promise<number> {
  const active = await trx
    .selectFrom("osint_intelligence_facts as f")
    .innerJoin("osint_sources as s", "s.id", "f.source_id")
    .select([
      "f.fact_type as fact_type",
      "f.fact_key as fact_key",
      "f.value as value",
      "f.source_id as source_id",
      "f.observation_id as observation_id",
      "f.first_seen_at as first_seen_at",
      "f.last_seen_at as last_seen_at",
      "s.name as source_name",
      "s.normalized_url as source_url",
    ])
    .where("f.business_id", "=", businessId)
    .where("f.status", "=", "ACTIVE")
    .orderBy("f.fact_type")
    .orderBy("f.fact_key")
    .orderBy("f.source_id")
    .execute();

  // fact_type → fact_key → одна сторона (значение) со своими источниками.
  const byType = new Map<OsintFactType, Map<string, ContradictionSide>>();
  for (const row of active) {
    let keys = byType.get(row.fact_type);
    if (!keys) {
      keys = new Map();
      byType.set(row.fact_type, keys);
    }
    let side = keys.get(row.fact_key);
    if (!side) {
      side = {
        value: row.value,
        sources: [],
        observations: [],
        firstSeen: row.first_seen_at.toISOString(),
        lastSeen: row.last_seen_at.toISOString(),
      };
      keys.set(row.fact_key, side);
    }
    if (!side.sources.some((source) => source.id === row.source_id)) {
      side.sources.push({
        id: row.source_id,
        name: row.source_name,
        url: row.source_url,
      });
    }
    if (!side.observations.includes(row.observation_id)) {
      side.observations.push(row.observation_id);
    }
    if (row.first_seen_at.toISOString() < side.firstSeen)
      side.firstSeen = row.first_seen_at.toISOString();
    if (row.last_seen_at.toISOString() > side.lastSeen)
      side.lastSeen = row.last_seen_at.toISOString();
  }

  const existing = await trx
    .selectFrom("osint_intelligence_contradictions")
    .select(["id", "fact_type", "sides", "value_count", "source_count"])
    .where("business_id", "=", businessId)
    .execute();
  const existingByType = new Map(existing.map((row) => [row.fact_type, row]));

  let inserted = 0;
  const seenTypes = new Set<OsintFactType>();

  for (const [factType, keys] of byType) {
    seenTypes.add(factType);
    const sides: ContradictionSide[] = [...keys.values()]
      .map((side) => ({
        ...side,
        sources: [...side.sources].sort((a, b) => (a.id < b.id ? -1 : 1)),
        observations: [...side.observations].sort(),
      }))
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));

    const distinctSources = new Set(
      sides.flatMap((side) => side.sources.map((source) => source.id)),
    );
    const firstSupport = JSON.stringify(
      sides[0]!.sources.map((source) => source.id),
    );
    const identicalSupport = sides.every(
      (side) => JSON.stringify(side.sources.map((source) => source.id)) === firstSupport,
    );
    const qualifies =
      sides.length >= 2 && distinctSources.size >= 2 && !identicalSupport;

    const existingRow = existingByType.get(factType);
    if (!qualifies) {
      if (existingRow) {
        await trx
          .deleteFrom("osint_intelligence_contradictions")
          .where("id", "=", existingRow.id)
          .execute();
      }
      continue;
    }

    if (existingRow) {
      const changed =
        !sidesEqual(existingRow.sides, sides) ||
        existingRow.value_count !== sides.length ||
        existingRow.source_count !== distinctSources.size;
      if (changed) {
        await trx
          .updateTable("osint_intelligence_contradictions")
          .set({
            sides: jsonbArray(sides),
            value_count: sides.length,
            source_count: distinctSources.size,
            updated_at: new Date(),
          })
          .where("id", "=", existingRow.id)
          .execute();
      }
      continue;
    }

    await trx
      .insertInto("osint_intelligence_contradictions")
      .values({
        id: randomUUID(),
        business_id: businessId,
        fact_type: factType,
        sides: jsonbArray(sides),
        value_count: sides.length,
        source_count: distinctSources.size,
        status: "unresolved",
      })
      .execute();
    inserted += 1;
  }

  // Типы без активных фактов больше не поддерживают противоречие.
  for (const [factType, row] of existingByType) {
    if (seenTypes.has(factType)) continue;
    await trx
      .deleteFrom("osint_intelligence_contradictions")
      .where("id", "=", row.id)
      .execute();
  }

  return inserted;
}

function buildExtractedIdentity(details: ExtractedDetail[]): ExtractedIdentity {
  const names: string[] = [];
  const phones: string[] = [];
  const domains: string[] = [];
  const cities: string[] = [];
  for (const detail of details) {
    if (detail.factType === "business_name") {
      if (!names.includes(detail.value)) names.push(detail.value);
    } else if (detail.factType === "phone") {
      if (!phones.includes(detail.key)) phones.push(detail.key);
    } else if (detail.factType === "domain") {
      if (!domains.includes(detail.key)) domains.push(detail.key);
    } else if (detail.factType === "website") {
      try {
        const host = new URL(detail.value).hostname.replace(/^www\./, "");
        if (!domains.includes(host)) domains.push(host);
      } catch {
        // Канонический URL из normalizeWebUrl всегда валиден; defensive.
      }
    } else if (detail.factType === "city") {
      if (!cities.includes(detail.key)) cities.push(detail.key);
    }
  }
  return { names, phones, domains, cities };
}
