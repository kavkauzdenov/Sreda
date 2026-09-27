"use client";

import { useEffect, useState } from "react";
import { createClient, getClientAssignees } from "@/services/clients.service";

export function NewClientDialog({
  businessId,
  canAssignOthers,
  currentUserId,
  onClose,
  onCreated,
}: {
  businessId: string;
  canAssignOthers: boolean;
  currentUserId?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [assignedUserId, setAssignedUserId] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getClientAssignees(businessId)
      .then(setAssignees)
      .catch(() => undefined);
  }, [businessId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const result = await createClient(businessId, {
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        assignedUserId: canAssignOthers
          ? assignedUserId || null
          : currentUserId || null,
        tags: tagList.length ? tagList : undefined,
        note: note.trim() || undefined,
      });
      onCreated((result as { id: string }).id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="client-dialog-overlay"
      role="presentation"
      onClick={onClose}
    >
      <form
        className="client-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Новый клиент"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className="client-dialog__head">
          <h2>Новый клиент</h2>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Закрыть
          </button>
        </header>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        <label className="field">
          <span className="field__label">Имя *</span>
          <input
            className="field__control"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={100}
            autoFocus
          />
        </label>
        <label className="field">
          <span className="field__label">Телефон</span>
          <input
            className="field__control"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
          />
        </label>
        <label className="field">
          <span className="field__label">Email</span>
          <input
            className="field__control"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={254}
          />
        </label>
        {canAssignOthers ? (
          <label className="field">
            <span className="field__label">Ответственный</span>
            <select
              className="field__control"
              value={assignedUserId}
              onChange={(e) => setAssignedUserId(e.target.value)}
            >
              <option value="">Не назначен</option>
              {assignees.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field">
          <span className="field__label">Теги</span>
          <input
            className="field__control"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="VIP, Постоянный"
          />
        </label>
        <label className="field">
          <span className="field__label">Заметка</span>
          <textarea
            className="field__control"
            rows={3}
            maxLength={4000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <div className="client-dialog__actions">
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Создаём…" : "Создать"}
          </button>
          <button type="button" className="button button--outline" onClick={onClose}>
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
