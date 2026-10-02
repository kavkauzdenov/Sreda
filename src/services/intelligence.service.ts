import { apiRequest } from "@/lib/apiClient";
import type {
  IntelligenceOverview,
  OsintDiscoveryEnqueued,
  OsintRunStatusInfo,
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

/** Ставит discovery run в очередь (§25): обход идёт в фоне. */
export async function startOsintDiscovery(
  businessId: string,
  body: { seedUrls?: string[]; budget?: Record<string, unknown> } = {},
): Promise<OsintDiscoveryEnqueued> {
  return apiRequest<OsintDiscoveryEnqueued>(
    `${osintBase(businessId)}/discovery`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** Состояние run'а и его crawl-очереди. */
export async function getOsintRunStatus(
  businessId: string,
  runId: string,
): Promise<OsintRunStatusInfo> {
  return apiRequest<OsintRunStatusInfo>(
    `${osintBase(businessId)}/discovery/${encodeURIComponent(runId)}`,
  );
}
