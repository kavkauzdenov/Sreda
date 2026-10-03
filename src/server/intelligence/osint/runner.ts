import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { log } from "../../observability/log.ts";
import {
  executeDiscoveryRun,
  releaseStaleDiscoveryRuns,
  type CrawlPhaseOptions,
} from "./discovery.ts";
import { enqueueEnrichment } from "./enrichment.ts";
import type { ProviderRegistry } from "./providers/registry.ts";

/** Причина сбоя — без тел ответов, тел запросов и любых секретов. */
function errorMessage(error: unknown): string {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300) || "unknown_error";
}

/**
 * Фоновый исполнитель discovery run'ов (§25): очередь queued → execute.
 *
 * Запускается из background-worker (deploy/compose) и из HTTP-интеграционных
 * тестов. Реестр передаётся вызывающей стороной СВЕЖИМ на каждый вызов —
 * иначе emit-once провайдеры (own_urls) отработали бы только первому run'у.
 */
export type DiscoveryRunnerOptions = {
  registry: ProviderRegistry;
  /** Crawl-фаза; null/undefined → только search (поведение Этапа 2). */
  crawl?: CrawlPhaseOptions | null;
  /** Сколько run'ов за один тик (по умолчанию 1 — воркер responsive). */
  limit?: number;
  userId?: string | null;
  signal?: AbortSignal;
  /** Гасить stale-запуски перед выборкой (по умолчанию true). */
  releaseStale?: boolean;
};

export type DiscoveryRunnerResult = {
  /** Run'ов действительно исполнено (claim успешен). */
  processed: number;
  runIds: string[];
  /** Сбои оркестрации (исключение до finish) — не путать со status=failed. */
  failed: number;
};

export async function processQueuedDiscoveryRuns(
  db: Kysely<Database>,
  options: DiscoveryRunnerOptions,
): Promise<DiscoveryRunnerResult> {
  if (options.releaseStale !== false)
    await releaseStaleDiscoveryRuns(db);

  const queued = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("status", "=", "queued")
    .orderBy("created_at", "asc")
    .limit(Math.max(1, options.limit ?? 1))
    .execute();

  const result: DiscoveryRunnerResult = { processed: 0, runIds: [], failed: 0 };

  for (const row of queued) {
    if (options.signal?.aborted) break;
    try {
      const run = await executeDiscoveryRun(db, row.id, {
        registry: options.registry,
        userId: options.userId ?? null,
        signal: options.signal,
        crawl: options.crawl ?? null,
      });
      if (run) {
        result.processed += 1;
        result.runIds.push(run.runId);
        // Stage 4 (§26.11): discovery завершён → enrichment в очередь.
        // Сбой постановки не должен отменить завершённый discovery, но
        // обязан быть виден: без enrichment эти наблюдения никогда не
        // дадут facts/changes, а молчаливый .catch() прятал бы отказ.
        await db
          .selectFrom("osint_discovery_runs")
          .select("business_id")
          .where("id", "=", run.runId)
          .executeTakeFirst()
          .then((runRow) =>
            runRow
              ? enqueueEnrichment(db, {
                  businessId: runRow.business_id,
                  discoveryRunId: run.runId,
                })
              : undefined,
          )
          .catch((error: unknown) => {
            log("error", "OSINT_ENRICHMENT_ENQUEUE_FAILED", {
              discovery_run_id: run.runId,
              error: errorMessage(error),
            });
          });
      }
    } catch (error) {
      // Сбой оркестрации: текст сохраняется и логируется — иначе причину
      // падения невозможно диагностировать постфактум. Здоровый run,
      // НЕ успевший стать running (сбой SELECT/claim до claim'а), не
      // помечается failed: у discovery нет повторов, failed терминален —
      // его заберёт следующий тик.
      result.failed += 1;
      const message = errorMessage(error);
      log("error", "DISCOVERY_RUN_ORCHESTRATION_ERROR", {
        run_id: row.id,
        error: message,
      });
      await db
        .updateTable("osint_discovery_runs")
        .set({
          status: "failed",
          error: `orchestration_error: ${message}`.slice(0, 500),
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .where("status", "=", "running")
        .execute()
        .catch(() => undefined);
    }
  }

  return result;
}
