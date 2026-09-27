"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ClientDetail } from "@/components/clients-v2/types";
import { createLeadForClient } from "@/services/clients.service";
import { platformLabel } from "@/lib/labels";
import type { Platform } from "@/types";

export function ClientQuickActions({
  businessId,
  detail,
  onRefresh,
  onEdit,
  onOpenDuplicates,
}: {
  businessId: string;
  detail: ClientDetail;
  onRefresh: () => void;
  onEdit: () => void;
  onOpenDuplicates?: () => void;
}) {
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [chooser, setChooser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const channels = detail.writeChannels;

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  function write() {
    setError("");
    if (channels.length === 0) return;
    if (channels.length === 1) {
      router.push(`/messages?conversation=${channels[0]!.conversationId}`);
      return;
    }
    setChooser(true);
  }

  async function createLead() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await createLeadForClient(businessId, {
        name: detail.client.name,
        phone: detail.client.phone,
        clientId: detail.client.id,
      });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать заявку.");
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  }

  const writeDisabled = channels.length === 0;
  const writeTitle = writeDisabled
    ? "Нет канала для сообщения"
    : channels.length === 1
      ? `Написать в ${platformLabel(channels[0]!.platform as Platform)}`
      : "Выбрать канал";

  return (
    <div className="client-quick-actions">
      <button
        type="button"
        className="button button--primary"
        disabled={writeDisabled || busy}
        title={writeTitle}
        aria-disabled={writeDisabled}
        onClick={write}
      >
        Написать
      </button>
      <button
        type="button"
        className="button button--outline"
        disabled={busy}
        onClick={() => void createLead()}
      >
        Создать заявку
      </button>
      <button
        type="button"
        className="button button--outline"
        onClick={() =>
          router.push(`/orders?client=${encodeURIComponent(detail.client.id)}`)
        }
      >
        Создать заказ
      </button>
      <button
        type="button"
        className="button button--outline"
        onClick={() =>
          router.push(
            `/bookings?client=${encodeURIComponent(detail.client.id)}`,
          )
        }
      >
        Записать
      </button>
      <div className="client-quick-actions__menu" ref={menuRef}>
        <button
          type="button"
          className="button button--outline"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          …
        </button>
        {menuOpen ? (
          <div className="client-quick-actions__dropdown" role="menu">
            <button type="button" role="menuitem" onClick={onEdit}>
              Редактировать
            </button>
            {onOpenDuplicates && detail.duplicateSummary.count > 0 ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenDuplicates();
                }}
              >
                Возможные дубликаты
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {chooser ? (
        <div className="client-channel-chooser" role="group" aria-label="Канал">
          <p className="account-footnote">Выберите канал для сообщения:</p>
          {channels.map((ch) => (
            <button
              key={ch.conversationId}
              type="button"
              className="button button--outline"
              onClick={() =>
                router.push(`/messages?conversation=${ch.conversationId}`)
              }
            >
              {platformLabel(ch.platform as Platform)}
              {ch.username ? ` · @${ch.username}` : ""}
            </button>
          ))}
          <button
            type="button"
            className="button button--outline"
            onClick={() => setChooser(false)}
          >
            Отмена
          </button>
        </div>
      ) : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
