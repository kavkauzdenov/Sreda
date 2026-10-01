import { intelligenceOsintObservationHandler } from "@/server/http/intelligence-handler";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; observationId: string }> },
) {
  const { id, observationId } = await params;
  return intelligenceOsintObservationHandler(request, id, observationId);
}
