"use client";

import { useState } from "react";
import { addClientNote } from "@/services/clients.service";
import {
  ClientTabShell,
  formatTabWhen,
  useClientTabPage,
} from "@/components/clients-v2/clientTabUtils";

export function ClientNotes({
  businessId,
  clientId,
  timezone,
  onChanged,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
  onChanged?: () => void;
}) {
  const state = useClientTabPage(businessId, clientId, "notes");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  async function addNote() {
    const value = text.trim();
    if (!value || saving) return;
    setSaving(true);
    setSaveError("");
    try {
      await addClientNote(businessId, clientId, value);
      setText("");
      state.reload();
      onChanged?.();
    } catch (e) {
      setSaveError(
        e instanceof Error ? e.message : "Не удалось добавить заметку.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="client-tab-panel">
      <label className="field">
        <span className="field__label">Новая заметка</span>
        <textarea
          className="field__control"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="button button--primary"
        disabled={saving || !text.trim()}
        onClick={() => void addNote()}
      >
        {saving ? "Сохраняем…" : "Добавить"}
      </button>
      {saveError ? (
        <p className="account-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <ClientTabShell
        empty="Заметок пока нет."
        error={state.error}
        items={state.items}
        hasMore={state.hasMore}
        busy={state.busy}
        onMore={() => void state.more()}
      >
        {(items) => (
          <ul className="client-entity-list">
            {items.map((row) => (
              <li key={row.id}>
                <strong>{row.text}</strong>
                <small>
                  {row.author ? `${row.author} · ` : ""}
                  {formatTabWhen(row.createdAt, timezone)}
                </small>
              </li>
            ))}
          </ul>
        )}
      </ClientTabShell>
    </div>
  );
}
