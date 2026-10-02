import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { logIntelligenceEvent } from "../audit.ts";
import {
  mergeDiscoveryBudget,
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
import { jsonbArray } from "./schema.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { OsintPageProvider } from "./providers/types.ts";
import type { RobotsChecker } from "./robots.ts";
import { collectSeedUrls, SEED_PRIORITY, type SeedUrl } from "./seed.ts";
import {
  enqueueCrawlUrls,
  followDomainsFor,
  runCrawl,
  type CrawlStats,
} from "./crawl.ts";

/**
 * Discovery-оркестратор (§7): профиль → запросы → провайдеры → классификация
 * → scoring → кандидаты → авто-источники. Stage 3 full (§25) добавляет
 * crawl-фазу: очередь seed'ов → загрузка страниц → парсинг → те же
 * кандидаты/источники/наблюдения.
 *
 * Жизненный цикл разделён: `createDiscoveryRun` ставит run в очередь (HTTP
 * отвечает 201 без сети), `executeDiscoveryRun` исполняет его — в HTTP-запросе
 * (старый синхронный путь) или в фоновом воркере.
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

/** Настройки crawl-фазы одного запуска. */
export type CrawlPhaseOptions = {
  /** Провайдер загрузки; по умолчанию — единственный page-провайдер реестра. */
  pageProvider?: OsintPageProvider | null;
  /** robots.txt-чекер; по умолчанию выключен (юнит-тесты без сети). */
  robots?: RobotsChecker | null;
  /** Только тесты/dev: приватные диапазоны (см. safe-fetch). */
  allowPrivateNetworks?: boolean;
  /** Добавлять ли принятые кандидаты этого run'а в очередь (глубина 0). */
  enqueueRunCandidates?: boolean;
  onProgress?: (stats: CrawlStats) => void;
};

export type CreateRunInput = {
  businessId: string;
  registry: ProviderRegistry;
  providers?: readonly string[] | null;
  intents?: readonly DiscoveryIntent[];
  budget?: Partial<DiscoveryBudget>;
  /** Готовый профиль (тесты/ручной запуск); иначе читается из `business`. */
  profile?: DiscoveryProfile;
  /** Crawl включён → seed'ы собираются и пишутся в очередь на создании. */
  crawl?: boolean;
  /** Явные seed'ы оператора (только вместе с crawl). */
  explicitSeeds?: readonly SeedUrl[] | null;
};

export type CreateRunResult = {
  runId: string;
  seedCount: number;
  profile: DiscoveryProfile;
  budget: DiscoveryBudget;
  providerIds: string[];
};

export type ExecuteRunOptions = {
  registry: ProviderRegistry;
  /** Провайдеры; undefined → ids из строки run'а. */
  providers?: readonly string[] | null;
  intents?: readonly DiscoveryIntent[];
  budget?: Partial<DiscoveryBudget>;
  profile?: DiscoveryProfile;
  userId?: string | null;
  signal?: AbortSignal;
  /** Crawl-фаза; null/undefined → без обхода (обратная совместимость). */
  crawl?: CrawlPhaseOptions | null;
};

export type RunDiscoveryInput = {
  businessId: string;
  userId: string | null;
  registry: ProviderRegistry;
  /** null/undefined → все провайдеры, включённые по умолчанию. */
  providers?: readonly string[] | null;
  intents?: readonly DiscoveryIntent[];
  budget?: Partial<DiscoveryBudget>;
  profile?: DiscoveryProfile;
  signal?: AbortSignal;
  /** Crawl-фаза (§25); без неё семантика Этапа 2 не меняется. */
  crawl?: CrawlPhaseOptions | null;
  /** Явные seed'ы (только вместе с crawl); иначе — профиль + прежние. */
  seeds?: readonly SeedUrl[] | null;
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
  const stale = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("status", "in", ["queued", "running"])
    .where("started_at", "<", cutoff)
    .execute();
  if (!stale.length) return 0;
  const ids = stale.map((row) => row.id);

  const result = await db
    .updateTable("osint_discovery_runs")
    .set({
      status: "failed",
      error: "stale_run_expired",
      finished_at: now,
      updated_at: now,
    })
    .where("id", "in", ids)
    .executeTakeFirst();

  // Очередь зависшего run'а не должна висеть fetching/queued вечно.
  await db
    .updateTable("osint_crawl_queue")
    .set({
      status: "skipped",
      skip_reason: "stale_run_expired",
      updated_at: now,
    })
    .where("run_id", "in", ids)
    .where("status", "in", ["queued", "fetching"])
    .execute();

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

/**
 * Создаёт run в статусе queued (+ seed-очередь при включённом crawl).
 * Никакой сети — только профиль, выбор провайдеров и нормализация seed'ов.
 */
export async function createDiscoveryRun(
  db: Kysely<Database>,
  input: CreateRunInput,
): Promise<CreateRunResult> {
  const budget = mergeDiscoveryBudget(input.budget ?? {});
  const profile =
    input.profile ?? (await loadDiscoveryProfile(db, input.businessId));
  const providerIds = input.registry
    .select(input.providers ?? null, input.intents)
    .map((provider) => provider.descriptor.id);

  const runId = randomUUID();
  await db
    .insertInto("osint_discovery_runs")
    .values({
      id: runId,
      business_id: input.businessId,
      status: "queued",
      profile: profile as unknown as Record<string, unknown>,
      budget: budget as unknown as Record<string, unknown>,
      providers: jsonbArray(providerIds),
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

  let seedCount = 0;
  if (input.crawl) {
    const seeds = await collectSeedUrls(db, {
      businessId: input.businessId,
      profile,
      explicit: input.explicitSeeds ?? undefined,
    });
    seedCount = await enqueueCrawlUrls(db, {
      runId,
      businessId: input.businessId,
      entries: seeds.map((seed) => ({
        url: seed.url,
        reason: seed.reason,
        priority: seed.priority,
        depth: 0,
      })),
    });
  }

  return { runId, seedCount, profile, budget, providerIds };
}

/**
 * Исполняет queued run: claim → search-фаза → crawl-фаза → finish.
 * Возвращает null, если run уже занят/завершён (атомарный claim).
 */
export async function executeDiscoveryRun(
  db: Kysely<Database>,
  runId: string,
  options: ExecuteRunOptions,
): Promise<DiscoveryRunResult | null> {
  const existing = await db
    .selectFrom("osint_discovery_runs")
    .select([
      "id",
      "business_id",
      "status",
      "profile",
      "budget",
      "providers",
      "error",
    ])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!existing || existing.status !== "queued") return null;

  const claimed = await db
    .updateTable("osint_discovery_runs")
    .set({ status: "running", started_at: new Date(), updated_at: new Date() })
    .where("id", "=", runId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (!claimed || claimed.numUpdatedRows === BigInt(0)) return null;

  const businessId = existing.business_id;
  const budget = mergeDiscoveryBudget({
    ...(existing.budget as Record<string, unknown>),
    ...(options.budget ?? {}),
  });
  const profile: DiscoveryProfile =
    options.profile ?? (existing.profile as unknown as DiscoveryProfile);
  const rowProviders = Array.isArray(existing.providers)
    ? (existing.providers as string[])
    : [];
  const requested =
    options.providers !== undefined
      ? options.providers
      : rowProviders.length
        ? rowProviders
        : null;

  const queries = buildDiscoveryQueries(profile, budget);
  const selectedProviders = options.registry.select(requested, options.intents);
  const totals = emptyTotals();
  const userId = options.userId ?? null;

  let budgetExhausted = false;
  let searchSkipped: string | null = null;
  let entityId: string | null = null;

  const finish = async (
    status: DiscoveryRunStatus,
    errors: string[],
    crawl: CrawlStats | null,
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
        stats: (crawl ? { crawl } : {}) as Record<string, unknown>,
      })
      .where("id", "=", runId)
      .execute();
    await logIntelligenceEvent(db, {
      businessId,
      userId,
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
        ...(crawl
          ? {
              crawlFetched: crawl.fetched,
              crawlFailed: crawl.failed,
              crawlSkipped: crawl.skipped,
              crawlRequests: crawl.requestsUsed,
            }
          : {}),
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
        entityId: entityId!,
        classified,
        provider: providerId,
        autoAccepted: outcome.rule !== null,
        confidence: outcome.score,
      });
      await attachCandidateSource(db, {
        candidateId: outcome.id,
        sourceId,
        entityId: entityId!,
      });
      // Gap closure Stage 3 (§23.3): здесь материал провайдера иначе
      // заканчивался — до osint_observations он не доходил.
      await ensureObservation(db, {
        businessId,
        entityId: entityId!,
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

  const searchPhase = async (): Promise<void> => {
    if (!selectedProviders.length) {
      searchSkipped = "no_providers_available";
      return;
    }
    if (!queries.length) {
      searchSkipped = "no_queries_generated";
      return;
    }

    entityId = await ensureEntity(db, { businessId, profile });

    const deadline = Date.now() + budget.maxDurationMs;

    for (const provider of selectedProviders) {
      for (const query of queries) {
        if (options.signal?.aborted) {
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
            signal: options.signal,
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
              businessId,
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
        if (options.signal?.aborted) break;
      }
      if (budgetExhausted || options.signal?.aborted) break;
    }
  };

  const crawlPhase = async (): Promise<CrawlStats | null> => {
    if (!options.crawl) return null;
    const pageProvider =
      options.crawl.pageProvider === undefined
        ? options.registry.selectPage()
        : options.crawl.pageProvider;
    if (!pageProvider) {
      totals.errors.push("no_page_provider_available");
      return null;
    }

    if (options.crawl.enqueueRunCandidates !== false) {
      const accepted = await db
        .selectFrom("osint_source_candidates")
        .select("normalized_url")
        .where("discovery_run_id", "=", runId)
        .where("status", "=", "accepted")
        .limit(budget.maxCandidates)
        .execute();
      if (accepted.length) {
        await enqueueCrawlUrls(db, {
          runId,
          businessId,
          entries: accepted.map((row) => ({
            url: row.normalized_url,
            reason: "run_candidate" as const,
            priority: SEED_PRIORITY.run_candidate,
            depth: 0,
          })),
        });
      }
    }

    entityId ??= await ensureEntity(db, { businessId, profile });

    const seedRows = await db
      .selectFrom("osint_crawl_queue")
      .select("url")
      .where("run_id", "=", runId)
      .where("depth", "=", 0)
      .limit(100)
      .execute();

    return runCrawl(db, {
      businessId,
      runId,
      entityId,
      profile,
      seeds: null,
      options: {
        budget,
        pageProvider,
        followDomains: followDomainsFor(
          profile,
          seedRows.map((row) => row.url),
        ),
        followSocialLinks: profile.knownSocialLinks,
        robots: options.crawl.robots ?? null,
        allowPrivateNetworks: options.crawl.allowPrivateNetworks ?? false,
        signal: options.signal,
        onProgress: options.crawl.onProgress,
      },
    });
  };

  await searchPhase();
  const crawlStats = await crawlPhase();

  const providerFailures = totals.errors.filter((value) =>
    value.startsWith("provider:"),
  );

  let status: DiscoveryRunStatus;
  if (providerFailures.length && totals.queriesCount <= providerFailures.length)
    status = "failed";
  else if (
    budgetExhausted ||
    providerFailures.length ||
    searchSkipped ||
    totals.errors.includes("no_page_provider_available")
  )
    status = "partial";
  else status = "completed";

  if (crawlStats && status === "completed") {
    const hardFail =
      crawlStats.failed > 0 &&
      crawlStats.fetched === 0 &&
      crawlStats.seeds > 0;
    const softFail =
      crawlStats.failed > 0 ||
      crawlStats.errors.length > 0 ||
      crawlStats.budgetHits.length > 0;
    if (hardFail) status = "failed";
    else if (softFail) status = "partial";
  } else if (crawlStats && status === "partial" && crawlStats.failed > 0 && crawlStats.fetched === 0 && crawlStats.seeds > 0) {
    status = "failed";
  }

  const errors = [...totals.errors];
  if (searchSkipped) errors.push(searchSkipped);
  if (crawlStats?.errors.length)
    errors.push(...crawlStats.errors.slice(0, 20));
  if (crawlStats?.budgetHits.length)
    errors.push(...crawlStats.budgetHits.map((hit) => `crawl_${hit}`));
  return finish(status, errors, crawlStats);
}

/**
 * Синхронный запуск (Etap 2 + опциональный crawl): create + execute.
 * Семантика без `crawl` не меняется — старые вызовы ведут себя как раньше.
 */
export async function runDiscovery(
  db: Kysely<Database>,
  input: RunDiscoveryInput,
): Promise<DiscoveryRunResult> {
  const created = await createDiscoveryRun(db, {
    businessId: input.businessId,
    registry: input.registry,
    providers: input.providers,
    intents: input.intents,
    budget: input.budget,
    profile: input.profile,
    crawl: Boolean(input.crawl),
    explicitSeeds: input.seeds ?? null,
  });

  const result = await executeDiscoveryRun(db, created.runId, {
    registry: input.registry,
    providers: input.providers,
    intents: input.intents,
    budget: input.budget,
    profile: input.profile,
    userId: input.userId,
    signal: input.signal,
    crawl: input.crawl ?? null,
  });
  if (!result)
    throw new Error(`discovery run ${created.runId} already claimed`);
  return result;
}
