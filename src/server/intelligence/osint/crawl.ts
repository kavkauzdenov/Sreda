import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../../db/schema.ts";
import {
  attachCandidateSource,
  ensureEntity,
  ensureSource,
  persistCandidate,
} from "./candidates.ts";
import { classifyResult } from "./classifier.ts";
import { ensureObservation } from "./observations.ts";
import { isSocialUrl } from "./profile.ts";
import { upsertSourceContext } from "./source-context.ts";
import type { DiscoveryBudget } from "./config.ts";
import type { DiscoveryProfile } from "./profile.ts";
import type { OsintPageProvider } from "./providers/types.ts";
import type { RobotsChecker } from "./robots.ts";
import { normalizeSeed, type SeedReason, type SeedUrl } from "./seed.ts";
import { hostMatches, normalizeUrl } from "./url.ts";

/**
 * Crawl-фаза discovery (§25): очередь URL → загрузка через page-провайдер →
 * парсинг → классификация → кандидаты/источники/наблюдения → новые ссылки.
 *
 * Инварианты:
 *  - дедуп очереди — UNIQUE (run_id, normalized_url), поэтому циклы ссылок
 *    не размножают строки и не зацикливаются;
 *  - состояния явные (queued/fetching/fetched/failed/skipped), повторный
 *    запуск после частичного сбоя продолжает с queued-строк;
 *  - бюджет (глубина/страницы/запросы/длительность/конкурентность) —
 *    жёсткие лимиты, исчерпание фиксируется в stats.budgetHits;
 *  - follow-политика: только домены владельца и seed'ов + соцсети профиля,
 *    чужие сайты не обходятся;
 *  - каждый запрос проходит SSRF-safe fetch и robots.txt (если включён);
 *  - отмена (signal) и дедлайн гасят очередь через skipped, не failed.
 */

export type CrawlSkipReason =
  | "robots_disallowed"
  | "budget_requests"
  | "budget_duration"
  | "budget_pages"
  | "aborted"
  | "seed_invalid";

export type CrawlStats = {
  seeds: number;
  fetched: number;
  failed: number;
  skipped: number;
  linksDiscovered: number;
  requestsUsed: number;
  robotsFetched: number;
  candidatesNew: number;
  candidatesAccepted: number;
  observationsCreated: number;
  depthReached: number;
  budgetHits: string[];
  errors: string[];
};

export type CrawlOptions = {
  budget: DiscoveryBudget;
  pageProvider: OsintPageProvider;
  /** Регистрируемые домены, по которым разрешён follow (владелец + seeds). */
  followDomains: readonly string[];
  /** Соцссылки профиля — их хосты тоже можно переходить. */
  followSocialLinks: readonly string[];
  /** Проверка robots.txt; null — выключена (юнит-тесты). */
  robots?: RobotsChecker | null;
  /** Только тесты/dev: приватные диапазоны (см. web-page/safe-fetch). */
  allowPrivateNetworks?: boolean;
  signal?: AbortSignal;
  onProgress?: (stats: CrawlStats) => void;
};

export type RunCrawlInput = {
  businessId: string;
  runId: string;
  /** Сущность для наблюдений; если null — создаётся из профиля. */
  entityId: string | null;
  profile: DiscoveryProfile;
  /** Seed-строки для вставки в очередь (null — очередь уже засеяна). */
  seeds?: readonly SeedUrl[] | null;
  options: CrawlOptions;
};

type ClaimedRow = {
  id: string;
  url: string;
  normalized_url: string;
  depth: number;
  attempts: number;
};

function emptyStats(seedCount: number): CrawlStats {
  return {
    seeds: seedCount,
    fetched: 0,
    failed: 0,
    skipped: 0,
    linksDiscovered: 0,
    requestsUsed: 0,
    robotsFetched: 0,
    candidatesNew: 0,
    candidatesAccepted: 0,
    observationsCreated: 0,
    depthReached: 0,
    budgetHits: [],
    errors: [],
  };
}

export function followAllowed(
  url: string,
  options: Pick<CrawlOptions, "followDomains" | "followSocialLinks">,
): boolean {
  const normalized = normalizeUrl(url);
  if (!normalized.ok) return false;
  // У IP/localhost registrable-домена нет — ключем становится сам хост.
  const key = normalized.registrableDomain ?? normalized.host;
  if (key && options.followDomains.includes(key)) return true;
  return options.followSocialLinks.some((link) => {
    try {
      return hostMatches(normalized.host, new URL(link).hostname);
    } catch {
      return false;
    }
  });
}

