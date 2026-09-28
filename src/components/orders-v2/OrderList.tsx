"use client";

import Link from "next/link";
import {
  OrderMobileCard,
  OrderRow,
} from "@/components/orders-v2/OrderRow";
import type { OrderListItem } from "@/components/orders-v2/types";

export function OrderList({
  rows,
  selectedId,
  timezone,
  loading,
  hasMore,
  moreBusy,
  onSelect,
  onMore,
  onCreate,
}: {
  rows: OrderListItem[];
  selectedId: string | null;
  timezone: string;
  loading?: boolean;
  hasMore?: boolean;
  moreBusy?: boolean;
  onSelect: (id: string) => void;
  onMore?: () => void;
  onCreate?: () => void;
}) {
  if (loading) {
    return (
      <section
        className="panel clients-list"
        aria-busy="true"
        aria-label="Список заказов"
      >
        <div className="clients-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="clients-skeleton__row" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel clients-list" aria-label="Список заказов">
      <p className="account-footnote">Загружено заказов: {rows.length}</p>
      {rows.length ? (
        <>
          <table className="clients-list__table orders-list__table">
            <thead>
              <tr>
                <th>Заказ</th>
                <th>Клиент</th>
                <th>Сумма</th>
                <th>Когда</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <OrderRow
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
                <OrderMobileCard
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
          <p>Заказов по выбранным фильтрам пока нет.</p>
          <p className="account-footnote">
            Добавьте товары в каталог или создайте заказ вручную.
          </p>
          <div className="orders-empty-actions">
            {onCreate ? (
              <button
                type="button"
                className="button button--primary"
                onClick={onCreate}
              >
                Создать заказ
              </button>
            ) : null}
            <Link className="button button--outline" href="/orders?tab=catalog">
              Открыть каталог
            </Link>
          </div>
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
