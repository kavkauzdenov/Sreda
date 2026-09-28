"use client";

import { useEffect, useState } from "react";
import { formatMoney } from "@/lib/money";
import { getOrderSummary } from "@/services/orders.service";
import type { OrderSummary } from "@/components/orders-v2/types";

function moneyLine(rows: { currency: string; amount: string }[]): string {
  if (!rows.length) return "0 ₽";
  return rows.map((r) => formatMoney(r.amount, r.currency)).join(" · ");
}

export function OrdersSummaryCards({ businessId }: { businessId: string }) {
  const [summary, setSummary] = useState<OrderSummary | null>(null);
  const [error, setError] = useState("");
  const [loadingKey, setLoadingKey] = useState(businessId);

  useEffect(() => {
    let active = true;
    void getOrderSummary(businessId)
      .then((data) => {
        if (!active) return;
        setSummary(data);
        setError("");
        setLoadingKey(businessId);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setSummary(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить сводку.",
        );
        setLoadingKey(businessId);
      });
    return () => {
      active = false;
    };
  }, [businessId]);

  const stale = loadingKey !== businessId;

  return (
    <section className="panel clients-summary" aria-label="Сводка заказов">
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : !summary || stale ? (
        <ul
          className="clients-summary__cards clients-summary__cards--skeleton"
          aria-busy="true"
        >
          {["Новые", "В работе", "Сегодня", "Средний чек"].map((label) => (
            <li key={label}>
              <span>{label}</span>
              <strong>…</strong>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="clients-summary__cards">
          <li>
            <span>Новые</span>
            <strong>{summary.newCount}</strong>
          </li>
          <li>
            <span>В работе</span>
            <strong>{summary.inProgressCount}</strong>
          </li>
          <li>
            <span>Сегодня</span>
            <strong>{moneyLine(summary.todayRevenue)}</strong>
          </li>
          <li>
            <span>Средний чек</span>
            <strong>{moneyLine(summary.averageCheck)}</strong>
          </li>
        </ul>
      )}
    </section>
  );
}
