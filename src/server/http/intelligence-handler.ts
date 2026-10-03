import { getRuntime } from "../runtime";
import { createApplication } from "./application";
import { json, readJson, respond, requireOrigin } from "./errors";
import { limit } from "./limits";
import { BusinessBrainService } from "../intelligence/business-brain";
import { OsintService } from "../intelligence/osint-service";

export function intelligenceOverviewHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET")
      return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const demo =
      new URL(request.url).searchParams.get("demo") === "1";
    const brain = new BusinessBrainService(runtime.db);
    return json(
      await brain.getOverview(user.id, publicId, { demo }),
    );
  });
}

/** `GET /api/v1/businesses/[id]/intelligence/osint` — снимок графа (чтение). */
export function intelligenceOsintSnapshotHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(await new OsintService(runtime.db).getSnapshot(user.id, publicId));
  });
}

/**
 * `POST /api/v1/businesses/[id]/intelligence/osint/discovery` — постановка
 * run'а в очередь (§25). Тело опционально: `{ seedUrls?, budget? }`.
 * Никакой сети в запросе: обход идёт в фоновом воркере, состояние —
 * `GET .../discovery/[runId]`.
 */
export function intelligenceOsintDiscoveryHandler(
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
      "osint:" + publicId + ":" + user.id,
      5,
      60,
    );
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    const body = contentType.startsWith("application/json")
      ? await readJson(request)
      : {};
    const outcome = await new OsintService(runtime.db).enqueueDiscovery(
      user.id,
      publicId,
      {
        seedUrls: body.seedUrls,
        budget: body.budget,
      },
    );
    return json(outcome, 201);
  });
}

/**
 * `GET /api/v1/businesses/[id]/intelligence/osint/discovery/[runId]` —
 * состояние run'а и его crawl-очереди.
 */
export function intelligenceOsintRunStatusHandler(
  request: Request,
  publicId: string,
  runId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(
      await new OsintService(runtime.db).getRunStatus(user.id, publicId, runId),
    );
  });
}

/**
 * `GET /api/v1/businesses/[id]/intelligence/osint/observations/[observationId]`
 * — Stage 3 runtime v1: observation → Evidence → Claim → Provenance.
 */
export function intelligenceOsintObservationHandler(
  request: Request,
  publicId: string,
  observationId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(
      await new OsintService(runtime.db).explainObservation(
        user.id,
        publicId,
        observationId,
      ),
    );
  });
}

/**
 * `GET /api/v1/businesses/[id]/intelligence/osint/assessment`
 * — Stage 3 runtime v2: corroboration / contradiction / claim assessment.
 */
export function intelligenceOsintAssessmentHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(
      await new OsintService(runtime.db).assessObservations(user.id, publicId),
    );
  });
}

/**
 * Stage 4 (§26.12): четыре GET-чтения intelligence-слоя. Только чтение,
 * без rate-limit (нет записи и нет SSRF-вектора — enrichment исполняется
 * в воркере), drill-down по provenance — существующий observation slice.
 *
 * `GET .../osint/profile` — «кто это и что о нём известно».
 */
export function intelligenceOsintProfileHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(
      await new OsintService(runtime.db).getIntelProfile(user.id, publicId),
    );
  });
}

/** `GET .../osint/facts?page` — страница фактов, фильтр `?factType=`. */
export function intelligenceOsintFactsHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const params = new URL(request.url).searchParams;
    return json(
      await new OsintService(runtime.db).getIntelFacts(user.id, publicId, {
        factType: params.get("factType"),
        limit: params.get("limit"),
        offset: params.get("offset"),
      }),
    );
  });
}

/** `GET .../osint/changes` — лента изменений, `?limit=&offset=`. */
export function intelligenceOsintChangesHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const params = new URL(request.url).searchParams;
    return json(
      await new OsintService(runtime.db).getIntelChanges(user.id, publicId, {
        limit: params.get("limit"),
        offset: params.get("offset"),
      }),
    );
  });
}

/** `GET .../osint/contradictions` — активные противоречия со сторонами. */
export function intelligenceOsintContradictionsHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET") return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    return json(
      await new OsintService(runtime.db).getIntelContradictions(
        user.id,
        publicId,
      ),
    );
  });
}

/**
 * `GET|PUT .../osint/research` — паспорт OSINT-исследования (research brief).
 * GET: сохранённый паспорт (или предложения из карточки), цели с уровнями
 * поддержки, история ревизий и последний запуск. PUT: строгая валидация и
 * версионируемое сохранение по expectedRevision — без запуска и сети.
 */
export function intelligenceOsintResearchHandler(
  request: Request,
  publicId: string,
) {
  return respond(request, async () => {
    if (request.method !== "GET" && request.method !== "PUT")
      return json({ error: "method" }, 405);
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const service = new OsintService(runtime.db);
    if (request.method === "GET")
      return json(await service.getResearch(user.id, publicId));
    requireOrigin(request, runtime.origin);
    await limit(
      runtime.db,
      runtime.secret,
      "osint-research:" + publicId + ":" + user.id,
      30,
      60,
    );
    const body = await readJson(request, 16384);
    return json(
      await service.savePassport(
        user.id,
        publicId,
        body.content,
        body.expectedRevision,
      ),
    );
  });
}

/**
 * `POST .../osint/research/preview` — детерминированный предпросмотр плана:
 * цели, источники, запросы, бюджет и неподдерживаемое. Никакой записи и сети.
 */
export function intelligenceOsintResearchPreviewHandler(
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
      "osint-research-preview:" + publicId + ":" + user.id,
      30,
      60,
    );
    const body = await readJson(request, 16384);
    return json(
      await new OsintService(runtime.db).previewResearch(
        user.id,
        publicId,
        body.content,
        body.budget,
      ),
    );
  });
}

/**
 * `POST .../osint/research/launch` — явный запуск исследования: транзакция
 * (паспорт по expectedRevision → snapshot плана → discovery run). Повтор при
 * активном запуске возвращает существующий (`created:false`).
 */
export function intelligenceOsintResearchLaunchHandler(
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
      "osint-research-launch:" + publicId + ":" + user.id,
      5,
      60,
    );
    const body = await readJson(request, 16384);
    const outcome = await new OsintService(runtime.db).launchResearch(
      user.id,
      publicId,
      body.content,
      body.expectedRevision,
    );
    return json(outcome, outcome.created ? 201 : 200);
  });
}
