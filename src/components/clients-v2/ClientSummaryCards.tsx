"use client";

import { useEffect, useState } from "react";
import { getClientSummary } from "@/services/clients.service";
import type { ClientSummary } from "@/components/clients-v2/types";

export function ClientSummaryCards({ businessId }: { businessId: string }) {
  const [summary, setSummary] = useState<ClientSummary | null>(null);
  const [error, setError] = useState("");
  const [loadingKey, setLoadingKey] = useState(businessId);

  useEffect(() => {
    let active = true;
    void getClientSummary(businessId)
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
    <section className="panel clients-summary" aria-label="Сводка клиентов">
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : !summary || stale ? (
        <ul className="clients-summary__cards clients-summary__cards--skeleton" aria-busy="true">
          {["Всего", "Новые 30д", "Активные", "С открытыми обращениями"].map(
            (label) => (
              <li key={label}>
                <span>{label}</span>
                <strong>…</strong>
              </li>
            ),
          )}
        </ul>
      ) : (
        <ul className="clients-summary__cards">
          <li>
            <span>Всего</span>
            <strong>{summary.total}</strong>
          </li>
          <li>
            <span>Новые 30д</span>
            <strong>{summary.new30d}</strong>
          </li>
          <li>
            <span>Активные</span>
            <strong>{summary.active30d}</strong>
          </li>
          <li>
            <span>С открытыми обращениями</span>
            <strong>{summary.openConversations}</strong>
          </li>
        </ul>
      )}
    </section>
  );
}
