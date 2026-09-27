"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import { apiRequest } from "@/lib/apiClient";
import { clientAction, mergeClients } from "@/services/clients.service";
import { formatRelativeDateTimeInZone } from "@/lib/format";
import type { ClientDetail } from "@/components/clients-v2/types";

type Side = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  identities: { kind: string; username: string | null }[];
  leadCount: number;
  orderCount: number;
  bookingCount: number;
};

function DuplicateSideCard({
  side,
  label,
  timezone,
}: {
  side: Side;
  label: string;
  timezone: string;
}) {
  return (
    <div className="client-duplicate-dialog__side">
      <h3>{label}</h3>
      <p>
        <strong>{side.name}</strong>
      </p>
      <p>Телефон: {side.phone || "—"}</p>
      <p>Email: {side.email || "—"}</p>
      <p>
        Каналы:{" "}
        {side.identities.length
          ? side.identities.map((i) => i.username || i.kind).join(", ")
          : "—"}
      </p>
      <p>
        Первый контакт: {formatRelativeDateTimeInZone(side.firstSeenAt, timezone)}
      </p>
      <p>
        Последний контакт:{" "}
        {formatRelativeDateTimeInZone(side.lastSeenAt, timezone)}
      </p>
      <p>
        Заявки {side.leadCount} · Заказы {side.orderCount} · Записи{" "}
        {side.bookingCount}
      </p>
    </div>
  );
}

export function ClientDuplicateDialog({
  businessId,
  detail,
  timezone,
  canMerge,
  onClose,
  onMerged,
  onDecided,
}: {
  businessId: string;
  detail: ClientDetail;
  timezone: string;
  canMerge: boolean;
  onClose: () => void;
  onMerged: (targetId: string) => void;
  onDecided?: () => void;
}) {
  const candidates = detail.duplicateSummary.candidates;
  const [index, setIndex] = useState(0);
  const otherId = candidates[index]?.id ?? "";
  const [left, setLeft] = useState<Side | null>(null);
  const [right, setRight] = useState<Side | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    if (!otherId) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setLeft(null);
      setRight(null);
    });
    const url = `/api/v1/businesses/${encodeURIComponent(businessId)}/clients/${encodeURIComponent(detail.client.id)}?view=compare&other=${encodeURIComponent(otherId)}`;
    void apiRequest<{ clientA: Side; clientB: Side }>(url)
      .then((data) => {
        if (!alive) return;
        setLeft(data.clientA);
        setRight(data.clientB);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : "Не удалось сравнить.");
      });
    return () => {
      alive = false;
    };
  }, [businessId, detail.client.id, otherId]);

  async function markSeparate() {
    if (!otherId) return;
    setBusy(true);
    try {
      await clientAction(businessId, detail.client.id, {
        action: "duplicate_decision",
        clientAId: detail.client.id,
        clientBId: otherId,
        decision: "separate",
      });
      onDecided?.();
      if (index + 1 < candidates.length) setIndex((v) => v + 1);
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
    } finally {
      setBusy(false);
    }
  }

  async function doMerge(source: string, target: string) {
    if (!canMerge) return;
    setBusy(true);
    try {
      await mergeClients(businessId, source, target);
      onMerged(target);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось объединить.");
    } finally {
      setBusy(false);
    }
  }

  if (!candidates.length) {
    return (
      <div className="client-dialog-overlay" role="presentation" onClick={onClose}>
        <div
          ref={dialogRef}
          className="client-dialog"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.stopPropagation()}
        >
          <p>Дубликатов не найдено.</p>
          <button type="button" className="button button--outline" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="client-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="client-dialog client-duplicate-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Проверка дубликатов"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="client-dialog__head">
          <h2>Возможный дубликат</h2>
          <button type="button" className="button button--ghost" onClick={onClose}>
            Закрыть
          </button>
        </header>
        {candidates.length > 1 ? (
          <p className="account-footnote">
            Кандидат {index + 1} из {candidates.length}
          </p>
        ) : null}
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        {left && right ? (
          <>
            <div className="client-duplicate-dialog__grid">
              <DuplicateSideCard
                side={left}
                label="Текущий клиент"
                timezone={timezone}
              />
              <DuplicateSideCard
                side={right}
                label="Возможный дубль"
                timezone={timezone}
              />
            </div>
            <div className="client-dialog__actions">
              {canMerge ? (
                <>
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy}
                    onClick={() => void doMerge(right.id, left.id)}
                  >
                    Объединить в текущего
                  </button>
                  <button
                    type="button"
                    className="button button--outline"
                    disabled={busy}
                    onClick={() => void doMerge(left.id, right.id)}
                  >
                    Объединить в дубль
                  </button>
                </>
              ) : (
                <p className="account-footnote">
                  Объединение доступно владельцу и администратору.
                </p>
              )}
              <button
                type="button"
                className="button button--outline"
                disabled={busy}
                onClick={() => void markSeparate()}
              >
                Это разные клиенты
              </button>
            </div>
          </>
        ) : (
          <p className="account-footnote">Загружаем сравнение…</p>
        )}
      </div>
    </div>
  );
}
