"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, ClientError } from "@/lib/apiClient";
import {
  LEAD_FORM_PRESETS,
  type LeadFormPresetId,
} from "@/lib/leadFormPresetsV2";

export type LeadFormField = {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  active: boolean;
  placeholder?: string;
  options?: unknown;
  position?: number;
};

const FIELD_TYPES: { value: string; label: string }[] = [
  { value: "text", label: "Текст" },
  { value: "textarea", label: "Многострочный текст" },
  { value: "phone", label: "Телефон" },
  { value: "email", label: "Email" },
  { value: "number", label: "Число" },
  { value: "select", label: "Список" },
  { value: "date", label: "Дата" },
  { value: "checkbox", label: "Флажок" },
  { value: "address", label: "Адрес" },
  { value: "budget", label: "Бюджет" },
  { value: "service", label: "Услуга" },
  { value: "message", label: "Сообщение" },
  { value: "attachment", label: "Файл" },
];

function keyFromLabel(label: string) {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "_")
    .replace(/[^a-z0-9_]+/gi, "")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  if (base && /^[a-z]/i.test(base)) return base;
  return "field_" + Date.now().toString(36);
}

function typeLabel(value: string) {
  return FIELD_TYPES.find((item) => item.value === value)?.label ?? value;
}

function optionsToText(options: unknown): string {
  if (!Array.isArray(options)) return "";
  return options
    .map((item) =>
      typeof item === "string"
        ? item
        : item && typeof item === "object" && "label" in item
          ? String((item as { label: string }).label)
          : "",
    )
    .filter(Boolean)
    .join("\n");
}

function textToOptions(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 50);
}

