import { apiRequest } from "@/lib/apiClient";
import type {
  CreateOrderInput,
  InventoryRow,
  InventoryState,
  OrderDetail,
  OrderFilterValues,
  OrderListResponse,
  OrderSettings,
  OrderStatus,
  OrderSummary,
  ProductCategory,
  ProductListItem,
} from "@/components/orders-v2/types";

function base(businessId: string) {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/orders`;
}

function productsBase(businessId: string) {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/products`;
}

function categoriesBase(businessId: string) {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/categories`;
}

function listParams(
  filters: OrderFilterValues,
  cursor?: string | null,
  limit = 50,
): URLSearchParams {
  const params = new URLSearchParams({ view: "v2", limit: String(limit) });
  if (filters.search) params.set("search", filters.search);
  if (filters.status) params.set("status", filters.status);
  if (filters.source) params.set("source", filters.source);
  if (filters.fulfillment) params.set("fulfillment", filters.fulfillment);
  if (filters.date) params.set("date", filters.date);
  if (filters.assignedUserId) params.set("assignedUserId", filters.assignedUserId);
  if (cursor) params.set("cursor", cursor);
  return params;
}

export async function getOrderSummary(
  businessId: string,
): Promise<OrderSummary> {
  return apiRequest(`${base(businessId)}?view=summary`);
}

export async function getOrderPage(
  businessId: string,
  filters: OrderFilterValues,
  cursor?: string | null,
): Promise<OrderListResponse> {
  return apiRequest(`${base(businessId)}?${listParams(filters, cursor)}`);
}

export async function getOrderDetail(
  businessId: string,
  orderId: string,
): Promise<OrderDetail> {
  return apiRequest(
    `${base(businessId)}/${encodeURIComponent(orderId)}`,
  );
}

export async function createOrder(
  businessId: string,
  input: CreateOrderInput,
): Promise<{ id: string }> {
  return apiRequest(base(businessId), {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateOrderStatus(
  businessId: string,
  orderId: string,
  status: OrderStatus,
): Promise<unknown> {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(orderId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
}

export async function claimOrder(
  businessId: string,
  orderId: string,
): Promise<{ id: string; assignedUser: { id: string; name: string } | null }> {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(orderId)}`, {
    method: "POST",
    body: JSON.stringify({ action: "claim" }),
  });
}

export async function assignOrder(
  businessId: string,
  orderId: string,
  assignedUserId: string | null,
): Promise<{ id: string; assignedUser: { id: string; name: string } | null }> {
  return apiRequest(`${base(businessId)}/${encodeURIComponent(orderId)}`, {
    method: "POST",
    body: JSON.stringify({ action: "assign", assignedUserId }),
  });
}

export async function getOrderSettings(
  businessId: string,
): Promise<OrderSettings> {
  return apiRequest(`${base(businessId)}?view=settings`);
}

export async function saveOrderSettings(
  businessId: string,
  patch: Partial<OrderSettings>,
): Promise<OrderSettings> {
  return apiRequest(`${base(businessId)}?view=settings`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function getInventory(
  businessId: string,
  opts: { search?: string; state?: InventoryState | "" } = {},
): Promise<{ items: InventoryRow[] }> {
  const params = new URLSearchParams({ view: "inventory" });
  if (opts.search) params.set("search", opts.search);
  if (opts.state) params.set("state", opts.state);
  return apiRequest(`${base(businessId)}?${params}`);
}

export async function adjustInventory(
  businessId: string,
  body: {
    productId: string;
    variantId?: string | null;
    quantity?: number;
    delta?: number;
  },
): Promise<unknown> {
  return apiRequest(`${base(businessId)}?view=inventory`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function listProducts(
  businessId: string,
): Promise<ProductListItem[]> {
  return apiRequest(productsBase(businessId));
}

export async function getProductDetail(
  businessId: string,
  productId: string,
): Promise<Record<string, unknown>> {
  return apiRequest(
    `${productsBase(businessId)}/${encodeURIComponent(productId)}`,
  );
}

export async function createProduct(
  businessId: string,
  payload: Record<string, unknown>,
): Promise<{ id: string }> {
  return apiRequest(productsBase(businessId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function updateProduct(
  businessId: string,
  productId: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  return apiRequest(
    `${productsBase(businessId)}/${encodeURIComponent(productId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );
}

export async function listCategories(
  businessId: string,
): Promise<ProductCategory[]> {
  return apiRequest(categoriesBase(businessId));
}

export async function createCategory(
  businessId: string,
  input: { name: string; active?: boolean; description?: string },
): Promise<ProductCategory> {
  return apiRequest(categoriesBase(businessId), {
    method: "POST",
    body: JSON.stringify({ active: true, ...input }),
  });
}
