import { getRuntime } from "@/server/runtime";
import { createApplication } from "@/server/http/application";
import { json, respond } from "@/server/http/errors";
import { getLeadReadiness } from "@/server/leads/readiness";
import { requireBusiness } from "@/server/access/permissions";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return respond(request, async () => {
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const publicId = (await params).id;
    const b = await requireBusiness(
      runtime.db,
      user.id,
      publicId,
      "leads.write",
    );
    return json(await getLeadReadiness(runtime.db, b.id));
  });
}
