"use client";

import { useEffect, useState } from "react";
import {
  clientAction,
  createClientTag,
  getClientTags,
} from "@/services/clients.service";
import type { ClientTag } from "@/components/clients-v2/types";

export function ClientTags({
  businessId,
  clientId,
  tags,
  onChanged,
}: {
  businessId: string;
  clientId: string;
  tags: ClientTag[];
  onChanged: () => void;
}) {
  const [catalog, setCatalog] = useState<ClientTag[]>([]);
  const [pick, setPick] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void getClientTags(businessId)
      .then((rows) => {
        if (active) setCatalog(rows);
      })
      .catch(() => {
        if (active) setCatalog([]);
      });
    return () => {
      active = false;
    };
  }, [businessId, tags]);

  async function attach(tagId: string) {
    if (!tagId || busy) return;
    setBusy(true);
    setError("");
    try {
      await clientAction(businessId, clientId, {
        action: "attach_tag",
        tagId,
      });
      setPick("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось добавить тег.");
    } finally {
      setBusy(false);
    }
  }

  async function detach(tagId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await clientAction(businessId, clientId, {
        action: "detach_tag",
        tagId,
      });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось снять тег.");
    } finally {
      setBusy(false);
    }
  }

  async function createAndAttach() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    setError("");
    try {
      const tag = await createClientTag(businessId, name);
      await clientAction(businessId, clientId, {
        action: "attach_tag",
        tagId: tag.id,
      });
      setNewName("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать тег.");
    } finally {
      setBusy(false);
    }
  }

  const attached = new Set(tags.map((t) => t.id));
  const available = catalog.filter((t) => !attached.has(t.id));

  return (
    <div className="client-tags">
      {tags.length ? (
        tags.map((tag) => (
          <span key={tag.id} className="client-tag">
            {tag.name}
            <button
              type="button"
              aria-label={`Убрать тег ${tag.name}`}
              disabled={busy}
              onClick={() => void detach(tag.id)}
            >
              ×
            </button>
          </span>
        ))
      ) : (
        <span className="account-footnote">Тегов пока нет</span>
      )}
      {available.length ? (
        <label className="field" style={{ minWidth: 140 }}>
          <span className="sr-only">Добавить тег</span>
          <select
            className="field__control"
            value={pick}
            disabled={busy}
            onChange={(e) => {
              setPick(e.target.value);
              void attach(e.target.value);
            }}
          >
            <option value="">Добавить тег</option>
            {available.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="field" style={{ minWidth: 160 }}>
        <span className="sr-only">Новый тег</span>
        <input
          className="field__control"
          value={newName}
          disabled={busy}
          placeholder="Новый тег"
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void createAndAttach();
            }
          }}
        />
      </label>
      <button
        type="button"
        className="button button--outline"
        disabled={busy || !newName.trim()}
        onClick={() => void createAndAttach()}
      >
        Создать
      </button>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
