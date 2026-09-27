import { getRuntime } from "@/server/runtime";
import { createApplication } from "@/server/http/application";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> },
) {
  const p = await params;
  return createApplication(getRuntime()).leadStatus(request, p.id, p.leadId);
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; leadId: string }> },
) {
  const p = await params;
  return createApplication(getRuntime()).leadStatus(request, p.id, p.leadId);
}