export function LeadFormBuilder({
  businessId,
  canEdit,
  onFieldsChange,
}: {
  businessId: string;
  canEdit: boolean;
  onFieldsChange?: (fields: LeadFormField[]) => void;
}) {
  const base = `/api/v1/businesses/${encodeURIComponent(businessId)}/lead-form-fields`;
  const [fields, setFields] = useState<LeadFormField[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRequired, setEditRequired] = useState(false);
  const [editPlaceholder, setEditPlaceholder] = useState("");
  const [editOptions, setEditOptions] = useState("");
  const [editType, setEditType] = useState("text");
  const [newLabel, setNewLabel] = useState("");
  const [newType, setNewType] = useState("text");
  const [newRequired, setNewRequired] = useState(false);
  const [pendingPreset, setPendingPreset] = useState<LeadFormPresetId | null>(
    null,
  );

  const publish = useCallback(
    (rows: LeadFormField[]) => {
      const active = rows.filter((row) => row.active !== false);
      setFields(active);
      onFieldsChange?.(active);
    },
    [onFieldsChange],
  );

  const refresh = useCallback(async () => {
    const rows = await apiRequest<LeadFormField[]>(base);
    publish(rows);
  }, [base, publish]);

  useEffect(() => {
    let active = true;
    void apiRequest<LeadFormField[]>(base)
      .then((rows) => {
        if (!active) return;
        publish(rows);
        setLoaded(true);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить поля формы.",
        );
        setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [base, publish]);

  async function reorder(orderedIds: string[]) {
    if (!canEdit || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const rows = await apiRequest<LeadFormField[]>(base, {
        method: "POST",
        body: JSON.stringify({ action: "reorder", orderedIds }),
      });
      publish(rows);
      setNotice("Порядок полей сохранён.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось изменить порядок.",
      );
    } finally {
      setBusy(false);
    }
  }

  function move(index: number, direction: -1 | 1) {
    const next = index + direction;
    if (next < 0 || next >= fields.length) return;
    const ordered = fields.map((f) => f.id);
    const item = ordered[index];
    if (!item) return;
    ordered.splice(index, 1);
    ordered.splice(next, 0, item);
    void reorder(ordered);
  }

  async function applyPreset(presetId: LeadFormPresetId, replace: boolean) {
    if (!canEdit || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<{
        applied?: boolean;
        needsConfirm?: boolean;
        fields?: LeadFormField[];
        reason?: string;
      }>(base, {
        method: "POST",
        body: JSON.stringify({
          action: "apply_preset",
          presetId,
          replace,
        }),
      });
      if (result.needsConfirm && !replace) {
        setPendingPreset(presetId);
        return;
      }
      setPendingPreset(null);
      await refresh();
      setNotice("Шаблон применён.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось применить шаблон.",
      );
    } finally {
      setBusy(false);
    }
  }

  function startEdit(field: LeadFormField) {
    setEditingId(field.id);
    setEditLabel(field.label);
    setEditRequired(field.required);
    setEditPlaceholder(field.placeholder ?? "");
    setEditOptions(optionsToText(field.options));
    setEditType(field.fieldType === "name" ? "name" : field.fieldType);
  }

  async function saveEdit() {
    if (!canEdit || busy || !editingId) return;
    const field = fields.find((f) => f.id === editingId);
    if (!field) return;
    const isName = field.fieldKey === "name";
    setBusy(true);
    setError("");
    try {
      await apiRequest(`${base}/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          fieldKey: field.fieldKey,
          label: editLabel.trim() || field.label,
          fieldType: isName ? "name" : editType,
          required: isName ? true : editRequired,
          placeholder: editPlaceholder,
          options:
            editType === "select" || editType === "multiselect"
              ? textToOptions(editOptions)
              : [],
          position: field.position ?? 0,
          active: true,
        }),
      });
      setEditingId(null);
      await refresh();
      setNotice("Поле сохранено.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось сохранить поле.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(field: LeadFormField) {
    if (!canEdit || busy || field.fieldKey === "name") return;
    setBusy(true);
    setError("");
    try {
      const key = keyFromLabel(field.label + "_copy");
      await apiRequest(base, {
        method: "POST",
        body: JSON.stringify({
          fieldKey: key,
          label: field.label + " (копия)",
          fieldType: field.fieldType === "name" ? "text" : field.fieldType,
          required: field.required,
          placeholder: field.placeholder ?? "",
          options: field.options ?? [],
          position: fields.length,
        }),
      });
      await refresh();
      setNotice("Поле скопировано.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось скопировать поле.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(field: LeadFormField) {
    if (!canEdit || busy || field.fieldKey === "name") return;
    if (!window.confirm(`Удалить поле «${field.label}»?`)) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(`${base}/${encodeURIComponent(field.id)}`, {
        method: "DELETE",
      });
      await refresh();
      setNotice("Поле удалено.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось удалить поле.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function addField() {
    if (!canEdit || busy) return;
    const text = newLabel.trim();
    if (!text) {
      setError("Укажите название поля.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await apiRequest(base, {
        method: "POST",
        body: JSON.stringify({
          fieldKey: keyFromLabel(text),
          label: text,
          fieldType: newType,
          required: newRequired,
          position: fields.length,
        }),
      });
      setNewLabel("");
      setNewType("text");
      setNewRequired(false);
      await refresh();
      setNotice("Поле добавлено.");
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось добавить поле.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="lead-form-builder" aria-label="Конструктор формы заявки">
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="account-notice" role="status" aria-live="polite">
          {notice}
        </p>
      ) : null}

      {canEdit ? (
        <div className="lead-form-builder__presets">
          <p className="setup-description">
            Выберите шаблон отрасли или соберите форму сами.
          </p>
          <div className="industry-grid" role="list">
            {LEAD_FORM_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className="industry-card"
                disabled={busy}
                onClick={() => void applyPreset(preset.id, false)}
              >
                <strong>{preset.label}</strong>
                <span>{preset.description}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {pendingPreset ? (
        <div className="panel" role="alertdialog" aria-labelledby="preset-confirm-title">
          <h3 id="preset-confirm-title">Заменить текущие поля?</h3>
          <p>
            В форме уже есть поля. Применение шаблона заменит их. Продолжить?
          </p>
          <div className="lead-form-builder__confirm-actions">
            <button
              type="button"
              className="button button--outline"
              disabled={busy}
              onClick={() => setPendingPreset(null)}
            >
              Отмена
            </button>
            <button
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void applyPreset(pendingPreset, true)}
            >
              Заменить поля
            </button>
          </div>
        </div>
      ) : null}

      {!loaded ? (
        <p>Загрузка полей…</p>
      ) : !fields.length ? (
        <p>Полей пока нет. Выберите шаблон или добавьте поле.</p>
      ) : (
        <ul className="lead-form-fields-list">
          {fields.map((field, index) => {
            const isName = field.fieldKey === "name";
            const isEditing = editingId === field.id;
            return (
              <li key={field.id}>
                {isEditing ? (
                  <div className="lead-form-builder__edit">
                    <label className="field">
                      <span className="field__label">Название</span>
                      <input
                        className="field__control"
                        maxLength={120}
                        value={editLabel}
                        disabled={busy}
                        onChange={(e) => setEditLabel(e.target.value)}
                      />
                    </label>
                    {!isName ? (
                      <label className="field">
                        <span className="field__label">Тип</span>
                        <select
                          className="field__control"
                          value={editType}
                          disabled={busy}
                          onChange={(e) => setEditType(e.target.value)}
                        >
                          {FIELD_TYPES.map((item) => (
                            <option key={item.value} value={item.value}>
                              {item.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}
                    <label className="field">
                      <span className="field__label">Подсказка</span>
                      <input
                        className="field__control"
                        maxLength={200}
                        value={editPlaceholder}
                        disabled={busy}
                        onChange={(e) => setEditPlaceholder(e.target.value)}
                      />
                    </label>
                    {(editType === "select" || editType === "multiselect") && (
                      <label className="field">
                        <span className="field__label">
                          Варианты (каждый с новой строки)
                        </span>
                        <textarea
                          className="field__control"
                          rows={4}
                          value={editOptions}
                          disabled={busy}
                          onChange={(e) => setEditOptions(e.target.value)}
                        />
                      </label>
                    )}
                    {!isName ? (
                      <label className="lead-form-fields-required">
                        <input
                          type="checkbox"
                          checked={editRequired}
                          disabled={busy}
                          onChange={(e) => setEditRequired(e.target.checked)}
                        />
                        Обязательное
                      </label>
                    ) : (
                      <p className="field-hint">Поле «Имя» всегда обязательно.</p>
                    )}
                    <div className="lead-form-builder__row-actions">
                      <button
                        type="button"
                        className="button button--outline"
                        disabled={busy}
                        onClick={() => setEditingId(null)}
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={busy}
                        onClick={() => void saveEdit()}
                      >
                        Сохранить
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <span>
                      <strong>{field.label}</strong>
                      <small>
                        {typeLabel(field.fieldType)}
                        {field.required ? " · обязательно" : ""}
                        {isName ? " · системное" : ""}
                      </small>
                    </span>
                    {canEdit ? (
                      <div className="lead-form-builder__row-actions">
                        <button
                          type="button"
                          className="button button--outline"
                          disabled={busy || index === 0}
                          aria-label={`Переместить «${field.label}» вверх`}
                          onClick={() => move(index, -1)}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="button button--outline"
                          disabled={busy || index === fields.length - 1}
                          aria-label={`Переместить «${field.label}» вниз`}
                          onClick={() => move(index, 1)}
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          className="button button--outline"
                          disabled={busy}
                          onClick={() => startEdit(field)}
                        >
                          Изменить
                        </button>
                        {!isName ? (
                          <>
                            <button
                              type="button"
                              className="button button--outline"
                              disabled={busy}
                              onClick={() => void duplicate(field)}
                            >
                              Копия
                            </button>
                            <button
                              type="button"
                              className="button button--outline"
                              disabled={busy}
                              onClick={() => void remove(field)}
                            >
                              Удалить
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canEdit ? (
        <div className="lead-form-fields-add">
          <label className="field">
            <span className="field__label">Новое поле</span>
            <input
              className="field__control"
              maxLength={120}
              value={newLabel}
              disabled={busy}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="Например, Бюджет"
            />
          </label>
          <label className="field">
            <span className="field__label">Тип</span>
            <select
              className="field__control"
              value={newType}
              disabled={busy}
              onChange={(e) => setNewType(e.target.value)}
            >
              {FIELD_TYPES.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="lead-form-fields-required">
            <input
              type="checkbox"
              checked={newRequired}
              disabled={busy}
              onChange={(e) => setNewRequired(e.target.checked)}
            />
            Обязательное
          </label>
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => void addField()}
          >
            Добавить поле
          </button>
        </div>
      ) : null}
    </div>
  );
}
