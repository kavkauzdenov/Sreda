"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getClientTabPage } from "@/services/clients.service";
import type { ClientDetailTab, ClientTab } from "@/components/clients-v2/types";
import { formatRelativeDateTimeInZone } from "@/lib/format";

export function useClientTabPage(
  businessId: string,
  clientId: string,
  tab: Exclude<ClientDetailTab, "overview" | "timeline">,
) {
  const [items, setItems] = useState<ClientTab[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setItems(null);
    setError("");
    void getClientTabPage(businessId, clientId, tab)
      .then((page) => {
        if (!active) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setHasMore(page.hasMore);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Не удалось загрузить.");
        setItems([]);
      });
    return () => {
      active = false;
    };
  }, [businessId, clientId, tab, attempt]);

  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const page = await getClientTabPage(businessId, clientId, tab, cursor);
      setItems((old) => [...(old ?? []), ...page.items]);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить.");
    } finally {
      setBusy(false);
    }
  }

  return {
    items,
    error,
    hasMore,
    busy,
    more,
    reload: () => setAttempt((v) => v + 1),
  };
}

export function ClientTabShell({
  empty,
  error,
  items,
  hasMore,
  busy,
  onMore,
  children,
}: {
  empty: string;
  error: string;
  items: ClientTab[] | null;
  hasMore: boolean;
  busy: boolean;
  onMore: () => void;
  children: (items: ClientTab[]) => React.ReactNode;
}) {
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
        <p className="account-footnote">Загружаем…</p>
      </div>
    );
  }
  return (
    <div className="client-tab-panel">
      {items.length ? (
        children(items)
      ) : (
        <div className="empty-state empty-state--compact">
          <p>{empty}</p>
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={onMore}
        >
          {busy ? "Загружаем…" : "Показать ещё"}
        </button>
      ) : null}
    </div>
  );
}

export function ClientEntityLink({
  href,
  children,
}: {
  href?: string | null;
  children: React.ReactNode;
}) {
  if (href) return <Link href={href}>{children}</Link>;
  return <>{children}</>;
}

export function formatTabWhen(iso: string | undefined, timezone: string) {
  return iso ? formatRelativeDateTimeInZone(iso, timezone) : "";
}
