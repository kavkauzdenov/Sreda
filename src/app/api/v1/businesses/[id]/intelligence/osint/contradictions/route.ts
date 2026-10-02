import { intelligenceOsintContradictionsHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintContradictionsHandler(request, (await params).id);
}
