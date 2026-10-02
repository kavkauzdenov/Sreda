import { intelligenceOsintProfileHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return intelligenceOsintProfileHandler(request, (await params).id);
}
