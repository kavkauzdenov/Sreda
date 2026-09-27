"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

export type LeadPeriod = 1 | 7 | 30;

type SummaryResponse = {
  periodDays: number;
  counts: Record<string, number>;
  analytics?: {
    total: number;
    byStatus: Record<string, number>;
  };
};

const PERIODS: { days: LeadPeriod; label: string }[] = [
  { days: 1, label: "Сегодня" },
  { days: 7, label: "7 дней" },
  { days: 30, label: "30 дней" },
];

export function LeadSummaryCards({
  businessId,
  period,
  onPeriodChange,
}: {
  businessId: string;
  period: LeadPeriod;
  onPeriodChange: (days: LeadPeriod) => void;
}) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState("");
  const [loadingKey, setLoadingKey] = useState(`${businessId}:${period}`);

  useEffect(() => {
    let active = true;
    const key = `${businessId}:${period}`;
    void apiRequest<SummaryResponse>(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/leads?summary=1&days=${period}`,
    )
      .then((data) => {
        if (!active) return;
        setCounts(data.counts ?? data.analytics?.byStatus ?? {});
        setError("");
        setLoadingKey(key);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setCounts(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить сводку.",
        );
        setLoadingKey(key);
      });
    return () => {
      active = false;
    };
  }, [businessId, period]);

  const stale = loadingKey !== `${businessId}:${period}`;
  const total = Number(counts?.total ?? 0);
  const neu = Number(counts?.new ?? 0);
  const processing = Number(counts?.processing ?? 0);
  const waiting = Number(counts?.waiting_customer ?? 0);
  const completed = Number(counts?.completed ?? 0);

  return (
    <section className="panel leads-summary" aria-label="Сводка заявок">
      <div className="leads-summary__periods" role="group" aria-label="Период">
        {PERIODS.map((item) => (
          <button
            key={item.days}
            type="button"
            className={
              "button button--outline" +
              (period === item.days ? " is-pressed" : "")
            }
            aria-pressed={period === item.days}
            onClick={() => onPeriodChange(item.days)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : !counts || stale ? (
        <p className="account-footnote">Загружаем сводку…</p>
      ) : (
        <ul className="leads-summary__cards">
          <li>
            <span>Всего</span>
            <strong>{total}</strong>
          </li>
          <li>
            <span>Новые</span>
            <strong>{neu}</strong>
          </li>
          <li>
            <span>В работе</span>
            <strong>{processing}</strong>
          </li>
          <li>
            <span>Ждём клиента</span>
            <strong>{waiting}</strong>
          </li>
          <li>
            <span>Выполнены</span>
            <strong>{completed}</strong>
          </li>
        </ul>
      )}
    </section>
  );
}
