export type Platform = "telegram" | "vk" | "whatsapp" | "instagram" | "max";

export type ConnectionStatus =
  | "connected"
  | "disconnected"
  | "pending"
  | "error";

export type SolutionStatus =
  | "available"
  | "active"
  | "setup_required"
  | "paused"
  | "unavailable";

export type SolutionLifecycleStatus =
  | "not_connected"
  | "setup_in_progress"
  | "active"
  | "paused"
  | "disabled"
  | "expired"
  | "error";

export type LeadStatus =
  | "new"
  | "processing"
  | "waiting_customer"
  | "completed"
  | "rejected"
  | "closed";

export type PostStatus = "draft" | "scheduled" | "published";

export interface User {
  id: string;
  name: string;
  email?: string;
  username?: string | null;
  avatarUrl?: string;
}

export interface Business {
  id: string;
  ownerId: string;
  timezone?: string;
  role?: "owner" | "admin" | "operator";
  name: string;
  avatarUrl?: string;
  planName?: string;
}

export interface Connection {
  id: string;
  businessId: string;
  platform: Platform;
  status: ConnectionStatus;
  displayName: string;
}

export interface Solution {
  id: string;
  code: string;
  name: string;
  description: string;
  price: number;
}

export interface BusinessSolution {
  note?: string;
  id: string;
  businessId: string;
  solutionId: string;
  status: SolutionStatus;
  lifecycleStatus?: SolutionLifecycleStatus;
  setupDraft?: { status: string; step: number };
  entitlementStatus?:
    | "active"
    | "trial"
    | "paused"
    | "disabled"
    | "absent"
    | "expired";
}

export interface Lead {
  processingBy?: string | null;
  processingName?: string;
  processingAt?: string;
  answers?: Record<string, unknown>;
  updatedAt?: string;
  clientId?: string | null;
  id: string;
  businessId: string;
  source: Platform;
  name: string;
  phone?: string;
  message?: string;
  status: LeadStatus;
  createdAt: string;
}

export interface Post {
  id: string;
  businessId: string;
  text: string;
  imageUrl?: string;
  excerpt?: string;
  platforms: Platform[];
  status: PostStatus;
  publishAt?: string;
}

export interface BillingInfo {
  businessId: string;
  planName: string;
  pricePerMonth: number;
  activeSolutionsCount: number;
  /** Entitlement-derived workspace status — not a payment receipt. */
  status: "active" | "paused" | "overdue" | "unpaid";
  /** Null until a real payment provider schedules charges. */
  nextChargeAt: string | null;
  paymentConnected: boolean;
  statusLabel?: string;
  nextStep?: string;
}
