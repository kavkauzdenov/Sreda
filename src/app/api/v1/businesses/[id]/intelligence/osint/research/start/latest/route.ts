import { intelligenceOsintResearchLatestHandler } from "@/server/http/intelligence-research-agent-handler";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintResearchLatestHandler(request, (await params).id);
}