/** Домены, по которым разрешён обход: профиль + registrable-домены seed'ов. */
export function followDomainsFor(
  profile: DiscoveryProfile,
  urls: readonly string[],
): string[] {
  const domains = new Set(profile.knownDomains);
  for (const url of urls) {
    const normalized = normalizeUrl(url);
    if (!normalized.ok) continue;
    const key = normalized.registrableDomain ?? normalized.host;
    if (key) domains.add(key);
  }
  return [...domains];
}

export type EnqueueEntry = {
  url: string;
  reason: SeedReason;
  priority?: number;
  depth?: number;
  /** Со страницы какой URL найдена ссылка (провенанс очереди). */
  fromUrl?: string | null;
};

/** Вставка в очередь с дедупом по (run_id, normalized_url). */
export async function enqueueCrawlUrls(
  db: Kysely<Database>,
  input: {
    runId: string;
    businessId: string;
    entries: readonly EnqueueEntry[];
  },
): Promise<number> {
  let inserted = 0;
  for (const entry of input.entries) {
    const url = normalizeSeed(entry.url);
    if (!url) continue;
    const result = await db
      .insertInto("osint_crawl_queue")
      .values({
        id: randomUUID(),
        run_id: input.runId,
        business_id: input.businessId,
        url: url.slice(0, 2048),
        normalized_url: url,
        depth: entry.depth ?? 0,
        priority: entry.priority ?? 50,
        status: "queued",
        skip_reason: null,
        error: null,
        attempts: 0,
        http_status: null,
        from_url: entry.fromUrl?.slice(0, 2048) ?? null,
        fetched_at: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict((oc) => oc.columns(["run_id", "normalized_url"]).doNothing())
      .executeTakeFirst();
    if (Number(result?.numInsertedOrUpdatedRows ?? 0) > 0) inserted += 1;
  }
  return inserted;
}

async function countQueueRows(
  db: Kysely<Database>,
  runId: string,
  depth: number,
): Promise<number> {
  const row = await db
    .selectFrom("osint_crawl_queue")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("run_id", "=", runId)
    .where("depth", "=", depth)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

async function claimBatch(
  db: Kysely<Database>,
  runId: string,
  limit: number,
): Promise<ClaimedRow[]> {
  const result = await sql<ClaimedRow>`
    UPDATE osint_crawl_queue
    SET status = 'fetching', attempts = attempts + 1, updated_at = now()
    WHERE id IN (
      SELECT id FROM osint_crawl_queue
      WHERE run_id = ${runId} AND status = 'queued'
      ORDER BY priority DESC, depth ASC, created_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, url, normalized_url, depth, attempts
  `.execute(db);
  return result.rows;
}

async function settleRow(
  db: Kysely<Database>,
  id: string,
  status: "fetched" | "failed" | "skipped",
  fields: {
    skipReason?: string | null;
    error?: string | null;
    httpStatus?: number | null;
    fetchedAt?: Date | null;
    url?: string;
  } = {},
): Promise<void> {
  await db
    .updateTable("osint_crawl_queue")
    .set({
      status,
      skip_reason: fields.skipReason ?? null,
      error: fields.error ?? null,
      http_status: fields.httpStatus ?? null,
      fetched_at: fields.fetchedAt ?? (status === "fetched" ? new Date() : null),
      ...(fields.url ? { url: fields.url.slice(0, 2048) } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", id)
    .execute();
}

async function drainQueue(
  db: Kysely<Database>,
  runId: string,
  reason: CrawlSkipReason,
  stats: CrawlStats,
): Promise<void> {
  const result = await db
    .updateTable("osint_crawl_queue")
    .set({ status: "skipped", skip_reason: reason, updated_at: new Date() })
    .where("run_id", "=", runId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  const count = Number(result.numUpdatedRows ?? BigInt(0));
  if (count) {
    stats.skipped += count;
    if (!stats.budgetHits.includes(reason) && reason.startsWith("budget"))
      stats.budgetHits.push(reason);
  }
}

function combineSignals(
  ...signals: (AbortSignal | undefined)[]
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!present.length) return undefined;
  if (present.length === 1) return present[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), {
      once: true,
    });
  }
  return controller.signal;
}

export async function runCrawl(
  db: Kysely<Database>,
  input: RunCrawlInput,
): Promise<CrawlStats> {
  const { options } = input;
  const budget = options.budget;

  if (input.seeds?.length) {
    await enqueueCrawlUrls(db, {
      runId: input.runId,
      businessId: input.businessId,
      entries: input.seeds.map((seed) => ({
        url: seed.url,
        reason: seed.reason,
        priority: seed.priority,
        depth: 0,
      })),
    });
  }

  const seedCount = await countQueueRows(db, input.runId, 0);
  const stats = emptyStats(seedCount);
  const entityId =
    input.entityId ?? (await ensureEntity(db, {
      businessId: input.businessId,
      profile: input.profile,
    }));

  const deadline = Date.now() + budget.maxDurationMs;
  const deadlineCtl = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineCtl.abort(new Error("crawl_deadline")),
    Math.max(0, deadline - Date.now()),
  );

  const fetchSignal = combineSignals(options.signal, deadlineCtl.signal);
  const robots = options.robots ?? null;
  let robotsSeen = robots?.fetchedCount() ?? 0;

  const snippetOf = (description: string | null, text: string): string =>
    [description ?? "", text.slice(0, 1500)].filter(Boolean).join("\n").slice(0, 4000);

  const processRow = async (row: ClaimedRow): Promise<void> => {
    try {
      const deadlineHit = Date.now() >= deadline;
      if (options.signal?.aborted || deadlineCtl.signal.aborted) {
        stats.skipped += 1;
        await settleRow(db, row.id, "skipped", {
          skipReason: options.signal?.aborted ? "aborted" : "budget_duration",
        });
        return;
      }
      if (deadlineHit) {
        stats.skipped += 1;
        await settleRow(db, row.id, "skipped", { skipReason: "budget_duration" });
        return;
      }

      if (robots) {
        const decision = await robots.isAllowed(row.url);
        const fetchedNow = robots.fetchedCount();
        stats.requestsUsed += fetchedNow - robotsSeen;
        stats.robotsFetched += fetchedNow - robotsSeen;
        robotsSeen = fetchedNow;
        if (!decision.allowed) {
          stats.skipped += 1;
          await settleRow(db, row.id, "skipped", {
            skipReason: "robots_disallowed",
            error: decision.pattern.slice(0, 300),
          });
          return;
        }
      }

      const fetch = await options.pageProvider.fetchPage({
        url: row.url,
        signal: fetchSignal,
        maxBytes: Math.min(budget.maxTotalBytes, 2_000_000),
        timeoutMs: Math.min(10_000, Math.max(1_000, deadline - Date.now())),
      });
      stats.requestsUsed += 1;

      if (!fetch.ok) {
        const aborted =
          (fetch.reason === "aborted" || fetch.reason === "timeout") &&
          (deadlineCtl.signal.aborted || options.signal?.aborted);
        if (aborted) {
          stats.skipped += 1;
          await settleRow(db, row.id, "skipped", {
            skipReason: deadlineCtl.signal.aborted && !options.signal?.aborted
              ? "budget_duration"
              : "aborted",
            error: fetch.reason,
          });
          return;
        }
        stats.failed += 1;
        stats.errors.push(
          `fetch:${normalizeForError(row.url)}:${fetch.reason}${fetch.detail ? `:${fetch.detail}` : ""}`.slice(0, 400),
        );
        await settleRow(db, row.id, "failed", {
          error: `${fetch.reason}${fetch.detail ? `: ${fetch.detail}` : ""}`.slice(0, 500),
        });
        return;
      }

      const page = fetch.page;
      stats.fetched += 1;
      stats.depthReached = Math.max(stats.depthReached, row.depth);
      await settleRow(db, row.id, "fetched", {
        httpStatus: page.status,
        fetchedAt: new Date(),
      });

      const classified = classifyResult({
        url: page.finalUrl,
        provider: options.pageProvider.descriptor.id,
        title: page.title,
        snippet: snippetOf(page.description, page.text),
        intent: null,
        method: "website_link",
        knownDomains: input.profile.knownDomains,
        knownSocialLinks: input.profile.knownSocialLinks,
      });

      if (classified.ok) {
        const outcome = await persistCandidate(db, {
          businessId: input.businessId,
          runId: input.runId,
          entityId,
          profile: input.profile,
          classified: classified.candidate,
          provider: options.pageProvider.descriptor.id,
          query: null,
          position: null,
        });
        if (outcome.duplicate) {
          // Повторная загрузка: статус/наблюдение уже есть, ничего не плодим.
        } else {
          stats.candidatesNew += 1;
        }

        if (outcome.status === "accepted") {
          stats.candidatesAccepted += outcome.isNew ? 1 : 0;
          const sourceId = await ensureSource(db, {
            entityId,
            classified: classified.candidate,
            provider: options.pageProvider.descriptor.id,
            autoAccepted: outcome.rule !== null,
            confidence: outcome.score,
          });
          await attachCandidateSource(db, {
            candidateId: outcome.id,
            sourceId,
            entityId,
          });

          // Structured source memory (§1): страница дала факты —
          // описание, контакты, домены, соцсети — фиксируем в контексте.
          const socialUrls = [
            ...new Set(
              [...page.links.map((link) => link.url), ...page.sameAs].filter(
                (url) => isSocialUrl(url),
              ),
            ),
          ];
          await upsertSourceContext(db, {
            sourceId,
            patch: {
              ...(page.description ? { description: page.description } : {}),
              ...(page.language ? { language: page.language } : {}),
              ...(page.contacts.length
                ? {
                    contacts: page.contacts.map((contact) => ({
                      kind: contact.kind,
                      value: contact.value,
                    })),
                  }
                : {}),
              ...(page.domains.length
                ? { domains: page.domains.map((domain) => domain.domain) }
                : {}),
              ...(socialUrls.length ? { social_links: { urls: socialUrls } } : {}),
            },
            changeKind: "auto_collect",
            observedAt: new Date(page.fetchedAt),
          });

          const observation = await ensureObservation(db, {
            businessId: input.businessId,
            entityId,
            sourceId,
            observed: {
              url: classified.candidate.normalizedUrl,
              title: page.title,
              snippet: null,
              provider: options.pageProvider.descriptor.id,
              method: "website_link",
              body: page.text.slice(0, 6_000),
              kind: "page",
              metadata: {
                fetched_at: page.fetchedAt,
                http_status: page.status,
                depth: row.depth,
                parser_version: page.parserVersion,
                language: page.language,
                ...(page.canonicalUrl ? { canonical_url: page.canonicalUrl } : {}),
              },
            },
          });
          if (observation.created) stats.observationsCreated += 1;
        }
      }

      if (row.depth + 1 <= budget.maxDepth) {
        const entries: EnqueueEntry[] = [];
        const seen = new Set<string>();
        for (const link of page.links) {
          if (entries.length >= budget.maxLinksPerPage) break;
          if (!followAllowed(link.url, options)) continue;
          if (seen.has(link.url)) continue;
          seen.add(link.url);
          entries.push({
            url: link.url,
            reason: "run_candidate",
            priority: 50,
            depth: row.depth + 1,
            fromUrl: row.url,
          });
        }
        if (entries.length) {
          const inserted = await enqueueCrawlUrls(db, {
            runId: input.runId,
            businessId: input.businessId,
            entries,
          });
          stats.linksDiscovered += inserted;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.failed += 1;
      stats.errors.push(`crawl:${normalizeForError(row.url)}:${message.slice(0, 300)}`);
      await settleRow(db, row.id, "failed", { error: message.slice(0, 500) });
    }
  };

  try {
    for (;;) {
      if (options.signal?.aborted) {
        await drainQueue(db, input.runId, "aborted", stats);
        break;
      }
      if (Date.now() >= deadline || deadlineCtl.signal.aborted) {
        await drainQueue(db, input.runId, "budget_duration", stats);
        break;
      }
      if (stats.requestsUsed >= budget.maxRequests) {
        await drainQueue(db, input.runId, "budget_requests", stats);
        break;
      }
      const settledPages = stats.fetched + stats.failed;
      if (settledPages >= budget.maxPages) {
        await drainQueue(db, input.runId, "budget_pages", stats);
        break;
      }

      const batchSize = Math.max(
        1,
        Math.min(
          budget.maxConcurrency,
          budget.maxPages - settledPages,
          budget.maxRequests - stats.requestsUsed,
        ),
      );
      const batch = await claimBatch(db, input.runId, batchSize);
      if (!batch.length) break;

      await Promise.allSettled(batch.map((row) => processRow(row)));
      options.onProgress?.(stats);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }

  options.onProgress?.(stats);
  return stats;
}

function normalizeForError(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 200);
  }
}
