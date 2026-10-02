import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import {
  executeDiscoveryRun,
  releaseStaleDiscoveryRuns,
  type CrawlPhaseOptions,
} from "./discovery.ts";
import type { ProviderRegistry } from "./providers/registry.ts";

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
      }
    } catch {
      // Сбой до finish: run завис бы в running до stale-гашения — помечаем
      // сразу, чтобы статус был виден в snapshot'е.
      result.failed += 1;
      await db
        .updateTable("osint_discovery_runs")
        .set({
          status: "failed",
          error: "orchestration_error",
          finished_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .where("status", "in", ["queued", "running"])
        .execute()
        .catch(() => undefined);
    }
  }

  return result;
}
