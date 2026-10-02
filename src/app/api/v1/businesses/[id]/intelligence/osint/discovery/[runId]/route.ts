import { intelligenceOsintRunStatusHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> },
) {
  const resolved = await params;
  return intelligenceOsintRunStatusHandler(request, resolved.id, resolved.runId);
}
