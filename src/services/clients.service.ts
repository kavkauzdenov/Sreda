import { apiRequest } from "@/lib/apiClient";
import type {
  ClientDetail,
  ClientDetailTab,
  ClientFilterValues,
  ClientListResponse,
  ClientSummary,
  ClientTab,
  ClientTag,
  CreateClientInput,
  CursorPage,
  TimelineItem,
  UpdateClientInput,
} from "@/components/clients-v2/types";

function base(businessId: string) {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/clients`;
}

function listParams(
  filters: ClientFilterValues,
  cursor?: string | null,
  limit = 50,
): URLSearchParams {
  const params = new URLSearchParams({ view: "v2", limit: String(limit) });
  if (filters.search) params.set("search", filters.search);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.activity) params.set("activity", filters.activity);
  if (filters.hasLeads) params.set("hasLeads", "1");
  if (filters.hasOrders) params.set("hasOrders", "1");
  if (filters.hasBookings) params.set("hasBookings", "1");
  if (filters.hasOpenConversation) params.set("hasOpenConversation", "1");
  if (filters.hasNotes) params.set("hasNotes", "1");
  if (filters.tagId) params.set("tagId", filters.tagId);
  if (filters.assignedUserId) params.set("assignedUserId", filters.assignedUserId);
  if (filters.newOnly) params.set("newOnly", "1");
  if (cursor) params.set("cursor", cursor);
  return params;
}

export async function getClientSummary(
  businessId: string,
): Promise<ClientSummary> {
  return apiRequest(`${base(businessId)}?view=summary`);
}

export async function getClientPage(
  businessId: string,
  filters: ClientFilterValues,
  cursor?: string | null,
): Promise<ClientListResponse> {
  return apiRequest(`${base(businessId)}?${listParams(filters, cursor)}`);
}

export async function getClientTags(businessId: string): Promise<ClientTag[]> {
  return apiRequest(`${base(businessId)}?view=tags`);
}

export async function getClientAssignees(
  businessId: string,
): Promise<{ id: string; name: string; role: string }[]> {
  return apiRequest(`${base(businessId)}?view=assignees`);
}

export async function getClientDetail(
  businessId: string,
  clientId: string,
): Promise<ClientDetail> {
  return apiRequest(
    `${base(businessId)}/${encodeURIComponent(clientId)}?view=v2`,
  );
}

export async function getClientTimeline(
  businessId: string,
  clientId: string,
  cursor?: string | null,
): Promise<CursorPage<TimelineItem>> {
  const params = new URLSearchParams({ view: "timeline", limit: "30" });
  if (cursor) params.set("cursor", cursor);
  return apiRequest(
    `${base(businessId)}/${encodeURIComponent(clientId)}?${params}`,
  );
}

export async function getClientTabPage(
  businessId: string,
  clientId: string,
  tab: Exclude<ClientDetailTab, "overview" | "timeline">,
  cursor?: string | null,
): Promise<CursorPage<ClientTab>> {
  const params = new URLSearchParams({ view: tab, limit: "30" });
  if (cursor) params.set("cursor", cursor);
  return apiRequest(
    `${base(businessId)}/${encodeURIComponent(clientId)}?${params}`,
  );
}

export async function createClient(
  businessId: string,
  input: CreateClientInput,
) {
  return apiRequest(base(businessId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateClient(
  businessId: string,
  clientId: string,
  input: UpdateClientInput,
) {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function addClientNote(
  businessId: string,
  clientId: string,
  text: string,
) {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(clientId)}`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

export async function clientAction(
  businessId: string,
  clientId: string,
  body: Record<string, unknown>,
) {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(clientId)}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function createClientTag(
  businessId: string,
  name: string,
  colorKey?: string,
): Promise<ClientTag> {
  return apiRequest(base(businessId), {
    method: "POST",
    body: JSON.stringify({
      action: "create_tag",
      name,
      ...(colorKey ? { colorKey } : {}),
    }),
  });
}

export async function mergeClients(
  businessId: string,
  sourceClientId: string,
  targetClientId: string,
) {
  return apiRequest(`${base(businessId)}/merge`, {
    method: "POST",
    body: JSON.stringify({
      source_client_id: sourceClientId,
      target_client_id: targetClientId,
    }),
  });
}

export async function createLeadForClient(
  businessId: string,
  input: { name: string; phone?: string | null; clientId: string },
) {
  return apiRequest(
    `/api/v1/businesses/${encodeURIComponent(businessId)}/leads`,
    {
      method: "POST",
      body: JSON.stringify({
        source: "manual",
        name: input.name,
        phone: input.phone || undefined,
        clientId: input.clientId,
      }),
    },
  );
}
