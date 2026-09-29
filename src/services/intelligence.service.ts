import { apiRequest } from "@/lib/apiClient";
import type { IntelligenceOverview } from "@/lib/intelligence-types";

export async function getIntelligenceOverview(
  businessId: string,
  options?: { demo?: boolean },
): Promise<IntelligenceOverview> {
  const q = options?.demo ? "?demo=1" : "";
  return apiRequest<IntelligenceOverview>(
    `/api/v1/businesses/${encodeURIComponent(businessId)}/intelligence/overview${q}`,
  );
}
