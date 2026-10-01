import { getRuntime } from "../runtime";
import { createApplication } from "./application";
import { json, respond, requireOrigin } from "./errors";
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

/** `POST /api/v1/businesses/[id]/intelligence/osint/discovery` — запуск run'а. */
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
    const outcome = await new OsintService(runtime.db).startDiscovery(
      user.id,
      publicId,
    );
    return json(outcome, 201);
  });
}
