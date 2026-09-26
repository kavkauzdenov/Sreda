import { terminologyFor } from "./industryPresets.ts";

export type SetupStep = { id: string; label: string; href: string };

export type SetupReadiness = {
  hasIndustry?: boolean;
  hasActiveSolution?: boolean;
  hasConnection?: boolean;
};

/**
 * Steps that are derived from live business data instead of manual ticks:
 * business.onboarding_completed_at, business_solution and business_connection.
 * A manual tick can never override them — otherwise the checklist claims
 * progress that the business does not actually have.
 */
const DERIVED: Record<string, (r: SetupReadiness) => boolean> = {
  industry: (r) => r.hasIndustry === true,
  solutions: (r) => r.hasActiveSolution === true,
  telegram: (r) => r.hasConnection === true,
};

export function isDerivedStep(id: string): boolean {
  return Object.hasOwn(DERIVED, id);
}

export function setupStepsForIndustry(industry?: string | null): SetupStep[] {
  const terms = terminologyFor(industry);
  switch (industry) {
    case "beauty":
    case "sport_health":
    case "education":
    case "rental":
      return [
        {
          id: "services",
          label: "Добавить услуги",
          href: "/bookings?tab=config",
        },
        {
          id: "specialists",
          label: `Добавить: ${terms.specialists.toLowerCase()}`,
          href: "/bookings?tab=config",
        },
        {
          id: "schedule",
          label: "Настроить расписание",
          href: "/bookings?tab=config",
        },
        { id: "telegram", label: "Подключить Telegram", href: "/connections" },
      ];
    case "retail":
    case "food":
      return [
        { id: "catalog", label: "Заполнить каталог", href: "/orders" },
        { id: "orders", label: "Проверить приём заказов", href: "/orders" },
        { id: "telegram", label: "Подключить Telegram", href: "/connections" },
      ];
    case "automotive":
      return [
        {
          id: "services",
          label: "Услуги или работы",
          href: "/bookings?tab=config",
        },
        {
          id: "leads",
          label: "Настроить заявки",
          href: "/solutions/leads/setup",
        },
        { id: "telegram", label: "Подключить Telegram", href: "/connections" },
      ];
    case "construction":
    case "professional_services":
      return [
        {
          id: "leads",
          label: "Настроить заявки",
          href: "/solutions/leads/setup",
        },
        { id: "telegram", label: "Подключить Telegram", href: "/connections" },
        { id: "ai", label: "Заполнить AI-профиль", href: "/settings?section=ai" },
      ];
    default:
      return [
        { id: "industry", label: "Выбрать направление", href: "/onboarding" },
        { id: "solutions", label: "Посмотреть решения", href: "/solutions" },
        { id: "telegram", label: "Подключить Telegram", href: "/connections" },
        { id: "ai", label: "Заполнить AI-профиль", href: "/settings?section=ai" },
      ];
  }
}

export function readinessSetupSteps(): SetupStep[] {
  return [
    {
      id: "industry",
      label: "Выбрать направление",
      href: "/onboarding",
    },
    {
      id: "solutions",
      label: "Подключить решение",
      href: "/solutions",
    },
    {
      id: "telegram",
      label: "Подключить площадку",
      href: "/settings?section=connections",
    },
  ];
}

export type ResolvedSetupStep = SetupStep & { done: boolean; derived: boolean };

export function resolveSetupStep(
  id: string,
  progress: Record<string, boolean>,
  readiness?: SetupReadiness,
): { done: boolean; derived: boolean } {
  const derived = DERIVED[id];
  if (derived) return { done: derived(readiness ?? {}), derived: true };
  return { done: progress[id] === true, derived: false };
}

/**
 * Single source of truth for "Стартовая настройка: N из M шагов": the same
 * resolution feeds the dashboard banner, both checklist variants and the
 * onboarding next-step link, so they can never disagree.
 */
export function resolveSetupSteps({
  steps,
  progress,
  readiness,
}: {
  steps: SetupStep[];
  progress?: Record<string, boolean> | null;
  readiness?: SetupReadiness;
}): {
  steps: ResolvedSetupStep[];
  done: number;
  total: number;
  next: ResolvedSetupStep | null;
} {
  const map = progress ?? {};
  const resolved = steps.map((step) => ({
    ...step,
    ...resolveSetupStep(step.id, map, readiness),
  }));
  const done = resolved.filter((s) => s.done).length;
  return {
    steps: resolved,
    done,
    total: resolved.length,
    next: resolved.find((s) => !s.done) ?? null,
  };
}
