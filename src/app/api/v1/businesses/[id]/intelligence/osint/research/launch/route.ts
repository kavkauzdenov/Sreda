import { intelligenceOsintResearchLaunchHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintResearchLaunchHandler(request, (await params).id);
}
