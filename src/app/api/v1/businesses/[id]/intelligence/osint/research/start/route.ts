import { intelligenceOsintResearchStartHandler } from "@/server/http/intelligence-research-agent-handler";
export const dynamic = "force-dynamic";
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintResearchStartHandler(request, (await params).id);
}
