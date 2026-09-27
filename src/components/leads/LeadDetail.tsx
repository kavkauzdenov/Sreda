"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X } from "lucide-react";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { LeadStatusBadge } from "@/components/leads/LeadStatusBadge";
import { apiRequest, ClientError } from "@/lib/apiClient";
import { formatRelativeDateTime } from "@/lib/format";
import { isDemoMode } from "@/lib/dataMode";
import {
  allowedLeadTransitions,
  leadStatusLabel,
  leadTransitionActionLabel,
  LEAD_STATUS_LABELS,
} from "@/lib/leadStatus";
import type { Lead, LeadStatus } from "@/types";

export type LeadDetailData = Lead & {
  waitLabel?: string | null;
  overdue?: boolean;
  answerFields?: { key: string; label: string; value: unknown }[];
  history?: {
    id: string;
    fromStatus: LeadStatus | null;
    toStatus: LeadStatus;
    note?: string | null;
    actorName?: string | null;
    createdAt: string;
  }[];
  possibleDuplicate?: { id: string; createdAt: string } | null;
};

function formatAnswerValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === "object" && item && "url" in item
          ? String((item as { name?: string; url?: string }).name || (item as { url: string }).url)
          : String(item),
      )
      .join(", ");
  }
  if (typeof value === "object" && value && "url" in value) {
    const file = value as { name?: string; url?: string };
    return file.name || file.url || "Файл";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

function isAttachment(
  value: unknown,
): value is { id?: string; url: string; name?: string; type?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "url" in value &&
    typeof (value as { url: unknown }).url === "string"
  );
}

