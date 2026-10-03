"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { DashboardPulse } from "@/hooks/useDashboardPulse";
import { formatMoneyRub } from "@/lib/format";

/**
 * Business state summary — four real counters, each a link to its profile
 * section. Nothing here is decorative: a card exists only when the endpoint
 * answered, and a zero is a true zero rather than a placeholder.
 */
export function BusinessSummary({
  pulse,
}: {
  pulse: DashboardPulse;
}) {
  const { orders, leads, clients, bookings } = pulse;
  const revenue =
    orders?.todayRevenue?.reduce((sum, row) => sum + (Number(row.amount) || 0), 0) ??
    0;

  const cards = [
    orders
      ? {
          id: "revenue",
          label: "Выручка за сегодня",
          value: formatMoneyRub(revenue),
          hint: "Учтены завершённые заказы за сегодня",
          href: "/analytics",
        }
      : null,
    orders
      ? {
          id: "orders",
          label: "Заказы в работе",
          value: String(orders.inProgressCount),
          hint:
            orders.newCount > 0
              ? `из них ${orders.newCount} без подтверждения`
              : "все подтверждены",
          href: "/orders",
        }
      : null,
    leads
      ? {
          id: "leads",
          label: "Заявки без ответа",
          value: String(leads.newCount),
          hint:
            leads.processingCount > 0
              ? `${leads.processingCount} в работе`
              : "новых нет",
          href: "/leads",
        }
      : null,
    bookings
      ? (() => {
          const next = bookings.nextStartAt;
          return {
            id: "bookings",
            label: "Записи на сегодня",
            value: String(bookings.todayCount),
            hint: next
              ? `ближайшая в ${new Date(next).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
              : "на сегодня пусто",
            href: "/bookings",
          };
        })()
      : null,
    clients
      ? {
          id: "clients",
          label: "Клиенты",
          value: String(clients.total),
          hint: clients.new30d > 0 ? `+${clients.new30d} за 30 дней` : "за 30 дней новых нет",
          href: "/clients",
        }
      : null,
  ].filter(Boolean) as {
    id: string;
    label: string;
    value: string;
    hint: string;
    href: string;
  }[];

  if (cards.length === 0) {
    return (
      <section className="panel biznesoty-summary" aria-labelledby="summary-title">
        <div className="biznesoty-section-head">
          <h2 id="summary-title">Сводка</h2>
        </div>
        <div className="empty-state empty-state--compact">
          <p className="empty-copy">
            Показатели появятся, как только накопятся заказы, заявки и записи.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="panel biznesoty-summary" aria-labelledby="summary-title">
      <div className="biznesoty-section-head">
        <h2 id="summary-title">Сводка</h2>
        <Link className="text-link" href="/analytics">
          Вся аналитика
          <ArrowRight size={16} aria-hidden="true" />
        </Link>
      </div>
      <ul className="biznesoty-summary__grid" data-testid="dashboard-summary">
        {cards.map((card) => (
          <li key={card.id} className="biznesoty-summary__card">
            <span className="biznesoty-summary__label">{card.label}</span>
            <strong className="biznesoty-summary__value">{card.value}</strong>
            <span className="account-footnote">{card.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}