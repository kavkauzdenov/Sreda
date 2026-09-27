import type { LeadStatus } from "@/types";

/**
 * Shared lead status labels + allowed transitions (client + server SoT).
 * Keep in sync — server assertLeadTransition imports from here.
 */

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  new: "Новая",
  processing: "В работе",
  waiting_customer: "Ждём клиента",
  completed: "Выполнена",
  rejected: "Отклонена",
  closed: "Закрыта",
};

/**
 * Deterministic UX transitions.
 * processing → new = «Вернуть в новые» (release assignee / return to queue).
 */
export const LEAD_STATUS_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ["processing", "rejected", "closed"],
  processing: ["waiting_customer", "completed", "rejected", "closed", "new"],
  waiting_customer: ["processing", "completed", "closed"],
  completed: [],
  rejected: [],
  closed: [],
};

export function allowedLeadTransitions(from: LeadStatus): LeadStatus[] {
  return LEAD_STATUS_TRANSITIONS[from] ?? [];
}

export function leadStatusLabel(status: LeadStatus): string {
  return LEAD_STATUS_LABELS[status] ?? status;
}

/** Human action label for a transition target (dropdown copy). */
export function leadTransitionActionLabel(
  from: LeadStatus,
  to: LeadStatus,
): string {
  if (from === "processing" && to === "new") return "Вернуть в новые";
  if (from === "new" && to === "processing") return "Взять в работу";
  return LEAD_STATUS_LABELS[to] ?? to;
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
