"use client";

import { useEffect, useState } from "react";
import type { ClientAssignee as Assignee } from "@/components/clients-v2/types";
import {
  clientAction,
  getClientAssignees,
} from "@/services/clients.service";

export function ClientAssignee({
  businessId,
  clientId,
  assignedUser,
  canAssignOthers,
  onChanged,
}: {
  businessId: string;
  clientId: string;
  assignedUser: Assignee;
  canAssignOthers: boolean;
  onChanged: () => void;
}) {
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [value, setValue] = useState(assignedUser?.id ?? "");
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

  async function assign(next: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await clientAction(businessId, clientId, {
        action: "assign",
        assignedUserId: next || null,
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось назначить.");
      setValue(assignedUser?.id ?? "");
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    if (busy || assignedUser) return;
    setBusy(true);
    setError("");
    try {
      await clientAction(businessId, clientId, { action: "claim" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось взять клиента.");
    } finally {
      setBusy(false);
    }
  }

  if (!canAssignOthers) {
    if (assignedUser) {
      return <p>{assignedUser.name}</p>;
    }
    return (
      <div>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={() => void claim()}
        >
          {busy ? "…" : "Взять клиента"}
        </button>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <label className="field">
        <span className="sr-only">Ответственный</span>
        <select
          className="field__control"
          value={value}
          disabled={busy}
          onChange={(e) => {
            setValue(e.target.value);
            void assign(e.target.value);
          }}
        >
          <option value="">Не назначен</option>
          {assignees.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
