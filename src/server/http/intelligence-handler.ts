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
