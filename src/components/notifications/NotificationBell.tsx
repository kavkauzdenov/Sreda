"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  CalendarDays,
  CircleUserRound,
  MessageCircle,
  Package,
  Settings,
  TriangleAlert,
} from "lucide-react";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { apiRequest } from "@/lib/apiClient";

type BusinessNotification = {
  id: string;
  type: string;
  title: string;
  target_path: string;
  created_at: string;
  read_at: string | null;
  resolved_at?: string | null;
};

type AccountNotification = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  target_path: string;
  created_at: string;
  read_at: string | null;
  resolved_at?: string | null;
};

type PopoverNotification = {
  id: string;
  source: "business" | "account";
  type: string;
  title: string;
  body?: string | null;
  targetPath: string;
  createdAt: string;
  unread: boolean;
};

const MAX_VISIBLE = 6;

function iconFor(type: string) {
  if (type.startsWith("lead.")) return CircleUserRound;
  if (type.startsWith("message.")) return MessageCircle;
  if (type.startsWith("booking.") || type.startsWith("calendar."))
    return CalendarDays;
  if (type.startsWith("order.") || type.startsWith("inventory."))
    return Package;
  if (type.startsWith("post.") || type.startsWith("setup."))
    return TriangleAlert;
  return Settings;
}

function relativeTime(value: string) {
  const date = new Date(value);
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("ru", { numeric: "auto" });
  const abs = Math.abs(deltaSeconds);

  if (abs < 60) return "только что";
  if (abs < 3600) return formatter.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86400) return formatter.format(Math.round(deltaSeconds / 3600), "hour");
  if (abs < 604800) return formatter.format(Math.round(deltaSeconds / 86400), "day");

  return date.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
  });
}

