"use client";

import { useEffect, useRef, useState } from "react";
import type { LeadStatus } from "@/types";
import { LEAD_STATUS_FILTER_OPTIONS } from "@/lib/leadStatus";

export type LeadFilterValues = {
  status: LeadStatus | "all";
  search: string;
  source: string;
  from: string;
  until: string;
};

export function LeadFilters({
  value,
  onChange,
  onRefresh,
  disabled,
}: {
  value: LeadFilterValues;
  onChange: (next: LeadFilterValues) => void;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(value.search);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => {
    setSearchDraft(value.search);
  }, [value.search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (searchDraft === valueRef.current.search) return;
      onChangeRef.current({ ...valueRef.current, search: searchDraft });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  function setStatus(status: LeadStatus | "all") {
    onChange({ ...value, status });
  }

  return (
    <section className="panel leads-filters" aria-label="Фильтры заявок">
      <div className="leads-filters__status" role="group" aria-label="Статус">
        {LEAD_STATUS_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={
              "status-chip leads-filters__chip" +
              (value.status === opt.value ? " is-active" : "")
            }
            aria-pressed={value.status === opt.value}
            disabled={disabled}
            onClick={() => setStatus(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="button button--outline leads-filters__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Скрыть фильтры" : "Ещё фильтры"}
      </button>

      <div
        className={
          "filter-grid leads-toolbar leads-filters__extra" +
          (open ? " is-open" : "")
        }
      >
        <label className="field filter-grid__search">
          <span className="field__label">Поиск</span>
          <input
            className="field__control"
            value={searchDraft}
            disabled={disabled}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Имя или телефон"
          />
        </label>
        <label className="field">
          <span className="field__label">Источник</span>
          <select
            className="field__control"
            value={value.source}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, source: e.target.value })}
          >
            <option value="">Все</option>
            <option value="telegram">Telegram</option>
            <option value="vk">VK</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">С даты</span>
          <input
            className="field__control"
            type="date"
            value={value.from}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
          />
        </label>
        <label className="field">
          <span className="field__label">До даты</span>
          <input
            className="field__control"
            type="date"
            value={value.until}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, until: e.target.value })}
          />
          <span className="field-hint">Не включая выбранный день</span>
        </label>
        {onRefresh ? (
          <div className="filter-grid__action">
            <button
              type="button"
              className="button button--outline"
              disabled={disabled}
              onClick={onRefresh}
            >
              Обновить
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
