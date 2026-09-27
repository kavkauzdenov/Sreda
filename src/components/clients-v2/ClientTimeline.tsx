"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getClientTimeline } from "@/services/clients.service";
import type { TimelineItem } from "@/components/clients-v2/types";
import { formatRelativeDateTimeInZone } from "@/lib/format";

export function ClientTimeline({
  businessId,
  clientId,
  timezone,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
}) {
  const [items, setItems] = useState<TimelineItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setItems(null);
      setError("");
    });
    void getClientTimeline(businessId, clientId)
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить историю.",
        );
        setItems([]);
      });
    return () => {
      active = false;
    };
  }, [businessId, clientId]);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await getClientTimeline(businessId, clientId, cursor);
      setItems((old) => [...(old ?? []), ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !items?.length) {
    return (
      <div className="client-tab-panel">
        <p className="account-error" role="alert">
          {error}
        </p>
      </div>
    );
  }

  if (!items) {
    return (
      <div className="client-tab-panel" aria-busy="true">
        <p className="account-footnote">Загружаем историю…</p>
      </div>
    );
  }

  return (
    <div className="client-tab-panel">
      {items.length ? (
        <ul className="client-timeline">
          {items.map((item) => (
            <li key={item.id}>
              <strong>
                {item.targetPath ? (
                  <Link href={item.targetPath}>{item.title}</Link>
                ) : (
                  item.title
                )}
              </strong>
              {item.description ? <span>{item.description}</span> : null}
              <small>
                {formatRelativeDateTimeInZone(item.createdAt, timezone)}
                {item.actor ? ` · ${item.actor}` : ""}
              </small>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-state empty-state--compact">
          <p>История пока пуста.</p>
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={() => void more()}
        >
          {busy ? "Загружаем…" : "Показать ещё"}
        </button>
      ) : null}
    </div>
  );
}
