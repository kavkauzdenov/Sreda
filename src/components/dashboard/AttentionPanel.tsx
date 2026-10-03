"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { AlertTriangle, Info } from "lucide-react";
import type { AttentionItem } from "@/lib/dashboardAttention";

const TONE_ICON = {
  action: Info,
  warning: AlertTriangle,
  neutral: Info,
} as const;

/**
 * Prioritised to-do list. Each row links to the profile section that owns the
 * work — the dashboard states the priority, the section does the job, so no
 * table is duplicated here.
 */
export function AttentionPanel({
  items,
  emptyTitle = "Всё под контролем",
  emptyDescription = "Новых заявок, неподтверждённых заказов и сбоев подключения нет.",
}: {
  items: AttentionItem[];
  emptyTitle?: string;
  emptyDescription?: string;
}) {
  if (items.length === 0) {
    return (
      <section
        className="panel biznesoty-attention"
        aria-labelledby="attention-title"
        data-testid="dashboard-attention"
      >
        <div className="biznesoty-section-head">
          <h2 id="attention-title">Требует внимания</h2>
        </div>
        <div className="empty-state empty-state--compact" data-testid="attention-empty">
          <CheckCircle2 size={22} aria-hidden="true" />
          <strong>{emptyTitle}</strong>
          <p className="empty-copy">{emptyDescription}</p>
        </div>
      </section>
    );
  }

  return (
    <section
      className="panel biznesoty-attention"
      aria-labelledby="attention-title"
      data-testid="dashboard-attention"
    >
      <div className="biznesoty-section-head">
        <h2 id="attention-title">Требует внимания</h2>
        <p>{items.length === 1 ? "1 задача" : `${items.length} задачи`}</p>
      </div>
      <ul className="biznesoty-attention__list">
        {items.map((item) => {
          const Icon = TONE_ICON[item.tone];
          return (
            <li
              key={item.id}
              className={`biznesoty-attention__item is-${item.tone}`}
              data-testid="attention-item"
            >
              <span className="biznesoty-attention__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="biznesoty-attention__body">
                <strong>{item.title}</strong>
                <span className="account-footnote">{item.detail}</span>
              </span>
              <Link className="button button--outline button--sm" href={item.href}>
                {item.cta}
                <ArrowRight size={16} aria-hidden="true" />
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}