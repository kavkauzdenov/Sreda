import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.ts";
import type { Claim, Evidence } from "@/lib/intelligence-contracts.ts";
import { requireBusiness } from "../access/permissions.ts";
import { AppError } from "../http/errors.ts";
import { createRegistry } from "./osint/providers/registry.ts";
import { createOwnUrlsProvider } from "./osint/providers/own-urls.ts";
import {
  releaseStaleDiscoveryRuns,
  runDiscovery,
  type DiscoveryRunResult,
} from "./osint/discovery.ts";
import type { DiscoveryBudget } from "./osint/config.ts";
import {
  assertClaimSupportedKind,
  isClaimSupportedObservationKind,
  toEvidence,
  type ObservationRow,
} from "./osint/evidence.ts";
import { extractClaims } from "./osint/claims.ts";
import { assessClaims } from "./osint/assessment.ts";
import type {
  OsintDiscoveryRunOutcome,
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  constructor(private db: Kysely<Database>) {}

  /** Прозрачность: какими провайдерами реально пользуется run. */
  private registry() {
    return createRegistry([createOwnUrlsProvider()]);
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

    const bridgeTotal = await sql<{ n: number }>`
      SELECT count(DISTINCT entity_id)::int AS n
      FROM osint_business_entities
      WHERE business_id = ${member.id}
    `.execute(this.db);

    // Глобальный слой читается только через тенантский мост §4.
    const bridges = await this.db
      .selectFrom("osint_business_entities")
      .select(["entity_id", "relationship", "status"])
      .where("business_id", "=", member.id)
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
            "url",
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
      providers: this.registry().descriptors().map((descriptor) => ({
        id: descriptor.id,
        label: descriptor.label,
        requiresNetwork: descriptor.requiresNetwork,
        policy: descriptor.policy,
        enabledByDefault: descriptor.enabledByDefault,
      })),
      counts: {
        runs: Number(runTotal?.n ?? 0),
        candidates: Number(candidateTotal?.n ?? 0),
        pending: countByStatus("candidate"),
        accepted: countByStatus("accepted"),
        rejected: countByStatus("rejected"),
        sources: sourceIds.length,
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
        url: row.url,
        type: row.type,
        trustLevel: row.trust_level,
        status: row.status,
        provider: row.provider,
        createdAt: iso(row.created_at) ?? "",
      })),
    };
  }

  /**
   * Единый тенант-скоуп наблюдений (§7).
   *
   * Одна и та же предпосылка и у объяснения одного наблюдения (v1), и у
   * bulk-оценки (v2): наблюдение глобальное, поэтому читается только через
   * тенантский мост `osint_business_entities` (status <> 'rejected'), либо
   * через `osint_entity_sources` → мост. Скоуп предполагает, что таблица
   * наблюдений алиасирована как `o`.
   */
  private tenantScope(businessId: string) {
    return sql<boolean>`
      (
        EXISTS (
          SELECT 1
          FROM osint_business_entities be
          WHERE be.business_id = ${businessId}
            AND be.entity_id = o.entity_id
            AND be.status <> 'rejected'
        )
        OR EXISTS (
          SELECT 1
          FROM osint_entity_sources es
          JOIN osint_business_entities be2 ON be2.entity_id = es.entity_id
          WHERE es.source_id = o.source_id
            AND be2.business_id = ${businessId}
            AND be2.status <> 'rejected'
        )
      )
    `;
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

    const result: DiscoveryRunResult = await runDiscovery(this.db, {
      businessId: member.id,
      userId,
      registry: this.registry(),
      budget: options?.budget,
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
}
