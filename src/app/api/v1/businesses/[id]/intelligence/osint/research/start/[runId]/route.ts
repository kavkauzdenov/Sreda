import { intelligenceOsintResearchProgressHandler } from "@/server/http/intelligence-research-agent-handler";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  return intelligenceOsintResearchProgressHandler(
    request,
    (await params).id,
    (await params).runId,
  );
}
