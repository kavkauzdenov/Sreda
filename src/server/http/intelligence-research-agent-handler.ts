import { getRuntime } from "@/server/runtime";
import { createApplication } from "@/server/http/application";
import { json, readJson, requireOrigin, respond } from "@/server/http/errors";
import { limit } from "@/server/http/limits";
import {
  getLatestResearchProgress,
  getResearchProgress,
  startAutonomousResearch,
  type ResearchMode,
} from "@/server/intelligence/research-service";

/**
 * `POST .../osint/research/start` — zero-config запуск исследования.
 *
 * Пользователь не выбирает провайдеров, источники, цели и запросы: он уже
 * описал бизнес при создании, дальше система исследует сама.
 */
export function intelligenceOsintResearchStartHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "POST") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    requireOrigin(request, runtime.origin);
    await limit(
      runtime.db,
      runtime.secret,
      "osint-research-start:" + publicId + ":" + user.id,
      5,
      60,
    );
    const body = await readJson(request, 2048).catch(() => ({}) as Record<string, unknown>);
    const requested = typeof body.mode === "string" ? body.mode : "standard";
    const mode: ResearchMode =
      requested === "quick" || requested === "deep" ? requested : "standard";

    const outcome = await startAutonomousResearch(runtime.db, user.id, publicId, { mode });
    return json(outcome, outcome.created ? 201 : 200);
  });
}

/**
 * `GET .../osint/research/start/[runId]` — прогресс исследования.
 *
 * Ответ уже человекочитаемый: что найдено, что сейчас делается, что дальше,
 * какие источники недоступны и почему. Технические коды остаются в логах.
 */
export async function intelligenceOsintResearchProgressHandler(
  request: Request,
  publicId: string,
  runId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const progress = await getResearchProgress(runtime.db, user.id, publicId, runId);
    if (!progress) return json({ error: "not_found" }, 404);
    return json(progress);
  });
}

/**
 * `GET .../osint/research/start/latest` — прогресс последнего исследования.
 *
 * До первого запуска отвечает 404: это штатное состояние, а не ошибка, и UI
 * покажет пустое состояние с кнопкой запуска.
 */
export async function intelligenceOsintResearchLatestHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const progress = await getLatestResearchProgress(runtime.db, user.id, publicId);
    if (!progress) return json({ error: "not_found" }, 404);
    return json(progress);
  });
}
