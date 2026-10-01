import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.ts";
import { requireBusiness } from "../access/permissions.ts";
import { createRegistry } from "./osint/providers/registry.ts";
import { createOwnUrlsProvider } from "./osint/providers/own-urls.ts";
import {
  releaseStaleDiscoveryRuns,
  runDiscovery,
  type DiscoveryRunResult,
} from "./osint/discovery.ts";
import type { DiscoveryBudget } from "./osint/config.ts";
import type {
  OsintDiscoveryRunOutcome,
  OsintSnapshot,
} from "@/lib/intelligence-types.ts";

const RUN_LIMIT = 5;
const CANDIDATE_LIMIT = 50;
const LIST_LIMIT = 50;

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
