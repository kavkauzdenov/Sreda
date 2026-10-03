import { apiRequest } from "@/lib/apiClient";
import type {
  IntelligenceOverview,
  OsintDiscoveryEnqueued,
  OsintIntelChange,
  OsintIntelContradiction,
  OsintIntelFact,
  OsintIntelPage,
  OsintIntelProfile,
  OsintRunStatusInfo,
  OsintSnapshot,
  OsintResearch,
  OsintResearchLaunched,
  OsintResearchPreview,
  OsintResearchSaved,
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

/* ==================== Stage 4 intelligence layer (§26.12) ================ */

export async function getOsintIntelProfile(
  businessId: string,
): Promise<OsintIntelProfile> {
  return apiRequest<OsintIntelProfile>(`${osintBase(businessId)}/profile`);
}

export async function getOsintIntelFacts(
  businessId: string,
  options: { factType?: string; limit?: number; offset?: number } = {},
): Promise<OsintIntelPage<OsintIntelFact>> {
  const params = new URLSearchParams();
  if (options.factType) params.set("factType", options.factType);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return apiRequest<OsintIntelPage<OsintIntelFact>>(
    `${osintBase(businessId)}/facts${query ? `?${query}` : ""}`,
  );
}

export async function getOsintIntelChanges(
  businessId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<OsintIntelPage<OsintIntelChange>> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  const query = params.toString();
  return apiRequest<OsintIntelPage<OsintIntelChange>>(
    `${osintBase(businessId)}/changes${query ? `?${query}` : ""}`,
  );
}

export async function getOsintIntelContradictions(
  businessId: string,
): Promise<{ businessId: string; contradictions: OsintIntelContradiction[] }> {
  return apiRequest<{ businessId: string; contradictions: OsintIntelContradiction[] }>(
    `${osintBase(businessId)}/contradictions`,
  );
}

/* ============ Research brief: «Паспорт OSINT-исследования» ============== */

export async function getOsintResearch(
  businessId: string,
): Promise<OsintResearch> {
  return apiRequest<OsintResearch>(`${osintBase(businessId)}/research`);
}

export async function saveOsintResearch(
  businessId: string,
  body: { content: unknown; expectedRevision: number | null },
): Promise<OsintResearchSaved> {
  return apiRequest<OsintResearchSaved>(`${osintBase(businessId)}/research`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function previewOsintResearch(
  businessId: string,
  body: { content: unknown; budget?: unknown },
): Promise<OsintResearchPreview> {
  return apiRequest<OsintResearchPreview>(
    `${osintBase(businessId)}/research/preview`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function launchOsintResearch(
  businessId: string,
  body: { content: unknown; expectedRevision: number | null },
): Promise<OsintResearchLaunched> {
  return apiRequest<OsintResearchLaunched>(
    `${osintBase(businessId)}/research/launch`,
    { method: "POST", body: JSON.stringify(body) },
  );
}
