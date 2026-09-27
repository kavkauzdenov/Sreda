"use client";

import { useEffect, useState } from "react";
import { DetailDialog } from "@/components/dashboard/DetailDialog";
import type { ClientDetail } from "@/components/clients-v2/types";
import {
  getClientAssignees,
  updateClient,
} from "@/services/clients.service";

export function ClientEditorDialog({
  businessId,
  detail,
  canAssignOthers,
  onClose,
  onSaved,
}: {
  businessId: string;
  detail: ClientDetail;
  canAssignOthers: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(detail.client.name);
  const [phone, setPhone] = useState(detail.client.phone ?? "");
  const [email, setEmail] = useState(detail.client.email ?? "");
  const [assignedUserId, setAssignedUserId] = useState(
    detail.assignedUser?.id ?? "",
  );
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canAssignOthers) return;
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
  }, [businessId, canAssignOthers]);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await updateClient(businessId, detail.client.id, {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        ...(canAssignOthers
          ? { assignedUserId: assignedUserId || null }
          : {}),
      });
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DetailDialog title="Редактировать клиента" onClose={onClose}>
      <label className="field">
        <span className="field__label">Имя *</span>
        <input
          className="field__control"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Телефон</span>
        <input
          className="field__control"
          value={phone}
          disabled={busy}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field__label">Email</span>
        <input
          className="field__control"
          type="email"
          value={email}
          disabled={busy}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {canAssignOthers ? (
        <label className="field">
          <span className="field__label">Ответственный</span>
          <select
            className="field__control"
            value={assignedUserId}
            disabled={busy}
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
      <div className="client-quick-actions" style={{ marginTop: 16 }}>
        <button
          type="button"
          className="button button--primary"
          disabled={busy || !name.trim()}
          onClick={() => void save()}
        >
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={onClose}
        >
          Отмена
        </button>
      </div>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </DetailDialog>
  );
}
