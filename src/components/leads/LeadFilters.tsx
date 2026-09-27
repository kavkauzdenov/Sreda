"use client";

import { useEffect, useEffectEvent, useState } from "react";
import type { LeadStatus } from "@/types";
import { apiRequest } from "@/lib/apiClient";
import { LEAD_STATUS_FILTER_OPTIONS } from "@/lib/leadStatus";

export type LeadFilterValues = {
  status: LeadStatus | "all";
  search: string;
  source: string;
  from: string;
  until: string;
  processingBy: string;
};

type LeadAssignee = {
  id: string;
  name: string;
  role: "owner" | "admin" | "operator";
};

export function LeadFilters({
  businessId,
  value,
  onChange,
  onRefresh,
  disabled,
}: {
  businessId: string;
  value: LeadFilterValues;
  onChange: (next: LeadFilterValues) => void;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [searchDraft, setSearchDraft] = useState(value.search);
  const [assignees, setAssignees] = useState<LeadAssignee[]>([]);

  useEffect(() => {
    let active = true;
    void apiRequest<LeadAssignee[]>(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/leads?view=assignees`,
    )
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
  const commitSearch = useEffectEvent((draft: string) => {
    if (draft === value.search) return;
    onChange({ ...value, search: draft });
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      commitSearch(searchDraft);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchDraft]);

  function setStatus(status: LeadStatus | "all") {
    onChange({ ...value, status });
  }

  return (
    <section className="panel leads-filters" aria-label="Фильтры заявок">
      <div className="leads-filters__status" role="group" aria-label="Статус">
        {LEAD_STATUS_FILTER_OPTIONS.map((item) => (
          <button
            key={item.value}
            type="button"
            className={
              "button button--outline" +
              (value.status === item.value ? " is-pressed" : "")
            }
            aria-pressed={value.status === item.value}
            disabled={disabled}
            onClick={() => setStatus(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="leads-filters__toolbar">
        <button
          type="button"
          className="button button--outline leads-filters__toggle"
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
      </div>
      <div className={"leads-filters__extra" + (open ? " is-open" : "")}>
        <label className="field">
          <span className="field__label">Поиск</span>
          <input
            className="field__control"
            type="search"
            value={searchDraft}
            disabled={disabled}
            placeholder="Имя или телефон"
            onChange={(e) => setSearchDraft(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="field__label">Канал</span>
          <select
            className="field__control"
            value={value.source}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, source: e.target.value })}
          >
            <option value="">Все каналы</option>
            <option value="telegram">Telegram</option>
            <option value="vk">ВКонтакте</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Ответственный</span>
          <select
            className="field__control"
            value={value.processingBy}
            disabled={disabled}
            onChange={(e) =>
              onChange({ ...value, processingBy: e.target.value })
            }
          >
            <option value="">Все сотрудники</option>
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name}
              </option>
            ))}
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
          <span className="field__label">По дату</span>
          <input
            className="field__control"
            type="date"
            value={value.until}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, until: e.target.value })}
          />
        </label>
      </div>
    </section>
  );
}
