"use client";

import { useEffect, useEffectEvent, useState } from "react";
import {
  InventoryMobileCard,
  InventoryRow,
} from "@/components/orders-v2/InventoryRow";
import { StockEditor } from "@/components/orders-v2/StockEditor";
import type {
  InventoryRow as InventoryRowData,
  InventoryState,
} from "@/components/orders-v2/types";
import { getInventory } from "@/services/orders.service";

export function InventoryView({ businessId }: { businessId: string }) {
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<InventoryState | "">("");
  const [items, setItems] = useState<InventoryRowData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<InventoryRowData | null>(null);
  const [attempt, setAttempt] = useState(0);

  const commitSearch = useEffectEvent((next: string) => {
    if (next === search) return;
    setSearch(next);
  });

  useEffect(() => {
    const timer = window.setTimeout(() => commitSearch(searchDraft), 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void getInventory(businessId, { search, state })
      .then((result) => {
        if (!alive) return;
        setItems(result.items);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setItems([]);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить склад.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, search, state, attempt]);

  return (
    <div className="orders-inventory">
      <section className="panel clients-filters" aria-label="Фильтры склада">
        <label className="field clients-search">
          <span className="field__label">Поиск</span>
          <input
            className="field__control"
            type="search"
            value={searchDraft}
            placeholder="Название, вариант или SKU…"
            onChange={(e) => setSearchDraft(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Состояние</span>
          <select
            className="field__control"
            value={state}
            onChange={(e) =>
              setState(e.target.value as InventoryState | "")
            }
          >
            <option value="">Все</option>
            <option value="in_stock">В наличии</option>
            <option value="low">Мало</option>
            <option value="out">Нет в наличии</option>
            <option value="untracked">Не учитывается</option>
          </select>
        </label>
        <button
          type="button"
          className="button button--outline"
          onClick={() => setAttempt((v) => v + 1)}
        >
          Обновить
        </button>
      </section>

      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}

      <section className="panel clients-list" aria-label="Склад">
        {loading ? (
          <div className="clients-skeleton" aria-busy="true">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="clients-skeleton__row" />
            ))}
          </div>
        ) : !items.length ? (
          <div className="empty-state empty-state--compact">
            <p>Позиций склада пока нет.</p>
            <p className="account-footnote">
              Включите учёт остатков у товаров в каталоге.
            </p>
          </div>
        ) : (
          <>
            <table className="clients-list__table orders-inventory__table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>Остаток</th>
                  <th>Состояние</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <InventoryRow
                    key={`${row.productId}:${row.variantId ?? "base"}`}
                    row={row}
                    onEdit={() => setEditing(row)}
                  />
                ))}
              </tbody>
            </table>
            <ul className="clients-mobile-cards">
              {items.map((row) => (
                <li key={`${row.productId}:${row.variantId ?? "base"}`}>
                  <InventoryMobileCard
                    row={row}
                    onEdit={() => setEditing(row)}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {editing ? (
        <StockEditor
          businessId={businessId}
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setAttempt((v) => v + 1)}
        />
      ) : null}
    </div>
  );
}
