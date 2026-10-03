"use client";

import Link from "next/link";
import { Rocket } from "lucide-react";

/**
 * Empty state for a workspace with no orders, leads, bookings or clients yet.
 *
 * It routes to the setup steps that actually create the first record instead of
 * showing a wall of zero-valued cards. Rendered only once the pulse endpoints
 * have answered, so it never flashes for a business that simply has no traffic.
 */
export function DashboardEmptyState({
  hasConnections,
  onboardingComplete,
}: {
  hasConnections: boolean;
  onboardingComplete: boolean;
}) {
  return (
    <section className="panel" data-testid="dashboard-empty">
      <div className="biznesoty-section-head">
        <h2>Начнём с первого действия</h2>
        <p>Данных пока нет — это нормально для нового бизнеса</p>
      </div>
      <div className="empty-state">
        <Rocket size={24} aria-hidden="true" />
        <strong>Здесь появится сводка вашего бизнеса</strong>
        <p className="empty-copy">
          {hasConnections
            ? "Канал подключён — заявки и записи начнут приходить сюда автоматически."
            : "Подключите канал, и заявки из Telegram или ВКонтакте будут приходить прямо сюда."}
        </p>
        <div className="actions-row">
          {!hasConnections ? (
            <Link className="button button--primary" href="/settings?section=connections">
              Подключить канал
            </Link>
          ) : null}
          {!onboardingComplete ? (
            <Link className="button button--outline" href="/onboarding">
              Пройти настройку
            </Link>
          ) : null}
          <Link className="button button--outline" href="/solutions">
            Все решения
          </Link>
        </div>
      </div>
    </section>
  );
}