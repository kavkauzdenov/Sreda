import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.ts";
import type { Claim, Evidence } from "@/lib/intelligence-contracts.ts";
import { requireBusiness } from "../access/permissions.ts";
import { AppError } from "../http/errors.ts";
import { createBuiltinRegistry } from "./osint/providers/builtin.ts";
import type { ProviderRegistry } from "./osint/providers/registry.ts";
import {
  createDiscoveryRun,
  releaseStaleDiscoveryRuns,
  runDiscovery,
  type CrawlPhaseOptions,
  type DiscoveryRunResult,
} from "./osint/discovery.ts";
import {
  mergeDiscoveryBudget,
  type DiscoveryBudget,
} from "./osint/config.ts";
import { normalizeExplicitSeeds } from "./osint/seed.ts";
import { tenantObservationScope } from "./osint/scope.ts";
import {
  assertClaimSupportedKind,
  isClaimSupportedObservationKind,
  toEvidence,
  type ObservationRow,
} from "./osint/evidence.ts";
import { extractClaims } from "./osint/claims.ts";
import { assessClaims } from "./osint/assessment.ts";
import {
  buildProfile,
  listChanges,
  listContradictions,
  listFacts,
} from "./osint/profile-projection.ts";
import type {
  OsintDiscoveryEnqueued,
  OsintDiscoveryRunOutcome,
  OsintIntelChange,
  OsintIntelContradiction,
  OsintIntelFact,
  OsintIntelPage,
  OsintIntelProfile,
  OsintRunStatusInfo,
  OsintSnapshot,
  Stage3Assessment,
  Stage3EntityInfo,
  Stage3ObservationSlice,
  Stage3Reason,
  Stage3SourceInfo,
} from "@/lib/intelligence-types.ts";

const RUN_LIMIT = 5;
const CANDIDATE_LIMIT = 50;
const LIST_LIMIT = 50;
/** Сколько тенантских наблюдений читает bulk-оценка (§1 — без полного скана). */
const ASSESSMENT_LIMIT = 200;
/** Сколько неуспешных URL отдаёт статус run'а. */
const RUN_FAILURE_LIMIT = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Опции сервиса. По умолчанию crawl выключен — синхронный startDiscovery
 * ведёт себя ровно как на Этапе 2 (никакой сети в юнит-тестах). Включается
 * явно E2E-тестами; HTTP-путь использует enqueueDiscovery + фоновый воркер.
 */
export type OsintServiceOptions = {
  /** Crawl-фаза в синхронном startDiscovery. */
  crawl?: boolean;
  /** Настройки crawl-фазы (провайдер, robots, allowPrivateNetworks). */
  crawlOptions?: CrawlPhaseOptions | null;
  /** Готовый реестр (юнит-тесты); иначе собирается builtin-набор. */
  registry?: ProviderRegistry;
};

/** Наблюдение + субъект, выбранный тем же ранжированием, что у v1. */
type AssessmentRow = ObservationRow & {
  display_name: string | null;
  identity_key: string | null;
};

const OBSERVATION_NOT_FOUND = () =>
  new AppError(404, "OBSERVATION_NOT_FOUND", "Наблюдение не найдено.");

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/**
 * Единственная runtime-точка подключения OSINT-подсистемы к приложению.
 *
 * Domain-код (`osint/**`) намеренно не знает про HTTP и права: здесь
 * authorization → orchestration → DTO. Цепочка:
 * HTTP route → OsintService → osint/discovery → osint/candidates → БД → audit.
 */
export class OsintService {
  constructor(
    private db: Kysely<Database>,
    private options: OsintServiceOptions = {},
  ) {}

  /**
   * Прозрачность: какими провайдерами реально пользуется run.
   * Реестр создаётся свежим на каждый вызов — emit-once провайдеры
   * (own_urls) отдают результаты ровно одному run'у.
   */
  private registry() {
    return this.options.registry ?? createBuiltinRegistry();
  }

