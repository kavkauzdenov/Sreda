import { apiRequest } from "@/lib/apiClient";
import type {
  IntelligenceOverview,
  OsintDiscoveryRunOutcome,
  OsintSnapshot,
} from "@/lib/intelligence-types";

export async function getIntelligenceOverview(
  businessId: string,
  options?: { demo?: boolean },
): Promise<IntelligenceOverview> {
  const q = options?.demo ? "?demo=1" : "";
  return apiRequest<IntelligenceOverview>(
    `/api/v1/businesses/${encodeURIComponent(businessId)}/intelligence/overview${q}`,
  );
}

function osintBase(businessId: string) {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/intelligence/osint`;
}

export async function getOsintSnapshot(
  businessId: string,
): Promise<OsintSnapshot> {
  return apiRequest<OsintSnapshot>(osintBase(businessId));
}

export async function startOsintDiscovery(
  businessId: string,
): Promise<OsintDiscoveryRunOutcome> {
  return apiRequest<OsintDiscoveryRunOutcome>(
    `${osintBase(businessId)}/discovery`,
    { method: "POST", body: "{}" },
  );
}
