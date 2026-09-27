/** Orders V2 frontend types (mirror server DTOs). */

export type OrderStatus =
  | "new"
  | "accepted"
  | "assembling"
  | "ready"
  | "handed_over"
  | "delivered"
  | "completed"
  | "cancelled";

export type OrderFulfillment = "delivery" | "pickup";

export type OrderSource = "telegram" | "vk" | "web";

export type BusinessMode = "store" | "service" | "combined";

export type OrdersTab = "orders" | "catalog" | "inventory" | "settings";

export type OrderDateFilter = "today" | "7d" | "30d" | "";

export type OrderFilterValues = {
  search: string;
  status: OrderStatus | "";
  source: OrderSource | "";
  fulfillment: OrderFulfillment | "";
  date: OrderDateFilter;
  assignedUserId: string;
};

export const EMPTY_ORDER_FILTERS: OrderFilterValues = {
  search: "",
  status: "",
  source: "",
  fulfillment: "",
  date: "",
  assignedUserId: "",
};

export const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Новый",
  accepted: "Принят",
  assembling: "Сборка",
  ready: "Готов",
  handed_over: "Выдан",
  delivered: "Доставлен",
  completed: "Завершён",
  cancelled: "Отменён",
};

export const STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["assembling", "cancelled"],
  assembling: ["ready", "cancelled"],
  ready: ["handed_over", "delivered", "cancelled"],
  handed_over: ["completed"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
};

export const FULFILLMENT_LABELS: Record<OrderFulfillment, string> = {
  pickup: "Самовывоз",
  delivery: "Доставка",
};

export const SOURCE_LABELS: Record<OrderSource, string> = {
  telegram: "Telegram",
  vk: "ВКонтакте",
  web: "Веб",
};

export type MoneyByCurrency = { currency: string; amount: string };

export type OrderSummary = {
  newCount: number;
  inProgressCount: number;
  todayRevenue: MoneyByCurrency[];
  averageCheck: MoneyByCurrency[];
  timezone: string;
};

export type OrderListItem = {
  id: string;
  orderNumber: number | null;
  status: OrderStatus;
  fulfillment: OrderFulfillment;
  source: OrderSource;
  customerName: string;
  customerPhone: string;
  clientId: string;
  clientName: string | null;
  clientPhone: string | null;
  currency: string;
  total: string;
  subtotal: string | null;
  deliveryFee: string;
  itemCount: number;
  createdAt: string;
  assignedUser: { id: string; name: string } | null;
  conversationId: string | null;
};

export type OrderListResponse = {
  items: OrderListItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

/** Detail payload from existing GET /orders/:id (snake_case from DB). */
export type OrderDetailItem = {
  id: string;
  name: string;
  variant_label: string;
  quantity: number;
  unit_price: string;
  line_total: string;
};

export type OrderStatusHistory = {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string;
  created_at: string;
};

export type OrderDetail = {
  id: string;
  order_number: number | null;
  status: OrderStatus;
  fulfillment: OrderFulfillment;
  source?: OrderSource;
  customer_name: string;
  customer_phone: string;
  total: string;
  currency: string;
  subtotal?: string | null;
  delivery_fee?: string;
  client_id: string;
  client_name?: string | null;
  conversation_id: string | null;
  delivery_address?: string;
  comment?: string;
  assigned_user_id?: string | null;
  assigned_user?: { id: string; name: string } | null;
  created_at: string;
  items: OrderDetailItem[];
  history: OrderStatusHistory[];
};

export type CreateOrderCartItem = {
  product_id: string;
  variant_id?: string | null;
  quantity: number;
};

export type CreateOrderInput = {
  request_key: string;
  source: "web";
  fulfillment: OrderFulfillment;
  customer_name: string;
  customer_phone: string;
  client_id?: string;
  delivery_address?: string;
  comment?: string;
  cart_items: CreateOrderCartItem[];
};

export type OrderSettings = {
  customerCancelStatuses: string[];
  pickupEnabled: boolean;
  pickupAddress: string;
  pickupInstructions: string;
  deliveryEnabled: boolean;
  deliveryPrice: string;
  freeDeliveryFrom: string | null;
  minimumOrderAmount: string | null;
  deliveryDescription: string;
  businessMode: BusinessMode;
};

export type InventoryState = "in_stock" | "low" | "out" | "untracked";

export type InventoryRow = {
  productId: string;
  variantId: string | null;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  stockQuantity: number | null;
  lowStockThreshold: number | null;
  trackInventory: boolean;
  productType: string;
  state: InventoryState;
  active: boolean;
};

export type ProductCategory = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  position: number;
};

export type ProductListItem = {
  id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  sku: string | null;
  active: boolean;
  category_id: string | null;
  use_variants: boolean;
  variant_prices_enabled?: boolean;
  track_inventory: boolean;
  availability: string;
  stock_quantity: number | null;
  product_type?: string;
};

export type ProductVariantOption = {
  id: string;
  name: string;
};

export type ProductOptionGroup = {
  id: string;
  name: string;
  options: ProductVariantOption[];
};

export type ProductVariantDraft = {
  id?: string;
  option_ids: string[];
  label: string;
  price: string;
  stock_quantity: string;
  active: boolean;
};

export type ProductEditorState = {
  name: string;
  description: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  categoryId: string;
  active: boolean;
  trackInventory: boolean;
  stockQuantity: string;
  useVariants: boolean;
  variantPricesEnabled: boolean;
  groups: ProductOptionGroup[];
  variants: ProductVariantDraft[];
  images: { id: string; filename: string; type: string }[];
  productType: "product" | "service";
};

export const EMPTY_PRODUCT_EDITOR: ProductEditorState = {
  name: "",
  description: "",
  sku: "",
  price: "",
  compareAtPrice: "",
  categoryId: "",
  active: true,
  trackInventory: false,
  stockQuantity: "",
  useVariants: false,
  variantPricesEnabled: false,
  groups: [],
  variants: [],
  images: [],
  productType: "product",
};

export function primaryNextStatus(status: OrderStatus): OrderStatus | null {
  const next = (STATUS_FLOW[status] ?? []).find((s) => s !== "cancelled");
  return next ?? null;
}

export function nextActionLabel(status: OrderStatus): string | null {
  const next = primaryNextStatus(status);
  if (!next) return null;
  return `Перевести в «${STATUS_LABELS[next]}»`;
}

export function tabsForBusinessMode(mode: BusinessMode): OrdersTab[] {
  if (mode === "service") return ["orders", "catalog", "settings"];
  if (mode === "combined") return ["orders", "catalog", "inventory", "settings"];
  return ["orders", "catalog", "inventory", "settings"];
}
