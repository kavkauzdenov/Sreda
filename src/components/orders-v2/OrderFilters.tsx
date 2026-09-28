"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { getClientAssignees } from "@/services/clients.service";
import {
  EMPTY_ORDER_FILTERS,
  FULFILLMENT_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  type OrderFilterValues,
  type OrderStatus,
} from "@/components/orders-v2/types";

export function OrderFilters({
  businessId,
  value,
  onChange,
  onRefresh,
  disabled,
}: {
  businessId: string;
  value: OrderFilterValues;
  onChange: (next: OrderFilterValues) => void;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draftSearch, setDraftSearch] = useState(value.search);
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);

  const commitSearch = useEffectEvent((next: string) => {
    if (next === value.search) return;
    onChange({ ...value, search: next });
  });

  useEffect(() => {
    const timer = window.setTimeout(() => commitSearch(draftSearch), 300);
    return () => window.clearTimeout(timer);
  }, [draftSearch]);

  useEffect(() => {
    queueMicrotask(() => setDraftSearch(value.search));
  }, [value.search]);

  useEffect(() => {
    let active = true;
    void getClientAssignees(businessId)
      .then((rows) => {
        if (active) setAssignees(rows);
      })
      .catch(() => {
        if (active) setAssignees([]);
      });
    return () => {
      active = false;
    };
  }, [businessId]);

  return (
    <section className="panel clients-filters" aria-label="Фильтры заказов">
      <label className="field clients-search">
        <span className="field__label">Поиск</span>
        <input
          className="field__control"
          type="search"
          value={draftSearch}
          disabled={disabled}
          placeholder="Номер, имя или телефон…"
          maxLength={100}
          onChange={(e) => setDraftSearch(e.target.value)}
        />
      </label>
      <div className="clients-filters__toolbar">
        <button
          type="button"
          className="button button--outline clients-filters__toggle"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Скрыть фильтры" : "Фильтры"}
        </button>
        {onRefresh ? (
          <button
            type="button"
            className="button button--outline"
            disabled={disabled}
            onClick={onRefresh}
          >
            Обновить
          </button>
        ) : null}
        <button
          type="button"
          className="button button--outline"
          disabled={disabled}
          onClick={() => onChange({ ...EMPTY_ORDER_FILTERS })}
        >
          Сбросить
        </button>
      </div>
      <div className={"clients-filters__extra" + (open ? " is-open" : "")}>
        <label className="field">
          <span className="field__label">Статус</span>
          <select
            className="field__control"
            value={value.status}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                status: e.target.value as OrderStatus | "",
              })
            }
          >
            <option value="">Все статусы</option>
            {(Object.keys(STATUS_LABELS) as OrderStatus[]).map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Канал</span>
          <select
            className="field__control"
            value={value.source}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                source: e.target.value as OrderFilterValues["source"],
              })
            }
          >
            <option value="">Все каналы</option>
            {(Object.keys(SOURCE_LABELS) as Array<keyof typeof SOURCE_LABELS>).map(
              (source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Получение</span>
          <select
            className="field__control"
            value={value.fulfillment}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                fulfillment: e.target
                  .value as OrderFilterValues["fulfillment"],
              })
            }
          >
            <option value="">Любой способ</option>
            {(
              Object.keys(FULFILLMENT_LABELS) as Array<
                keyof typeof FULFILLMENT_LABELS
              >
            ).map((fulfillment) => (
              <option key={fulfillment} value={fulfillment}>
                {FULFILLMENT_LABELS[fulfillment]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Период</span>
          <select
            className="field__control"
            value={value.date}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                date: e.target.value as OrderFilterValues["date"],
              })
            }
          >
            <option value="">Весь период</option>
            <option value="today">Сегодня</option>
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Ответственный</span>
          <select
            className="field__control"
            value={value.assignedUserId}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...value, assignedUserId: e.target.value })
            }
          >
            <option value="">Все сотрудники</option>
            <option value="none">Без ответственного</option>
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}
