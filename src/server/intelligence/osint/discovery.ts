import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { logIntelligenceEvent } from "../audit.ts";
import {
  DEFAULT_DISCOVERY_BUDGET,
  STALE_DISCOVERY_RUN_MS,
  type DiscoveryBudget,
  type DiscoveryIntent,
} from "./config.ts";
import {
  attachCandidateSource,
  ensureEntity,
  ensureSource,
  persistCandidate,
} from "./candidates.ts";
import { ensureObservation } from "./observations.ts";
import { classifyResult, type ClassifiedCandidate } from "./classifier.ts";
import {
  buildDiscoveryProfile,
  type DiscoveryProfile,
} from "./profile.ts";
import { buildDiscoveryQueries } from "./queries.ts";
import type { ProviderRegistry } from "./providers/registry.ts";

/**
 * Discovery-оркестратор (§7): профиль → запросы → провайдеры → классификация
 * → scoring → кандидаты → авто-источники. Никакой глубинной загрузки (Этап 5+).
 */

export type DiscoveryRunStatus =
  | "completed"
  | "partial"
  | "failed";

export type DiscoveryRunResult = {
  runId: string;
  status: DiscoveryRunStatus;
  queriesCount: number;
  resultsCount: number;
  candidatesCount: number;
  duplicatesCount: number;
  acceptedCount: number;
  reviewCount: number;
  rejectedCount: number;
  errors: string[];
};

export type RunDiscoveryInput = {
  businessId: string;
  userId: string | null;
  registry: ProviderRegistry;
  /** null/undefined → все провайдеры, включённые по умолчанию. */
  providers?: readonly string[] | null;
  intents?: readonly DiscoveryIntent[];
  budget?: Partial<DiscoveryBudget>;
  /** Готовый профиль (тесты/ручной запуск); иначе читается из `business`. */
  profile?: DiscoveryProfile;
  signal?: AbortSignal;
};

const PROFILE_COLUMNS = [
  "name",
  "public_name",
  "description",
  "contact_info",
  "industry",
  "industry_subtype",
  "greeting",
  "ai_about",
  "ai_geography",
  "ai_important_facts",
  "ai_extra_instructions",
] as const;

export async function loadDiscoveryProfile(
  db: Kysely<Database>,
  businessId: string,
): Promise<DiscoveryProfile> {
  const row = await db
    .selectFrom("business")
    .select([...PROFILE_COLUMNS])
    .where("id", "=", businessId)
    .executeTakeFirst();
  if (!row) throw new Error(`business ${businessId} not found`);
  return buildDiscoveryProfile({ ...row });
}

/** Помечает зависшие run'ы (нет воркера/падение процесса) как failed. */
export async function releaseStaleDiscoveryRuns(
  db: Kysely<Database>,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - STALE_DISCOVERY_RUN_MS);
  const result = await db
    .updateTable("osint_discovery_runs")
    .set({
      status: "failed",
      error: "stale_run_expired",
      finished_at: now,
      updated_at: now,
    })
    .where("status", "in", ["queued", "running"])
    .where("started_at", "<", cutoff)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? BigInt(0));
}

type PersistOutcome = Awaited<ReturnType<typeof persistCandidate>>;

function emptyTotals() {
  return {
    queriesCount: 0,
    resultsCount: 0,
    candidatesCount: 0,
    duplicatesCount: 0,
    acceptedCount: 0,
    reviewCount: 0,
    rejectedCount: 0,
    errors: [] as string[],
  };
}