export function NotificationBell() {
  const { currentBusiness } = useBusinessContext();
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [businessItems, setBusinessItems] = useState<BusinessNotification[]>([]);
  const [accountItems, setAccountItems] = useState<AccountNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const businessId = currentBusiness?.id;
    try {
      const [inbox, business] = await Promise.all([
        apiRequest<AccountNotification[]>("/api/v1/inbox"),
        businessId
          ? apiRequest<BusinessNotification[]>(
              `/api/v1/businesses/${encodeURIComponent(businessId)}/notifications`,
            )
          : Promise.resolve([] as BusinessNotification[]),
      ]);
      setAccountItems(inbox);
      setBusinessItems(business);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить уведомления.");
    } finally {
      setLoaded(true);
    }
  }, [currentBusiness?.id]);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 10000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node))
        setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const items = useMemo<PopoverNotification[]>(() => {
    const business: PopoverNotification[] = businessItems
      .filter((item) => !item.resolved_at)
      .map((item) => ({
        id: item.id,
        source: "business",
        type: item.type,
        title: item.title,
        targetPath: item.target_path,
        createdAt: item.created_at,
        unread: !item.read_at,
      }));
    const account: PopoverNotification[] = accountItems
      .filter((item) => !item.resolved_at)
      .map((item) => ({
        id: item.id,
        source: "account",
        type: item.type,
        title: item.title,
        body: item.body,
        targetPath: item.target_path,
        createdAt: item.created_at,
        unread: !item.read_at,
      }));

    return [...business, ...account]
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
      .slice(0, MAX_VISIBLE);
  }, [accountItems, businessItems]);

  const count =
    businessItems.filter((item) => !item.read_at && !item.resolved_at).length +
    accountItems.filter((item) => !item.read_at && !item.resolved_at).length;

  async function markAllRead() {
    if (busy || count === 0) return;
    setBusy(true);
    setError("");
    try {
      const tasks: Promise<unknown>[] = [
        apiRequest("/api/v1/inbox", {
          method: "PATCH",
          body: JSON.stringify({ all: true }),
        }),
      ];
      if (currentBusiness?.id) {
        tasks.push(
          apiRequest(
            `/api/v1/businesses/${encodeURIComponent(currentBusiness.id)}/notifications`,
            {
              method: "PATCH",
              body: JSON.stringify({ all: true }),
            },
          ),
        );
      }
      await Promise.all(tasks);
      const now = new Date().toISOString();
      setAccountItems((all) =>
        all.map((item) => (item.read_at ? item : { ...item, read_at: now })),
      );
      setBusinessItems((all) =>
        all.map((item) => (item.read_at ? item : { ...item, read_at: now })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отметить уведомления.");
    } finally {
      setBusy(false);
    }
  }

  async function openItem(item: PopoverNotification) {
    setOpen(false);
    if (item.unread) {
      try {
        if (item.source === "business" && currentBusiness?.id) {
          await apiRequest(
            `/api/v1/businesses/${encodeURIComponent(currentBusiness.id)}/notifications`,
            {
              method: "PATCH",
              body: JSON.stringify({ id: item.id }),
            },
          );
        } else if (item.source === "account") {
          await apiRequest("/api/v1/inbox", {
            method: "PATCH",
            body: JSON.stringify({ id: item.id, read: true }),
          });
        }
      } catch {
        // Navigation is more important than read-state bookkeeping.
      }
    }
    router.push(item.targetPath);
  }

  return (
    <div className="notification-center" ref={rootRef}>
      <button
        type="button"
        className="notification-bell"
        aria-label={`Уведомления${count ? ": " + count + " непрочитанных" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void refresh();
        }}
      >
        <Bell size={20} strokeWidth={1.8} />
        {!!count && (
          <span className="notification-bell__badge">
            {count >= 100 ? "99+" : count}
          </span>
        )}
      </button>

      {open ? (
        <section
          className="notification-popover"
          role="dialog"
          aria-label="Последние уведомления"
        >
          <header className="notification-popover__header">
            <div>
              <strong>Уведомления</strong>
              {count > 0 ? (
                <span className="notification-popover__count">{count}</span>
              ) : null}
            </div>
            {count > 0 ? (
              <button
                type="button"
                className="notification-popover__read-all"
                disabled={busy}
                onClick={() => void markAllRead()}
              >
                Отметить все прочитанными
              </button>
            ) : null}
          </header>

          {error ? (
            <p className="notification-popover__error" role="alert">
              {error}
            </p>
          ) : null}

          <div className="notification-popover__body">
            {!loaded ? (
              <p className="notification-popover__empty">Загрузка…</p>
            ) : items.length === 0 ? (
              <div className="notification-popover__empty">
                <Bell size={22} aria-hidden />
                <strong>Новых уведомлений нет</strong>
                <span>Здесь появятся заявки, сообщения и другие события.</span>
              </div>
            ) : (
              <ul className="notification-popover__list">
                {items.map((item) => {
                  const Icon = iconFor(item.type);
                  return (
                    <li key={`${item.source}:${item.id}`}>
                      <button
                        type="button"
                        className={`notification-popover__item${item.unread ? " is-unread" : ""}`}
                        onClick={() => void openItem(item)}
                      >
                        <span
                          className={`notification-popover__icon notification-popover__icon--${item.type.split(".")[0]}`}
                          aria-hidden
                        >
                          <Icon size={19} strokeWidth={1.8} />
                        </span>
                        <span className="notification-popover__copy">
                          <strong>{item.title}</strong>
                          {item.body ? <small>{item.body}</small> : null}
                        </span>
                        <span className="notification-popover__meta">
                          <time dateTime={item.createdAt}>
                            {relativeTime(item.createdAt)}
                          </time>
                          {item.unread ? (
                            <span
                              className="notification-popover__dot"
                              aria-label="Непрочитано"
                            />
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <footer className="notification-popover__footer">
            <Link href="/notifications" onClick={() => setOpen(false)}>
              Показать все уведомления
              <span aria-hidden>→</span>
            </Link>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
