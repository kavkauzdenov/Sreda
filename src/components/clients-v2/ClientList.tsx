"use client";

import { ClientListRow } from "@/components/clients-v2/ClientListRow";
import { ClientMobileCard } from "@/components/clients-v2/ClientMobileCard";
import type { ClientListItem } from "@/components/clients-v2/types";

export function ClientList({
  rows,
  selectedId,
  timezone,
  loading,
  hasMore,
  moreBusy,
  onSelect,
  onMore,
}: {
  rows: ClientListItem[];
  selectedId: string | null;
  timezone: string;
  loading?: boolean;
  hasMore?: boolean;
  moreBusy?: boolean;
  onSelect: (id: string) => void;
  onMore?: () => void;
}) {
  if (loading) {
    return (
      <section className="panel clients-list" aria-busy="true" aria-label="Список клиентов">
        <div className="clients-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="clients-skeleton__row" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel clients-list" aria-label="Список клиентов">
      <p className="account-footnote">Загружено клиентов: {rows.length}</p>
      {rows.length ? (
        <>
          <table className="clients-list__table">
            <thead>
              <tr>
                <th>Клиент</th>
                <th>Контакты</th>
                <th>Каналы</th>
                <th>Последняя активность</th>
                <th>Заявки</th>
                <th>Заказы</th>
                <th>Записи</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <ClientListRow
                  key={row.id}
                  row={row}
                  selected={selectedId === row.id}
                  timezone={timezone}
                  onSelect={onSelect}
                />
              ))}
            </tbody>
          </table>
          <ul className="clients-mobile-cards">
            {rows.map((row) => (
              <li key={row.id}>
                <ClientMobileCard
                  row={row}
                  selected={selectedId === row.id}
                  timezone={timezone}
                  onSelect={onSelect}
                />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <div className="empty-state empty-state--compact">
          <p>Клиентов по выбранным фильтрам пока нет.</p>
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="button button--outline"
          disabled={moreBusy}
          onClick={onMore}
        >
          {moreBusy ? "Загружаем…" : "Показать ещё"}
        </button>
      ) : null}
    </section>
  );
}