export async function runDiscovery(
  db: Kysely<Database>,
  input: RunDiscoveryInput,
): Promise<DiscoveryRunResult> {
  const budget: DiscoveryBudget = {
    ...DEFAULT_DISCOVERY_BUDGET,
    ...input.budget,
  };
  const profile =
    input.profile ?? (await loadDiscoveryProfile(db, input.businessId));
  const queries = buildDiscoveryQueries(profile, budget);
  const selectedProviders = input.registry.select(
    input.providers ?? null,
    input.intents,
  );
  const providerIds = selectedProviders.map((provider) => provider.descriptor.id);

  const runId = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({
      id: runId,
      business_id: input.businessId,
      status: "queued",
      profile: profile as unknown as Record<string, unknown>,
      budget: budget as unknown as Record<string, unknown>,
      providers: providerIds,
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
      max_depth: budget.maxDepth,
      stats: {},
      root_entity_id: null,
    })
    .execute();

  const claimed = await db
    .updateTable("osint_discovery_runs")
    .set({ status: "running", started_at: new Date(), updated_at: new Date() })
    .where("id", "=", runId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (!claimed || claimed.numUpdatedRows === BigInt(0))
    throw new Error(`discovery run ${runId} already claimed`);

  const totals = emptyTotals();
  const finish = async (
    status: DiscoveryRunStatus,
    errors: string[],
  ): Promise<DiscoveryRunResult> => {
    const error = errors.length ? errors.join("; ").slice(0, 2000) : null;
    await db
      .updateTable("osint_discovery_runs")
      .set({
        status,
        error,
        queries_count: totals.queriesCount,
        results_count: totals.resultsCount,
        candidates_count: totals.candidatesCount,
        duplicates_count: totals.duplicatesCount,
        accepted_count: totals.acceptedCount,
        review_count: totals.reviewCount,
        rejected_count: totals.rejectedCount,
        finished_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", runId)
      .execute();
    await logIntelligenceEvent(db, {
      businessId: input.businessId,
      userId: input.userId,
      operation: "osint.discovery.run",
      source: "osint",
      result: status,
      metadata: {
        runId,
        queries: totals.queriesCount,
        results: totals.resultsCount,
        candidates: totals.candidatesCount,
        accepted: totals.acceptedCount,
        review: totals.reviewCount,
        rejected: totals.rejectedCount,
        duplicates: totals.duplicatesCount,
        errors,
      },
    });
    return {
      runId,
      status,
      queriesCount: totals.queriesCount,
      resultsCount: totals.resultsCount,
      candidatesCount: totals.candidatesCount,
      duplicatesCount: totals.duplicatesCount,
      acceptedCount: totals.acceptedCount,
      reviewCount: totals.reviewCount,
      rejectedCount: totals.rejectedCount,
      errors,
    };
  };

  if (!selectedProviders.length)
    return finish("partial", ["no_providers_available"]);
  if (!queries.length) return finish("partial", ["no_queries_generated"]);

  const entityId = await ensureEntity(db, {
    businessId: input.businessId,
    profile,
  });

  const deadline = Date.now() + budget.maxDurationMs;
  let budgetExhausted = false;

  const handleOutcome = async (
    outcome: PersistOutcome,
    classified: ClassifiedCandidate,
    providerId: string,
  ): Promise<void> => {
    if (outcome.duplicate) totals.duplicatesCount += 1;
    else totals.candidatesCount += 1;

    if (outcome.status === "rejected") totals.rejectedCount += outcome.isNew ? 1 : 0;
    if (outcome.status === "candidate") totals.reviewCount += outcome.isNew ? 1 : 0;
    if (outcome.status === "accepted") {
      if (outcome.isNew) totals.acceptedCount += 1;
      const sourceId = await ensureSource(db, {
        entityId,
        classified,
        provider: providerId,
        autoAccepted: outcome.rule !== null,
        confidence: outcome.score,
      });
      await attachCandidateSource(db, {
        candidateId: outcome.id,
        sourceId,
        entityId,
      });
      // Gap closure Stage 3 (§23.3): здесь материал провайдера иначе
      // заканчивался — до osint_observations он не доходил.
      await ensureObservation(db, {
        businessId: input.businessId,
        entityId,
        sourceId,
        observed: {
          url: classified.normalizedUrl,
          title: classified.title,
          snippet: classified.snippet,
          provider: providerId,
          method: classified.method,
        },
      });
    }
  };

  for (const provider of selectedProviders) {
    for (const query of queries) {
      if (input.signal?.aborted) {
        budgetExhausted = true;
        totals.errors.push("aborted_by_caller");
        break;
      }
      if (Date.now() >= deadline) {
        budgetExhausted = true;
        totals.errors.push("duration_budget_exhausted");
        break;
      }

      const remaining = budget.maxSearchResults - totals.resultsCount;
      if (remaining <= 0) {
        budgetExhausted = true;
        totals.errors.push("results_budget_exhausted");
        break;
      }

      totals.queriesCount += 1;
      try {
        const output = await provider.search({
          query,
          profile,
          limit: Math.max(1, Math.min(10, remaining)),
          signal: input.signal,
        });
        totals.resultsCount += output.results.length;

        for (const result of output.results) {
          const classified = classifyResult({
            url: result.url,
            provider: provider.descriptor.id,
            title: result.title,
            snippet: result.snippet,
            query: query.text,
            position: result.position,
            intent: query.intent,
            knownDomains: profile.knownDomains,
            knownSocialLinks: profile.knownSocialLinks,
          });
          if (!classified.ok) continue;
          const outcome = await persistCandidate(db, {
            businessId: input.businessId,
            runId,
            entityId,
            profile,
            classified: classified.candidate,
            provider: provider.descriptor.id,
            query: query.text,
            position: result.position ?? null,
          });
          await handleOutcome(outcome, classified.candidate, provider.descriptor.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        totals.errors.push(
          `provider:${provider.descriptor.id}:${message.slice(0, 300)}`,
        );
      }
      if (input.signal?.aborted) break;
    }
    if (budgetExhausted || input.signal?.aborted) break;
  }

  const providerFailures = totals.errors.filter((value) =>
    value.startsWith("provider:"),
  );
  if (budgetExhausted && !providerFailures.length)
    return finish("partial", totals.errors);
  if (providerFailures.length && totals.queriesCount > providerFailures.length)
    return finish("partial", totals.errors);
  if (providerFailures.length) return finish("failed", totals.errors);
  return finish("completed", totals.errors);
}