  async getSnapshot(userId: string, publicId: string): Promise<OsintSnapshot> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );

    const runs = await this.db
      .selectFrom("osint_discovery_runs")
      .select([
        "id",
        "status",
        "queries_count",
        "results_count",
        "candidates_count",
        "accepted_count",
        "review_count",
        "rejected_count",
        "duplicates_count",
        "error",
        "created_at",
        "finished_at",
        "depth",
        "max_depth",
        "stats",
      ])
      .where("business_id", "=", member.id)
      .orderBy("created_at", "desc")
      .limit(RUN_LIMIT)
      .execute();

    const candidateRows = await this.db
      .selectFrom("osint_source_candidates")
      .select([
        "id",
        "url",
        "title",
        "type",
        "status",
        "confidence",
        "match_reasons",
        "provider",
        "source_id",
        "discovered_at",
      ])
      .where("business_id", "=", member.id)
      .orderBy("discovered_at", "desc")
      .limit(CANDIDATE_LIMIT)
      .execute();

    const statusCounts = await this.db
      .selectFrom("osint_source_candidates")
      .select((eb) => [
        "status",
        eb.fn.countAll<number>().as("n"),
      ])
      .where("business_id", "=", member.id)
      .groupBy("status")
      .execute();

    const candidateTotal = await this.db
      .selectFrom("osint_source_candidates")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("business_id", "=", member.id)
      .executeTakeFirstOrThrow();

    // Счётчики — настоящие COUNT'ы, а не длина списка: списки обрезаны
    // RUN_LIMIT/LIST_LIMIT, и счётчик на их основе врал бы на больших данных.
    const runTotal = await this.db
      .selectFrom("osint_discovery_runs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("business_id", "=", member.id)
      .executeTakeFirstOrThrow();

    // Отклонённые мосты не дают видимости §4 — не считаем их и не
    // показываем (счётчики и список согласованы с drill-down).
    const bridgeTotal = await sql<{ n: number }>`
      SELECT count(DISTINCT entity_id)::int AS n
      FROM osint_business_entities
      WHERE business_id = ${member.id}
        AND status <> 'rejected'
    `.execute(this.db);

    // Источники — настоящий COUNT через мосты (≠ rejected) → связи
    // entity_sources: список ниже обрезан LIST_LIMIT, длина массива
    // sourceIds врала бы на больших данных.
    const sourcesTotal = await sql<{ n: number }>`
      SELECT count(DISTINCT es.source_id)::int AS n
      FROM osint_business_entities be
      JOIN osint_entity_sources es ON es.entity_id = be.entity_id
      WHERE be.business_id = ${member.id}
        AND be.status <> 'rejected'
    `.execute(this.db);

    // Глобальный слой читается только через тенантский мост §4.
    const bridges = await this.db
      .selectFrom("osint_business_entities")
      .select(["entity_id", "relationship", "status"])
      .where("business_id", "=", member.id)
      .where("status", "<>", "rejected")
      .orderBy("created_at", "desc")
      .limit(LIST_LIMIT)
      .execute();

    const entityIds = [...new Set(bridges.map((row) => row.entity_id))];

    const entityRows = entityIds.length
      ? await this.db
          .selectFrom("osint_entities")
          .select([
            "id",
            "kind",
            "display_name",
            "identity_key",
            "category",
            "city",
            "website",
          ])
          .where("id", "in", entityIds)
          .execute()
      : [];

    const links = entityIds.length
      ? await this.db
          .selectFrom("osint_entity_sources")
          .select("source_id")
          .where("entity_id", "in", entityIds)
          .execute()
      : [];
    const sourceIds = [...new Set(links.map((row) => row.source_id))];

    const sourceRows = sourceIds.length
      ? await this.db
          .selectFrom("osint_sources")
          .select([
            "id",
            "name",
            "normalized_url",
            "type",
            "trust_level",
            "status",
            "provider",
            "created_at",
          ])
          .where("id", "in", sourceIds)
          .orderBy("created_at", "desc")
          .limit(LIST_LIMIT)
          .execute()
      : [];

    const countByStatus = (status: string) =>
      Number(
        statusCounts.find((row) => row.status === status)?.n ?? 0,
      );

    // Списки отсортированы created_at DESC — держим самый свежий мост.
    const relationshipByEntity = new Map<
      string,
      { relationship: string; bridgeStatus: string }
    >();
    for (const row of bridges) {
      if (relationshipByEntity.has(row.entity_id)) continue;
      relationshipByEntity.set(row.entity_id, {
        relationship: row.relationship,
        bridgeStatus: row.status,
      });
    }

    return {
      providers: this.registry().descriptorInfo().map((info) => ({
        id: info.descriptor.id,
        label: info.descriptor.label,
        requiresNetwork: info.descriptor.requiresNetwork,
        policy: info.descriptor.policy,
        enabledByDefault: info.descriptor.enabledByDefault,
        available: info.availability.available,
        unavailableReason: info.availability.available
          ? null
          : info.availability.reason,
      })),
      counts: {
        runs: Number(runTotal?.n ?? 0),
        candidates: Number(candidateTotal?.n ?? 0),
        pending: countByStatus("candidate"),
        accepted: countByStatus("accepted"),
        rejected: countByStatus("rejected"),
        sources: Number(sourcesTotal.rows[0]?.n ?? 0),
        entities: Number(bridgeTotal.rows[0]?.n ?? 0),
      },
      runs: runs.map((row) => ({
        id: row.id,
        status: row.status,
        queriesCount: row.queries_count,
        resultsCount: row.results_count,
        candidatesCount: row.candidates_count,
        acceptedCount: row.accepted_count,
        reviewCount: row.review_count,
        rejectedCount: row.rejected_count,
        duplicatesCount: row.duplicates_count,
        error: row.error,
        createdAt: iso(row.created_at) ?? "",
        finishedAt: iso(row.finished_at),
        depth: row.depth,
        maxDepth: row.max_depth,
        stats: (row.stats ?? {}) as Record<string, unknown>,
      })),
      candidates: candidateRows.map((row) => ({
        id: row.id,
        url: row.url,
        title: row.title,
        type: row.type,
        status: row.status,
        confidence: row.confidence,
        matchReasons: row.match_reasons,
        provider: row.provider,
        hasSource: row.source_id !== null,
        discoveredAt: iso(row.discovered_at) ?? "",
      })),
      entities: entityRows.map((row) => ({
        id: row.id,
        kind: row.kind,
        displayName: row.display_name,
        identityKey: row.identity_key,
        category: row.category,
        city: row.city,
        website: row.website,
        relationship: relationshipByEntity.get(row.id)?.relationship ?? "ABOUT",
        bridgeStatus:
          relationshipByEntity.get(row.id)?.bridgeStatus ?? "candidate",
      })),
      sources: sourceRows.map((row) => ({
        id: row.id,
        name: row.name,
        url: row.normalized_url,
        type: row.type,
        trustLevel: row.trust_level,
        status: row.status,
        provider: row.provider,
        createdAt: iso(row.created_at) ?? "",
      })),
    };
  }

  /**
   * Единый тенант-скоуп наблюдений (§7) — делегирует общему фрагменту,
   * чтобы enrichment Stage 4 и все читатели делили одну предпосылку.
   */
  private tenantScope(businessId: string) {
    return tenantObservationScope(businessId);
  }

  /**
   * Stage 3 runtime v1: вертикальный slice
   * Stage 2 observation → Evidence → Claim → Provenance.
   *
   * Read-model поверх Stage 2: ничего не пишется и не дублируется.
   * Tenant isolation — здесь, на сервере: наблюдение глобальное, поэтому
   * доступ выдаётся только через тенантский мост `osint_business_entities`
   * (status <> 'rejected'), либо через `osint_entity_sources` → мост.
   * Иначе — 404, без утечки факта существования чужой строки.
   */
  async explainObservation(
    userId: string,
    publicId: string,
    observationId: string,
  ): Promise<Stage3ObservationSlice> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );

    if (!UUID_RE.test(observationId)) throw OBSERVATION_NOT_FOUND();

    const scoped = await sql<ObservationRow>`
      SELECT o.id, o.source_id, o.entity_id, o.content, o.content_hash,
             o.observed_at, o.created_at, o.kind
      FROM osint_observations o
      WHERE o.id = ${observationId}
        AND ${this.tenantScope(member.id)}
      LIMIT 1
    `.execute(this.db);

    const row = scoped.rows[0];
    if (!row) throw OBSERVATION_NOT_FOUND();

    assertClaimSupportedKind(row.kind);
    const evidence = toEvidence(row);

    const sourceRow = await this.db
      .selectFrom("osint_sources")
      .select(["id", "name", "url", "type", "trust_level", "provider"])
      .where("id", "=", row.source_id)
      .executeTakeFirst();

    const source: Stage3SourceInfo | null = sourceRow
      ? {
          id: sourceRow.id,
          name: sourceRow.name,
          url: sourceRow.url,
          type: sourceRow.type,
          trustLevel: sourceRow.trust_level,
          provider: sourceRow.provider,
        }
      : null;

    const entityRows = await sql<{
      entity_id: string;
      display_name: string;
      identity_key: string | null;
    }>`
      SELECT be.entity_id, e.display_name, e.identity_key
      FROM osint_business_entities be
      JOIN osint_entities e ON e.id = be.entity_id
      WHERE be.business_id = ${member.id}
        AND be.status <> 'rejected'
        AND (
          be.entity_id = ${row.entity_id}
          OR be.entity_id IN (
            SELECT es.entity_id
            FROM osint_entity_sources es
            WHERE es.source_id = ${row.source_id}
          )
        )
      ORDER BY COALESCE(be.entity_id = ${row.entity_id}, false) DESC,
               (be.status = 'linked') DESC,
               be.created_at DESC
      LIMIT 1
    `.execute(this.db);

    const entityRow = entityRows.rows[0];
    const entity: Stage3EntityInfo | null = entityRow
      ? {
          id: entityRow.entity_id,
          displayName: entityRow.display_name,
          identityKey: entityRow.identity_key,
        }
      : null;

    // §6: без полной цепочки Claim → Evidence → Observation → Source
    // утверждение не считается валидным — возвращаем объяснимый пустой результат.
    const subject = entity ? entity.displayName || entity.identityKey : null;
    if (!source) return this.emptySlice(member.id, row.id, evidence, null, entity, "missing_provenance");
    if (!entity || !subject)
      return this.emptySlice(member.id, row.id, evidence, source, null, "missing_entity");

    const extracted = extractClaims({
      businessId: member.id,
      observationId: row.id,
      subject,
      content: evidence.content,
      observedAt: evidence.observedAt,
    });

    // Инвариант §6: Claim без Evidence-ссылки невалиден — он не отдаётся.
    const claims = extracted.flatMap((claim) => {
      const evidenceRef = claim.evidence[0];
      if (!evidenceRef) return [];
      return [
        {
          ...claim,
          provenance: {
            claimId: claim.id,
            evidenceRef,
            observationId: row.id,
            sourceId: row.source_id,
          },
        },
      ];
    });

    // Пустой список — нормальный результат обработки, а не ошибка (§12).
    if (claims.length === 0)
      return this.emptySlice(member.id, row.id, evidence, source, entity, "no_extractable_claims");

    return {
      businessId: member.id,
      observationId: row.id,
      evidence,
      source,
      entity,
      claims,
      reason: null,
    };
  }

  private emptySlice(
    businessId: string,
    observationId: string,
    evidence: Stage3ObservationSlice["evidence"],
    source: Stage3ObservationSlice["source"],
    entity: Stage3ObservationSlice["entity"],
    reason: Stage3Reason,
  ): Stage3ObservationSlice {
    return {
      businessId,
      observationId,
      evidence,
      source,
      entity,
      claims: [],
      reason,
    };
  }

  /**
   * Stage 3 runtime v2: corroboration / contradiction / claim assessment.
   *
   * Read-model поверх Stage 2 (§9): ничего не пишется и не персистится.
   * Читает те же наблюдения, что и `explainObservation`, но все целиком в
   * пределах тенантского скоупа, и оценивает их коллективно (§5).
   *
   * Субъект выбирается тем же ранжированием, что и в `explainObservation`
   * (прямая привязка → статус 'linked' → свежайший мост), поэтому ответ v2
   * не расходится с ответом v1 на той же строке.
   */
  async assessObservations(
    userId: string,
    publicId: string,
  ): Promise<Stage3Assessment> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );

    const scoped = await sql<AssessmentRow>`
      SELECT
        o.id, o.source_id, o.entity_id, o.content, o.content_hash,
        o.observed_at, o.created_at, o.kind,
        ranked.display_name, ranked.identity_key
      FROM osint_observations o
      LEFT JOIN LATERAL (
        SELECT be.entity_id, e.display_name, e.identity_key
        FROM osint_business_entities be
        JOIN osint_entities e ON e.id = be.entity_id
        WHERE be.business_id = ${member.id}
          AND be.status <> 'rejected'
          AND (
            be.entity_id = o.entity_id
            OR be.entity_id IN (
              SELECT es.entity_id
              FROM osint_entity_sources es
              WHERE es.source_id = o.source_id
            )
          )
        ORDER BY COALESCE(be.entity_id = o.entity_id, false) DESC,
                 (be.status = 'linked') DESC,
                 be.created_at DESC
        LIMIT 1
      ) ranked ON true
      WHERE ${this.tenantScope(member.id)}
      ORDER BY o.id
      LIMIT ${ASSESSMENT_LIMIT}
    `.execute(this.db);

    const claims: Claim[] = [];
    const provenance = new Map<string, string>();
    let skipped = 0;

    for (const row of scoped.rows) {
      provenance.set(row.id, row.source_id);

      const subject = row.display_name || row.identity_key;
      if (!subject || !isClaimSupportedObservationKind(row.kind)) {
        skipped += 1;
        continue;
      }

      // §6: битая строка не даёт права на Claim — наблюдение пропускается,
      // а оценка остается объяснимой, вместо 503 на весь bulk.
      let evidence: Evidence;
      try {
        evidence = toEvidence(row);
      } catch {
        skipped += 1;
        continue;
      }

      const extracted = extractClaims({
        businessId: member.id,
        observationId: row.id,
        subject,
        content: evidence.content,
        observedAt: evidence.observedAt,
      });
      if (extracted.length === 0) {
        skipped += 1;
        continue;
      }
      claims.push(...extracted);
    }

    return assessClaims({
      businessId: member.id,
      observationCount: scoped.rows.length,
      skippedObservations: skipped,
      claims,
      provenance,
    });
  }

  /**
   * Синхронный запуск: create + execute в одном вызове. Так ведут себя
   * юнит-тесты и инструменты; HTTP использует `enqueueDiscovery` (§25 —
   * POST отвечает 201, обход идёт в фоновом воркере).
   */
  async startDiscovery(
    userId: string,
    publicId: string,
    options?: { budget?: Partial<DiscoveryBudget> },
  ): Promise<OsintDiscoveryRunOutcome> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "intelligence.manage",
    );

    // Освобождаем run'ы, упавшие вместе с процессом — до старта нового.
    await releaseStaleDiscoveryRuns(this.db);

    const crawl = this.options.crawl
      ? (this.options.crawlOptions ?? {})
      : null;

    const result: DiscoveryRunResult = await runDiscovery(this.db, {
      businessId: member.id,
      userId,
      registry: this.registry(),
      budget: options?.budget,
      crawl,
    });

    return {
      runId: result.runId,
      status: result.status,
      queriesCount: result.queriesCount,
      resultsCount: result.resultsCount,
      candidatesCount: result.candidatesCount,
      duplicatesCount: result.duplicatesCount,
      acceptedCount: result.acceptedCount,
      reviewCount: result.reviewCount,
      rejectedCount: result.rejectedCount,
      errors: result.errors,
    };
  }

  /**
   * Ставит discovery run в очередь (§25): без сети, crawl-фаза исполняется
   * фоновым воркером. seedUrls валидируются здесь — 422 с перечнем
   * некорректных значений; бюджет только сжимается до капов.
   */
  async enqueueDiscovery(
    userId: string,
    publicId: string,
    input?: { seedUrls?: unknown; budget?: unknown },
  ): Promise<OsintDiscoveryEnqueued> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "intelligence.manage",
    );

    await releaseStaleDiscoveryRuns(this.db);

    const explicit = normalizeExplicitSeeds(input?.seedUrls);
    if (explicit.invalid.length) {
      throw new AppError(
        422,
        "INVALID_SEED_URL",
        `Некорректные seed-URL: ${explicit.invalid
          .slice(0, 3)
          .map((value) => JSON.stringify(value))
          .join(", ")}`,
      );
    }

    const budget = mergeDiscoveryBudget(
      input?.budget && typeof input.budget === "object" && !Array.isArray(input.budget)
        ? input.budget
        : {},
    );

    const created = await createDiscoveryRun(this.db, {
      businessId: member.id,
      registry: this.registry(),
      budget,
      crawl: true,
      explicitSeeds: explicit.seeds,
    });

    return {
      runId: created.runId,
      status: "queued",
      seeds: created.seedCount,
    };
  }

  /**
   * Статус одного run'а + его crawl-очереди (§25). Тенант-скоуп: чужой
   * run_id → 404, без утечки факта существования.
   */
  async getRunStatus(
    userId: string,
    publicId: string,
    runId: string,
  ): Promise<OsintRunStatusInfo> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );

    if (!UUID_RE.test(runId))
      throw new AppError(404, "DISCOVERY_RUN_NOT_FOUND", "Запуск не найден.");

    const run = await this.db
      .selectFrom("osint_discovery_runs")
      .select([
        "id",
        "status",
        "error",
        "queries_count",
        "results_count",
        "candidates_count",
        "accepted_count",
        "review_count",
        "rejected_count",
        "duplicates_count",
        "stats",
        "created_at",
        "started_at",
        "finished_at",
      ])
      .where("id", "=", runId)
      .where("business_id", "=", member.id)
      .executeTakeFirst();

    if (!run)
      throw new AppError(404, "DISCOVERY_RUN_NOT_FOUND", "Запуск не найден.");

    const queueCounts = await this.db
      .selectFrom("osint_crawl_queue")
      .select((eb) => ["status", eb.fn.countAll<number>().as("n")])
      .where("run_id", "=", run.id)
      .groupBy("status")
      .execute();

    const recentFailures = await this.db
      .selectFrom("osint_crawl_queue")
      .select(["url", "status", "skip_reason", "error"])
      .where("run_id", "=", run.id)
      .where("status", "in", ["failed", "skipped"])
      .orderBy("updated_at", "desc")
      .limit(RUN_FAILURE_LIMIT)
      .execute();

    const countBy = (status: string) =>
      Number(queueCounts.find((row) => row.status === status)?.n ?? 0);
    const queued = countBy("queued");
    const fetching = countBy("fetching");
    const fetched = countBy("fetched");
    const failed = countBy("failed");
    const skipped = countBy("skipped");

    return {
      runId: run.id,
      status: run.status,
      error: run.error,
      counts: {
        queries: run.queries_count,
        results: run.results_count,
        candidates: run.candidates_count,
        accepted: run.accepted_count,
        review: run.review_count,
        rejected: run.rejected_count,
        duplicates: run.duplicates_count,
      },
      queue: {
        queued,
        fetching,
        fetched,
        failed,
        skipped,
        total: queued + fetching + fetched + failed + skipped,
      },
      recentFailures: recentFailures.map((row) => ({
        url: row.url,
        status: row.status,
        skipReason: row.skip_reason,
        error: row.error,
      })),
      stats: (run.stats ?? {}) as Record<string, unknown>,
      createdAt: iso(run.created_at) ?? "",
      startedAt: iso(run.started_at),
      finishedAt: iso(run.finished_at),
    };
  }

  /* ================= Stage 4 intelligence layer (§26.12) ================= */

  /** `GET .../osint/profile` — «кто это и что известно» из ACTIVE facts. */
  async getIntelProfile(
    userId: string,
    publicId: string,
  ): Promise<OsintIntelProfile> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );
    return buildProfile(this.db, member.id);
  }

  /** `GET .../osint/facts` — страница фактов с provenance и фильтром типа. */
  async getIntelFacts(
    userId: string,
    publicId: string,
    options: {
      factType?: string | null;
      limit?: string | null;
      offset?: string | null;
    } = {},
  ): Promise<OsintIntelPage<OsintIntelFact>> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );
    return listFacts(this.db, member.id, options);
  }

  /** `GET .../osint/changes` — детерминированная лента изменений (§26.9). */
  async getIntelChanges(
    userId: string,
    publicId: string,
    options: { limit?: string | null; offset?: string | null } = {},
  ): Promise<OsintIntelPage<OsintIntelChange>> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );
    return listChanges(this.db, member.id, options);
  }

  /** `GET .../osint/contradictions` — пересчитанные противоречия (§26.10). */
  async getIntelContradictions(
    userId: string,
    publicId: string,
  ): Promise<{ businessId: string; contradictions: OsintIntelContradiction[] }> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );
    return listContradictions(this.db, member.id);
  }
}
