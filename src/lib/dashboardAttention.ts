/**
 * "Требует внимания" — the dashboard's prioritised to-do list.
 *
 * Pure functions over already-fetched counters, so the priority logic is unit
 * testable and never depends on render order. Every item points at the profile
 * section that owns the work: the dashboard states the priority, the profile tab
 * does the full job (no duplicated tables here).
 *
 * Nothing here invents data — an item exists only when a real counter is non-zero
 * or a real configuration state is unmet.
 */

export type AttentionTone = "action" | "warning" | "neutral";

export type AttentionItem = {
  id: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
  tone: AttentionTone;
  /** Higher sorts first. */
  weight: number;
};

export type AttentionInput = {
  leads: { newCount: number; processingCount: number } | null;
  orders: { newCount: number; inProgressCount: number } | null;
  bookings: { todayCount: number } | null;
  connections: { connected: number; problemCount: number };
  solutions: { setupRequiredCount: number; totalCount: number };
  /** True once the business finished onboarding — suppresses setup nudges. */
  onboardingComplete: boolean;
};

/**
 * Build the attention list. Returns an empty array when nothing needs action —
 * the caller renders a calm "всё в порядке" state rather than inventing work.
 */
export function buildAttentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];
  const leads = input.leads;
  const orders = input.orders;

  if (leads && leads.newCount > 0) {
    items.push({
      id: "leads-new",
      title:
        leads.newCount === 1
          ? "1 новая заявка ждёт ответа"
          : `${leads.newCount} новые заявки ждут ответа`,
      detail: "Самый быстрый способ не потерять клиента — ответить в тот же день.",
      href: "/leads?status=new",
      cta: "Открыть заявки",
      tone: "action",
      weight: 100 + Math.min(leads.newCount, 50),
    });
  }

  if (orders && orders.newCount > 0) {
    items.push({
      id: "orders-new",
      title:
        orders.newCount === 1
          ? "1 новый заказ без подтверждения"
          : `${orders.newCount} новых заказа без подтверждения`,
      detail: "Подтвердите заказ, чтобы клиент знал, что он принят в работу.",
      href: "/orders?view=new",
      cta: "Открыть заказы",
      tone: "action",
      weight: 90 + Math.min(orders.newCount, 50),
    });
  }

  if (input.connections.problemCount > 0) {
    items.push({
      id: "connections-problem",
      title:
        input.connections.problemCount === 1
          ? "1 подключение не работает"
          : `${input.connections.problemCount} подключения не работают`,
      detail: "Сообщения и заявки из этого канала не доходят. Проверьте подключение.",
      href: "/settings?section=connections",
      cta: "Проверить подключения",
      tone: "warning",
      weight: 80,
    });
  }

  if (input.bookings && input.bookings.todayCount > 0) {
    items.push({
      id: "bookings-today",
      title: `Сегодня ${input.bookings.todayCount} ${
        input.bookings.todayCount === 1 ? "запись" : "записи"
      }`,
      detail: "Записи на сегодня по расписанию.",
      href: "/bookings",
      cta: "Открыть расписание",
      tone: "neutral",
      weight: 40,
    });
  }

  if (!input.onboardingComplete && input.solutions.setupRequiredCount > 0) {
    items.push({
      id: "solutions-setup",
      title: `Не настроено решений: ${input.solutions.setupRequiredCount}`,
      detail: "Решение включено, но его нужно довести до рабочего состояния.",
      href: "/solutions",
      cta: "Достроить настройку",
      tone: "neutral",
      weight: 30,
    });
  }

  if (input.connections.connected === 0 && input.solutions.totalCount > 0) {
    items.push({
      id: "connections-none",
      title: "Нет подключённых каналов",
      detail:
        "Без канала заявки и сообщения не попадут в систему — подключите Telegram или ВКонтакте.",
      href: "/settings?section=connections",
      cta: "Подключить канал",
      tone: "neutral",
      weight: 25,
    });
  }

  return items.sort((a, b) => b.weight - a.weight);
}

/**
 * Whether the workspace is still empty enough to warrant the onboarding empty
 * state. Used instead of showing a wall of zero-valued cards to a new user.
 */
export function isWorkspaceEmpty(input: {
  orders: AttentionInput["orders"];
  leads: AttentionInput["leads"];
  clients: { total: number } | null;
  bookings: { todayCount: number } | null;
}): boolean {
  const ordersNew = input.orders?.newCount ?? 0;
  const ordersActive = input.orders?.inProgressCount ?? 0;
  const leadsNew = input.leads?.newCount ?? 0;
  const leadsActive = input.leads?.processingCount ?? 0;
  const clients = input.clients?.total ?? 0;
  const bookings = input.bookings?.todayCount ?? 0;
  return (
    ordersNew + ordersActive + leadsNew + leadsActive + clients + bookings === 0
  );
}