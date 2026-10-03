import { intelligenceOsintResearchPreviewHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintResearchPreviewHandler(request, (await params).id);
}
