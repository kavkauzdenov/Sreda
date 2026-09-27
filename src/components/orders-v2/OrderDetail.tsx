"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import { formatMoney } from "@/lib/money";
import { formatRelativeDateTimeInZone } from "@/lib/format";
import { getClientAssignees } from "@/services/clients.service";
import {
  assignOrder,
  claimOrder,
  getOrderDetail,
  updateOrderStatus,
} from "@/services/orders.service";
import { OrderStatusPipeline } from "@/components/orders-v2/OrderStatusPipeline";
import {
  FULFILLMENT_LABELS,
  STATUS_LABELS,
  type OrderDetail as OrderDetailData,
  type OrderStatus,
} from "@/components/orders-v2/types";

export function OrderDetail({
  businessId,
  orderId,
  timezone,
  canAssignOthers,
  variant = "panel",
  onClose,
  onListRefresh,
}: {
  businessId: string;
  orderId: string;
  timezone: string;
  canAssignOthers: boolean;
  variant?: "panel" | "drawer" | "dialog";
  onClose: () => void;
  onListRefresh?: () => void;
}) {
  const [detail, setDetail] = useState<OrderDetailData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [assignees, setAssignees] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [assignId, setAssignId] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      setError("");
    });
    void getOrderDetail(businessId, orderId)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setAssignId(data.assigned_user_id ?? data.assigned_user?.id ?? "");
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setDetail(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить заказ.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessId, orderId, refreshKey]);

  useEffect(() => {
    if (!canAssignOthers) return;
    let active = true;
    void getClientAssignees(businessId)
      .then((rows) => {
        if (active) setAssignees(rows);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [businessId, canAssignOthers]);

  useDialogFocusTrap(rootRef, onClose, {
    enabled: variant !== "panel",
    lockBodyScroll: variant !== "panel",
  });

  function refresh() {
    setRefreshKey((v) => v + 1);
    onListRefresh?.();
  }

  async function transition(next: OrderStatus) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await updateOrderStatus(businessId, orderId, next);
      setNotice("Статус заказа обновлён.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сменить статус.");
    } finally {
      setBusy(false);
    }
  }

  async function onClaim() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await claimOrder(businessId, orderId);
      setNotice("Заказ взят в работу.");
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось взять заказ.");
    } finally {
      setBusy(false);
    }
  }

  async function onAssign() {
    if (busy || !canAssignOthers) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await assignOrder(businessId, orderId, assignId || null);
      setNotice("Ответственный обновлён.");
      refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось назначить ответственного.",
      );
    } finally {
      setBusy(false);
    }
  }

  const isModal = variant === "dialog" || variant === "drawer";
  const className =
    variant === "dialog"
      ? "client-detail client-detail--dialog"
      : variant === "drawer"
        ? "client-detail client-detail--drawer"
        : "panel client-detail";
  const title =
    detail && detail.order_number != null
      ? `Заказ №${detail.order_number}`
      : "Заказ";
  const modalProps = isModal
    ? {
        role: "dialog" as const,
        "aria-modal": true as const,
        "aria-label": detail
          ? title
          : loading
            ? "Загрузка заказа"
            : "Карточка заказа",
      }
    : detail
      ? { "aria-label": title }
      : {};

  if (loading) {
    return (
      <section
        className={className}
        aria-busy="true"
        ref={rootRef}
        {...modalProps}
      >
        <div className="clients-skeleton">
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
        </div>
      </section>
    );
  }

  if (error && !detail) {
    return (
      <section className={className} ref={rootRef} {...modalProps}>
        <p className="account-error" role="alert">
          {error}
        </p>
        <button type="button" className="button button--outline" onClick={onClose}>
          Закрыть
        </button>
        <button
          type="button"
          className="button button--outline"
          onClick={refresh}
        >
          Попробовать ещё раз
        </button>
      </section>
    );
  }

  if (!detail) return null;

  const clientId = detail.client_id;
  const conversationId = detail.conversation_id;

  return (
    <section className={className} ref={rootRef} {...modalProps}>
      <header className="client-detail__head">
        <div className="client-detail__identity">
          <div>
            <h2>{title}</h2>
            <p className="account-footnote">
              {STATUS_LABELS[detail.status] ?? detail.status}
              {" · "}
              {FULFILLMENT_LABELS[detail.fulfillment] ?? detail.fulfillment}
              {" · "}
              {formatRelativeDateTimeInZone(detail.created_at, timezone)}
            </p>
          </div>
        </div>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Закрыть
        </button>
      </header>

      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="account-notice" role="status">
          {notice}
        </p>
      ) : null}

      <section className="orders-detail__client" aria-label="Клиент">
        <h3>Клиент</h3>
        <p>
          <strong>{detail.client_name || detail.customer_name}</strong>
        </p>
        <p>{detail.customer_phone || "Телефон не указан"}</p>
        <nav className="orders-detail__links" aria-label="Связь с клиентом">
          {conversationId ? (
            <Link
              className="button button--primary"
              href={`/messages?conversation=${encodeURIComponent(conversationId)}`}
            >
              Написать
            </Link>
          ) : null}
          <Link
            className="button button--outline"
            href={
              clientId
                ? `/clients?client=${encodeURIComponent(clientId)}`
                : "/clients"
            }
          >
            Открыть клиента
          </Link>
        </nav>
      </section>

      {detail.delivery_address ? (
        <div className="detail-facts">
          <span>Адрес</span>
          <strong>{detail.delivery_address}</strong>
        </div>
      ) : null}
      {detail.comment ? (
        <p className="message-preview">{detail.comment}</p>
      ) : null}

      <section aria-label="Позиции">
        <h3>Позиции</h3>
        {detail.items?.length ? (
          <ul className="crm-list">
            {detail.items.map((item) => (
              <li key={item.id}>
                <strong>
                  {item.name}
                  {item.variant_label ? ` · ${item.variant_label}` : ""}
                </strong>
                <span>
                  {item.quantity} ×{" "}
                  {formatMoney(item.unit_price, detail.currency)} ={" "}
                  {formatMoney(item.line_total, detail.currency)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="account-footnote">Позиции не найдены.</p>
        )}
      </section>

      <section className="orders-detail__totals" aria-label="Итоги">
        {detail.subtotal != null ? (
          <div className="detail-facts">
            <span>Подытог</span>
            <strong>{formatMoney(detail.subtotal, detail.currency)}</strong>
          </div>
        ) : null}
        {detail.delivery_fee != null && Number(detail.delivery_fee) > 0 ? (
          <div className="detail-facts">
            <span>Доставка</span>
            <strong>{formatMoney(detail.delivery_fee, detail.currency)}</strong>
          </div>
        ) : null}
        <div className="detail-facts">
          <span>Итого</span>
          <strong>{formatMoney(detail.total, detail.currency)}</strong>
        </div>
      </section>

      <OrderStatusPipeline
        status={detail.status}
        fulfillment={detail.fulfillment}
        busy={busy}
        onTransition={(next) => void transition(next)}
      />

      <section className="orders-detail__assign" aria-label="Ответственный">
        <h3>Ответственный</h3>
        <p>
          {detail.assigned_user?.name ||
            (detail.assigned_user_id ? "Назначен" : "Не назначен")}
        </p>
        <div className="orders-detail__assign-actions">
          <button
            type="button"
            className="button button--outline"
            disabled={busy}
            onClick={() => void onClaim()}
          >
            Взять себе
          </button>
          {canAssignOthers ? (
            <>
              <label className="field">
                <span className="field__label">Назначить</span>
                <select
                  className="field__control"
                  value={assignId}
                  disabled={busy}
                  onChange={(e) => setAssignId(e.target.value)}
                >
                  <option value="">Не назначен</option>
                  {assignees.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button button--outline"
                disabled={busy}
                onClick={() => void onAssign()}
              >
                Сохранить
              </button>
            </>
          ) : null}
        </div>
      </section>

      {detail.history?.length ? (
        <section aria-label="История статусов">
          <h3>История</h3>
          <ul className="crm-list">
            {detail.history.map((row) => (
              <li key={row.id}>
                <strong>
                  {(row.from_status
                    ? `${STATUS_LABELS[row.from_status as OrderStatus] ?? row.from_status} → `
                    : "") +
                    (STATUS_LABELS[row.to_status as OrderStatus] ??
                      row.to_status)}
                </strong>
                <small>
                  {formatRelativeDateTimeInZone(row.created_at, timezone)}
                </small>
                {row.note ? <span>{row.note}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}
