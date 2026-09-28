import type { Generated } from "kysely";

export type ProductAvailability =
  | "quantity"
  | "in_stock"
  | "made_to_order"
  | "out_of_stock";

export type ProductType = "product" | "service";

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

export type CartPlatform = "telegram" | "vk" | "web";

export type BusinessMode = "store" | "service" | "combined";

export type InventoryMovementReason =
  | "manual_adjustment"
  | "order_checkout"
  | "order_cancelled"
  | "restock";

export const ORDER_STATUSES: OrderStatus[] = [
  "new",
  "accepted",
  "assembling",
  "ready",
  "handed_over",
  "delivered",
  "completed",
  "cancelled",
];

/** Base graph; fulfillment-specific filtering via allowedStatusesForFulfillment. */
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

/**
 * Pickup: ready → handed_over → completed.
 * Delivery: ready → delivered → completed.
 */
export function allowedStatusesForFulfillment(
  status: OrderStatus,
  fulfillment: OrderFulfillment,
): OrderStatus[] {
  const next = STATUS_FLOW[status] ?? [];
  return next.filter((s) => {
    if (s === "handed_over" && fulfillment === "delivery") return false;
    if (s === "delivered" && fulfillment === "pickup") return false;
    return true;
  });
}

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

/** Active (in-progress) statuses for KPI «В работе». */
export const IN_PROGRESS_STATUSES: OrderStatus[] = [
  "accepted",
  "assembling",
  "ready",
  "handed_over",
  "delivered",
];

/** Statuses counted toward «выручка сегодня». */
export const REVENUE_STATUSES: OrderStatus[] = [
  "handed_over",
  "delivered",
  "completed",
];

export interface OrderTables {
  product_category: {
    id: string;
    business_id: string;
    name: string;
    description: Generated<string>;
    position: Generated<number>;
    active: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  product: {
    id: string;
    business_id: string;
    category_id: string | null;
    name: string;
    description: Generated<string>;
    price: string;
    compare_at_price: string | null;
    currency: Generated<string>;
    sku: string | null;
    active: Generated<boolean>;
    position: Generated<number>;
    use_variants: Generated<boolean>;
    variant_prices_enabled: Generated<boolean>;
    track_inventory: Generated<boolean>;
    availability: Generated<ProductAvailability>;
    stock_quantity: number | null;
    low_stock_threshold: number | null;
    product_type: Generated<ProductType>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  product_image: {
    id: string;
    business_id: string;
    product_id: string;
    attachment_id: string;
    position: Generated<number>;
    created_at: Generated<Date>;
  };
  product_option_group: {
    id: string;
    business_id: string;
    product_id: string;
    name: string;
    position: Generated<number>;
  };
  product_option: {
    id: string;
    business_id: string;
    group_id: string;
    name: string;
    position: Generated<number>;
  };
  product_variant: {
    id: string;
    business_id: string;
    product_id: string;
    option_ids: unknown;
    label: Generated<string>;
    sku: string | null;
    price: string | null;
    availability: Generated<ProductAvailability>;
    stock_quantity: number | null;
    active: Generated<boolean>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  cart: {
    id: string;
    business_id: string;
    client_id: string | null;
    platform: CartPlatform;
    external_user_id: Generated<string>;
    updated_at: Generated<Date>;
  };
  cart_item: {
    id: string;
    business_id: string;
    cart_id: string;
    product_id: string;
    variant_id: string | null;
    quantity: number;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  order: {
    id: string;
    business_id: string;
    client_id: string;
    status: Generated<OrderStatus>;
    fulfillment: OrderFulfillment;
    customer_name: string;
    customer_phone: string;
    delivery_address: Generated<string>;
    comment: Generated<string>;
    currency: Generated<string>;
    total: string;
    subtotal: string | null;
    delivery_fee: Generated<string>;
    items_snapshot: unknown;
    source: CartPlatform;
    request_key: string;
    request_hash: string;
    conversation_id: string | null;
    inventory_restored_at: Date | null;
    order_number: number | null;
    assigned_user_id: string | null;
    assigned_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  business_order_seq: {
    business_id: string;
    next_number: Generated<number>;
  };
  order_settings: {
    business_id: string;
    customer_cancel_statuses: Generated<unknown>;
    pickup_enabled: Generated<boolean>;
    pickup_address: Generated<string>;
    pickup_instructions: Generated<string>;
    delivery_enabled: Generated<boolean>;
    delivery_price: Generated<string>;
    free_delivery_from: string | null;
    minimum_order_amount: string | null;
    delivery_description: Generated<string>;
    business_mode: Generated<BusinessMode>;
    updated_at: Generated<Date>;
  };
  order_item: {
    id: string;
    business_id: string;
    order_id: string;
    product_id: string | null;
    variant_id: string | null;
    name: string;
    variant_label: Generated<string>;
    sku: string | null;
    unit_price: string;
    quantity: number;
    line_total: string;
    stock_deducted: Generated<boolean>;
  };
  order_status_history: {
    id: string;
    business_id: string;
    order_id: string;
    from_status: string | null;
    to_status: string;
    actor_user_id: string | null;
    note: Generated<string>;
    created_at: Generated<Date>;
  };
  inventory_movement: {
    id: string;
    business_id: string;
    product_id: string;
    variant_id: string | null;
    delta: number;
    remaining: number | null;
    reason: InventoryMovementReason;
    order_id: string | null;
    actor_user_id: string | null;
    created_at: Generated<Date>;
  };
}
