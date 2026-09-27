"use client";
import {
  AttachmentPicker,
  type FileItem,
} from "@/components/attachments/AttachmentPicker";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { apiRequest } from "@/lib/apiClient";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import {
  EmptyStateCta,
  SolutionSetupBanner,
} from "@/components/solutions/SolutionSetupBanner";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { Pagination } from "@/components/ui/Pagination";
import type { Platform } from "@/types";

function platformChip(platform: string) {
  switch (platform) {
    case "telegram":
      return "TG";
    case "vk":
      return "VK";
    case "whatsapp":
      return "WA";
    case "instagram":
      return "IG";
    default:
      return platform.slice(0, 2).toUpperCase();
  }
}

function waitingLabel(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Ждёт ответа меньше минуты";
  if (mins < 60) return `Ждёт ответа ${mins} мин`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `Ждёт ответа ${hours} ч`;
  return `Ждёт ответа ${Math.floor(hours / 24)} д`;
}
type Conversation = {
  id: string;
  platform: string;
  clientId?: string | null;
  clientName?: string;
  externalUserId: string;
  externalUsername: string | null;
  status: string;
  lastMessageAt: string;
  lastMessage: string;
  unread: number;
  assignedName?: string;
  waitingSince?: string | null;
};
type Message = {
  attachments?: FileItem[];
  id: string;
  direction: string;
  text: string;
  createdAt: string;
  deliveryStatus: string;
};
export function MessagesView() {
  const { currentBusiness } = useBusinessContext();
  return currentBusiness ? (
    <Inbox
      key={currentBusiness.id}
      businessId={currentBusiness.id}
      timezone={currentBusiness.timezone ?? "UTC"}
    />
  ) : (
    <p>Выберите бизнес.</p>
  );
}
function Inbox({
  businessId,
  timezone,
}: {
  businessId: string;
  timezone: string;
}) {
  const [files, setFiles] = useState<FileItem[]>([]),
    [uploading, setUploading] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]),
    [selected, setSelected] = useState(() => {
      if (typeof window === "undefined") return "";
      return new URLSearchParams(window.location.search).get("conversation") || "";
    }),
    [messages, setMessages] = useState<Message[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [filter, setFilter] = useState(""),
    [platformFilter, setPlatformFilter] = useState(""),
    [page, setPage] = useState(0),
    [messagePage, setMessagePage] = useState(0);
  const requestKey = useRef("");
  const search = useSearchParams();
  void search;
  const base = `/api/v1/businesses/${businessId}/conversations`;
  const current = conversations.find((c) => c.id === selected);
  const listQuery =
    base +
    "?status=" +
    filter +
    "&page=" +
    page +
    (platformFilter ? "&platform=" + platformFilter : "");
  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const list = await apiRequest<Conversation[]>(listQuery);
        if (active) {
          setConversations(list);
          setLoaded(true);
          setError("");
        }
      } catch (e) {
        if (active) {
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить диалоги.",
          );
          setLoaded(true);
        }
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [listQuery]);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    async function refresh() {
      try {
        const list = await apiRequest<Message[]>(
          base + "/" + selected + "?page=" + messagePage,
        );
        if (active) setMessages(list);
      } catch (e) {
        if (active)
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить сообщения.",
          );
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [base, selected, messagePage]);
  async function status(value: string) {
    setBusy(true);
    setError("");
    try {
      await apiRequest(base + "/" + selected, {
        method: "PATCH",
        body: JSON.stringify({ status: value }),
      });
      setConversations(await apiRequest<Conversation[]>(listQuery));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить статус.");
    } finally {
      setBusy(false);
    }
  }
  async function send() {
    if ((!text.trim() && !files.length) || busy || uploading) return;
    setBusy(true);
    setError("");
    requestKey.current ||= crypto.randomUUID();
    try {
      await apiRequest(base + "/" + selected, {
        method: "POST",
        body: JSON.stringify({
          text,
          attachments: files.map((f) => f.id),
          requestKey: requestKey.current,
        }),
      });
      setText("");
      setFiles([]);
      requestKey.current = "";
      setMessagePage(0);
      setMessages(await apiRequest<Message[]>(base + "/" + selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось отправить.");
    } finally {
      setBusy(false);
    }
  }
  async function sendInternalNote() {
    if (!text.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(base + "/" + selected, {
        method: "POST",
        body: JSON.stringify({ text, internal: true }),
      });
      setText("");
      requestKey.current = "";
      setMessagePage(0);
      setMessages(await apiRequest<Message[]>(base + "/" + selected));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить заметку.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="messages-page page-container">
      <header className="page-header">
        <h1 className="text-page-title">Сообщения</h1>
        <p className="text-body-sm">Бесплатный inbox · до 300 сообщений в месяц на бизнес.</p>
      </header>
      <SolutionSetupBanner code="admin_messages" />
      {error && (
        <p role="alert" className="account-error account-toast">
          {error}
        </p>
      )}
      <div className="crm-columns messages-split">
        <section className="panel crm-panel messages-list">
          <Pagination
            page={page}
            hasNext={conversations.length >= 100}
            onPage={setPage}
          />
          <nav aria-label="Площадка" className="message-actions">
            {(
              [
                ["", "Все"],
                ["telegram", "TG"],
                ["vk", "VK"],
                ["whatsapp", "WA"],
                ["instagram", "IG"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value || "all"}
                type="button"
                className={
                  "button button--sm " +
                  (platformFilter === value
                    ? "button--primary"
                    : "button--outline")
                }
                aria-pressed={platformFilter === value}
                disabled={busy}
                onClick={() => {
                  setPlatformFilter(value);
                  setPage(0);
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <label className="field">
            <span className="field__label">Статус</span>
            <select
              className="field__control"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(0);
              }}
            >
              {[
                ["", "Все"],
                ["open", "Новые"],
                ["assigned", "В работе"],
                ["closed", "Закрытые"],
                ["blocked", "Заблокированные"],
              ].map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {!loaded ? (
            <p>Загрузка…</p>
          ) : !conversations.length ? (
            <EmptyStateCta
              title="Сообщений пока нет"
              description="Подключите Telegram, VK, WhatsApp или Instagram — диалоги клиентов появятся здесь."
              href="/connections"
              action="Открыть подключения"
            />
          ) : (
            <ul className="crm-list">
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    disabled={busy || uploading}
                    aria-pressed={selected === c.id}
                    onClick={() => {
                      setSelected(c.id);
                      setMessagePage(0);
                      setMessages([]);
                      setText("");
                      setFiles([]);
                      requestKey.current = "";
                    }}
                  >
                    <strong>
                      {c.clientName || c.externalUsername || c.externalUserId} ·{" "}
                      <span className="platform-chip">
                        {platformChip(c.platform)}
                      </span>
                    </strong>
                    <span className="sr-only">
                      <PlatformBadge platform={c.platform as Platform} compact />
                    </span>
                    <span>{c.lastMessage.slice(0, 100)}</span>
                    <small>
                      {new Date(c.lastMessageAt).toLocaleString("ru", {
                        timeZone: timezone,
                      })}
                      {c.unread > 0 ? " · Новых: " + c.unread : ""}
                      {waitingLabel(c.waitingSince)
                        ? " · " + waitingLabel(c.waitingSince)
                        : ""}
                    </small>
                    {c.assignedName && (
                      <small>В работе · {c.assignedName}</small>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel crm-panel messages-thread">
          {!selected ? (
            <p className="text-body-sm">Выберите диалог.</p>
          ) : (
            <>
              <h2 className="text-section-title">
                {current?.clientName ||
                  current?.externalUsername ||
                  current?.externalUserId ||
                  "Диалог"}
              </h2>
              {current?.clientId ? (
                <p>
                  <Link href="/clients">Карточка клиента</Link>
                </p>
              ) : null}
              <div className="message-actions">
                <button
                  className="button button--primary button--sm"
                  disabled={busy}
                  onClick={() => void status("assigned")}
                >
                  Взять в работу
                </button>
                <button
                  className="button button--outline button--sm"
                  disabled={busy}
                  onClick={() => void status("closed")}
                >
                  Закрыть диалог
                </button>
              </div>
              <nav aria-label="История переписки">
                <button
                  disabled={messages.length < 500}
                  onClick={() => setMessagePage(messagePage + 1)}
                >
                  Раньше
                </button>
                <span> {messagePage + 1} </span>
                <button
                  disabled={!messagePage}
                  onClick={() => setMessagePage(messagePage - 1)}
                >
                  Позже
                </button>
              </nav>
              <div className="message-history" aria-live="polite">
                {messages.map((m) => (
                  <article
                    className={"message-bubble message-bubble--" + m.direction}
                    key={m.id}
                  >
                    <p>{m.text}</p>
                    {m.attachments?.map((f) => (
                      <p key={f.id}>
                        <a
                          href={`/api/v1/businesses/${businessId}/attachments/${f.id}`}
                        >
                          {f.filename}
                        </a>
                      </p>
                    ))}
                    <small>
                      {new Date(m.createdAt).toLocaleString("ru", {
                        timeZone: timezone,
                      })}{" "}
                      {m.direction === "internal"
                        ? "Внутренняя заметка"
                        : m.direction === "outbound" &&
                          (
                            {
                              queued: "В очереди",
                              sent: "Отправлено",
                              failed: "Ошибка отправки",
                              uncertain: "Доставка не подтверждена",
                            } as Record<string, string>
                          )[m.deliveryStatus]}
                    </small>
                  </article>
                ))}
              </div>
              <form
                className="message-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label className="field field-full">
                  <span className="field__label">Ответ клиенту</span>
                  <textarea
                    className="field__control message-composer__input"
                    required={!files.length}
                    maxLength={4000}
                    value={text}
                    disabled={busy}
                    onChange={(e) => {
                      setText(e.target.value);
                      requestKey.current = "";
                    }}
                  />
                </label>
                <div className="message-composer__actions">
                  <AttachmentPicker
                    businessId={businessId}
                    files={files}
                    onChange={(v) => {
                      setFiles(v);
                      requestKey.current = "";
                    }}
                    disabled={busy}
                    onBusy={setUploading}
                  />
                  <button
                    className="button button--primary"
                    disabled={
                      busy || uploading || (!text.trim() && !files.length)
                    }
                  >
                    Отправить
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    disabled={busy || !text.trim()}
                    onClick={() => void sendInternalNote()}
                  >
                    Внутренняя заметка
                  </button>
                </div>
              </form>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
