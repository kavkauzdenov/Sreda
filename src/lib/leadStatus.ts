import type { LeadStatus } from "@/types";

/** Client-safe status labels — mirrors server/leads/status.ts */
export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Новая",
  processing: "В работе",
  waiting_customer: "Ждём клиента",
  completed: "Выполнена",
  rejected: "Отклонена",
  closed: "Закрыта",
};

const ALLOWED: Record<LeadStatus, LeadStatus[]> = {
  new: ["processing", "rejected", "closed"],
  processing: ["waiting_customer", "completed", "rejected", "closed"],
  waiting_customer: ["processing", "completed", "closed"],
  completed: [],
  rejected: [],
  closed: [],
};

export function allowedLeadTransitions(from: LeadStatus): LeadStatus[] {
  return ALLOWED[from] ?? [];
}

export function leadStatusLabel(status: LeadStatus): string {
  return LEAD_STATUS_LABELS[status] ?? status;
}

export const LEAD_STATUS_FILTER_OPTIONS: {
  value: LeadStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "Все" },
  { value: "new", label: "Новые" },
  { value: "processing", label: "В работе" },
  { value: "waiting_customer", label: "Ждём клиента" },
  { value: "completed", label: "Выполненные" },
  { value: "rejected", label: "Отклонённые" },
  { value: "closed", label: "Закрытые" },
];