export function LeadDetail({
  businessId,
  leadId,
  onClose,
  onUpdated,
  onOpenLead,
  variant = "panel",
}: {
  businessId: string;
  leadId: string;
  onClose: () => void;
  onUpdated?: (lead: Lead) => void;
  onOpenLead?: (id: string) => void;
  variant?: "panel" | "dialog";
}) {
  const [detail, setDetail] = useState<LeadDetailData | null>(null);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<LeadStatus>("new");
  const [loading, setLoading] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (variant !== "dialog") return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusableSelector =
      'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

    const firstFocusable = () =>
      dialog.querySelector<HTMLElement>(focusableSelector);

    firstFocusable()?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector),
      ).filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [variant, onClose]);

  useEffect(() => {
    let active = true;
    void apiRequest<LeadDetailData>(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/leads/${encodeURIComponent(leadId)}`,
    )
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setStatus(data.status);
        setError("");
        setActionError("");
        setNotice("");
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setDetail(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить заявку.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessId, leadId]);

  async function patchStatus(next: LeadStatus, note?: string) {
    if (!detail || busy || isDemoMode) return;
    setBusy(true);
    setActionError("");
    setNotice("");
    try {
      const updated = await apiRequest<Lead>(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/leads/${encodeURIComponent(leadId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: next, note }),
        },
      );
      setDetail((old) => (old ? { ...old, ...updated } : updated));
      setStatus(updated.status);
      onUpdated?.(updated);
      setNotice(
        next === "processing" && detail.status === "new"
          ? "Заявка взята в работу."
          : "Статус сохранён.",
      );
      // Refresh history
      const fresh = await apiRequest<LeadDetailData>(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/leads/${encodeURIComponent(leadId)}`,
      );
      setDetail(fresh);
      setStatus(fresh.status);
    } catch (e) {
      if (e instanceof ClientError && [401, 403, 404].includes(e.status)) {
        setError(e.message);
      } else {
        setActionError(
          e instanceof Error
            ? e.message
            : "Не удалось сохранить статус. Попробуйте ещё раз.",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  const transitions = detail ? allowedLeadTransitions(detail.status) : [];
  const canTake =
    detail?.status === "new" && transitions.includes("processing");

  const answerRows =
    detail?.answerFields?.length
      ? detail.answerFields
      : Object.entries(detail?.answers ?? {}).map(([key, value]) => ({
          key,
          label: key,
          value,
        }));

  const attachments = answerRows.filter((row) => {
    if (isAttachment(row.value)) return true;
    if (Array.isArray(row.value) && row.value.some(isAttachment)) return true;
    return false;
  });

  const body = (
    <>
      {loading ? (
        <p>Загружаем заявку…</p>
      ) : error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : detail ? (
        <>
          <div className="lead-detail__head">
            <div>
              <span className="eyebrow">Заявка</span>
              <h2>{detail.name}</h2>
              <LeadStatusBadge status={detail.status} />
              {detail.waitLabel ? (
                <span
                  className={
                    "lead-detail__wait" + (detail.overdue ? " is-overdue" : "")
                  }
                >
                  {detail.waitLabel}
                </span>
              ) : null}
            </div>
            <PlatformBadge platform={detail.source} />
          </div>

          {detail.possibleDuplicate ? (
            <p className="lead-detail__duplicate" role="alert">
              Похожая заявка уже есть — от{" "}
              {formatRelativeDateTime(detail.possibleDuplicate.createdAt)}.{" "}
              {onOpenLead ? (
                <button
                  type="button"
                  className="text-link"
                  onClick={() => onOpenLead(detail.possibleDuplicate!.id)}
                >
                  Открыть похожую
                </button>
              ) : null}
            </p>
          ) : null}

          {notice ? (
            <p className="account-notice" role="status" aria-live="polite">
              {notice}
            </p>
          ) : null}

          <div className="lead-detail__section">
            <h3>Клиент</h3>
            {detail.phone ? (
              <div className="detail-facts">
                <span>Телефон</span>
                <strong>{detail.phone}</strong>
              </div>
            ) : null}
            {detail.processingName ? (
              <div className="detail-facts">
                <span>Ответственный</span>
                <strong>{detail.processingName}</strong>
              </div>
            ) : null}
            <p className="account-footnote">
              {formatRelativeDateTime(detail.createdAt)}
            </p>
            {detail.clientId ? (
              <Link
                className="button button--outline"
                href={`/clients?id=${encodeURIComponent(detail.clientId)}`}
              >
                Карточка клиента
              </Link>
            ) : null}
          </div>

          <div className="lead-detail__section">
            <h3>Ответы</h3>
            {answerRows.length ? (
              answerRows.map((row) => (
                <div className="detail-facts" key={row.key}>
                  <span>{row.label}</span>
                  <strong>{formatAnswerValue(row.value)}</strong>
                </div>
              ))
            ) : (
              <p className="message-preview">
                {detail.message || "Клиент не оставил сообщение."}
              </p>
            )}
          </div>

          {attachments.length ? (
            <div className="lead-detail__section">
              <h3>Вложения</h3>
              <ul className="lead-detail__attachments">
                {attachments.flatMap((row) => {
                  const values = Array.isArray(row.value)
                    ? row.value
                    : [row.value];
                  return values.filter(isAttachment).map((file, i) => (
                    <li key={`${row.key}-${i}`}>
                      {file.type === "image" ? (
                        <a
                          href={file.url}
                          target="_blank"
                          rel="noreferrer"
                          className="lead-detail__attachment-preview"
                        >
                          {/* Authenticated same-origin preview; full link keeps download behavior. */}
                          <img
                            src={file.url + "?inline=1"}
                            alt={file.name || "Вложение заявки"}
                            loading="lazy"
                          />
                          <span>{file.name || "Изображение"}</span>
                        </a>
                      ) : (
                        <a href={file.url} target="_blank" rel="noreferrer">
                          {file.name || "Файл"}
                        </a>
                      )}
                    </li>
                  ));
                })}
              </ul>
            </div>
          ) : null}

          <div className="lead-detail__section">
            <h3>Работа с заявкой</h3>
            {canTake ? (
              <button
                type="button"
                className="button button--primary"
                disabled={busy || isDemoMode}
                onClick={() => void patchStatus("processing", "Взял в работу")}
              >
                {busy ? "Сохраняем…" : "Взять в работу"}
              </button>
            ) : null}
            {transitions.length > 0 ? (
              <form
                className="account-card"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (status !== detail.status) void patchStatus(status);
                }}
              >
                <fieldset disabled={busy || isDemoMode}>
                  <label htmlFor="lead-detail-status">
                    <span className="field__label">Статус</span>
                    <select
                      id="lead-detail-status"
                      className="field__control"
                      value={status}
                      onChange={(e) =>
                        setStatus(e.target.value as LeadStatus)
                      }
                    >
                      <option value={detail.status}>
                        {LEAD_STATUS_LABELS[detail.status]}
                      </option>
                      {transitions.map((value) => (
                        <option key={value} value={value}>
                          {leadTransitionActionLabel(detail.status, value)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    className="button button--primary"
                    disabled={status === detail.status}
                    type="submit"
                  >
                    {busy ? "Сохраняем…" : "Сохранить статус"}
                  </button>
                </fieldset>
              </form>
            ) : (
              <p className="field-hint">Статус больше нельзя изменить.</p>
            )}
            {isDemoMode ? (
              <p className="account-footnote">
                В демонстрации изменение статуса недоступно.
              </p>
            ) : null}
            {actionError ? (
              <p className="account-error" role="alert">
                {actionError}
              </p>
            ) : null}
          </div>

          <div className="lead-detail__section">
            <h3>История</h3>
            {detail.history?.length ? (
              <ol className="lead-detail__history">
                {detail.history.map((item) => (
                  <li key={item.id}>
                    <strong>
                      {item.fromStatus
                        ? `${leadStatusLabel(item.fromStatus)} → ${leadStatusLabel(item.toStatus)}`
                        : leadStatusLabel(item.toStatus)}
                    </strong>
                    <small>
                      {item.actorName ? `${item.actorName} · ` : ""}
                      {formatRelativeDateTime(item.createdAt)}
                      {item.note ? ` · ${item.note}` : ""}
                    </small>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="account-footnote">Пока без изменений статуса.</p>
            )}
          </div>
        </>
      ) : null}
    </>
  );

  if (variant === "dialog") {
    return (
      <div
        ref={dialogRef}
        className="lead-detail lead-detail--dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-detail-title"
      >
        <header className="lead-detail__toolbar">
          <h2 id="lead-detail-title" className="sr-only">
            Заявка
          </h2>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={22} />
          </button>
        </header>
        {body}
      </div>
    );
  }

  return (
    <aside className="lead-detail panel" aria-label="Карточка заявки">
      <header className="lead-detail__toolbar">
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Закрыть"
        >
          <X size={22} />
        </button>
      </header>
      {body}
    </aside>
  );
}
