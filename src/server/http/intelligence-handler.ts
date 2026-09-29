import { getRuntime } from "../runtime";
import { createApplication } from "./application";
import { json, respond } from "./errors";
import { BusinessBrainService } from "../intelligence/business-brain";

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
