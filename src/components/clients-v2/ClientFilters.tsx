"use client";

import { useEffect, useState } from "react";
import { ClientSearch } from "@/components/clients-v2/ClientSearch";
import {
  EMPTY_CLIENT_FILTERS,
  type ClientFilterValues,
  type ClientTag,
} from "@/components/clients-v2/types";
import {
  getClientAssignees,
  getClientTags,
} from "@/services/clients.service";

export function ClientFilters({
  businessId,
  value,
  onChange,
  onRefresh,
  disabled,
}: {
  businessId: string;
  value: ClientFilterValues;
  onChange: (next: ClientFilterValues) => void;
  onRefresh?: () => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<ClientTag[]>([]);
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getClientTags(businessId),
      getClientAssignees(businessId),
    ])
      .then(([tagRows, assigneeRows]) => {
        if (!active) return;
        setTags(tagRows);
        setAssignees(assigneeRows);
      })
      .catch(() => {
        if (!active) return;
        setTags([]);
        setAssignees([]);
      });
    return () => {
      active = false;
    };
  }, [businessId]);

  function toggleFlag(
    key:
      | "hasLeads"
      | "hasOrders"
      | "hasBookings"
      | "hasOpenConversation"
      | "hasNotes"
      | "newOnly",
  ) {
    onChange({ ...value, [key]: !value[key] });
  }

  const checks: {
    key:
      | "hasLeads"
      | "hasOrders"
      | "hasBookings"
      | "hasOpenConversation"
      | "hasNotes"
      | "newOnly";
    label: string;
  }[] = [
    { key: "hasLeads", label: "С заявками" },
    { key: "hasOrders", label: "С заказами" },
    { key: "hasBookings", label: "С записями" },
    { key: "hasOpenConversation", label: "Открытое обращение" },
    { key: "hasNotes", label: "С заметками" },
    { key: "newOnly", label: "Только новые" },
  ];

  return (
    <section className="panel clients-filters" aria-label="Фильтры клиентов">
      <ClientSearch
        value={value.search}
        disabled={disabled}
        onChange={(search) => onChange({ ...value, search })}
      />
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
          onClick={() => onChange({ ...EMPTY_CLIENT_FILTERS })}
        >
          Сбросить
        </button>
      </div>
      <div className={"clients-filters__extra" + (open ? " is-open" : "")}>
        <label className="field">
          <span className="field__label">Канал</span>
          <select
            className="field__control"
            value={value.channel}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                channel: e.target.value as ClientFilterValues["channel"],
              })
            }
          >
            <option value="">Все каналы</option>
            <option value="telegram">Telegram</option>
            <option value="vk">ВКонтакте</option>
            <option value="whatsapp">WhatsApp</option>
            <option value="instagram">Instagram</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Активность</span>
          <select
            className="field__control"
            value={value.activity}
            disabled={disabled}
            onChange={(e) =>
              onChange({
                ...value,
                activity: e.target.value as ClientFilterValues["activity"],
              })
            }
          >
            <option value="">Любая</option>
            <option value="today">Сегодня</option>
            <option value="7d">7 дней</option>
            <option value="30d">30 дней</option>
            <option value="inactive">Неактивные</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Тег</span>
          <select
            className="field__control"
            value={value.tagId}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, tagId: e.target.value })}
          >
            <option value="">Все теги</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
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
            {assignees.map((assignee) => (
              <option key={assignee.id} value={assignee.id}>
                {assignee.name}
              </option>
            ))}
          </select>
        </label>
        <div className="clients-filters__checks" role="group" aria-label="Признаки">
          {checks.map((item) => (
            <label
              key={item.key}
              className={value[item.key] ? "is-active" : undefined}
            >
              <input
                type="checkbox"
                checked={value[item.key]}
                disabled={disabled}
                onChange={() => toggleFlag(item.key)}
              />
              {item.label}
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
