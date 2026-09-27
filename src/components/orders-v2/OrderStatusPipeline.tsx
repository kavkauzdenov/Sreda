"use client";

import { useId, useRef, useState } from "react";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import {
  allowedStatusesForFulfillment,
  nextActionLabel,
  primaryNextStatus,
  STATUS_LABELS,
  type OrderStatus,
} from "@/components/orders-v2/types";

const PIPELINE: OrderStatus[] = [
  "new",
  "accepted",
  "assembling",
  "ready",
  "handed_over",
  "delivered",
  "completed",
];

export function OrderStatusPipeline({
  status,
  fulfillment,
  orderNumber,
  busy,
  onTransition,
}: {
  status: OrderStatus;
  fulfillment: "pickup" | "delivery";
  orderNumber?: number | null;
  busy?: boolean;
  onTransition: (next: OrderStatus) => void;
}) {
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelDialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();

  const nextStatuses = allowedStatusesForFulfillment(status, fulfillment);
  const actionStatus = primaryNextStatus(status, fulfillment);
  const actionLabel =
    actionStatus != null
      ? `Перевести в «${STATUS_LABELS[actionStatus]}»`
      : nextActionLabel(status, fulfillment);
  const canCancel = nextStatuses.includes("cancelled");
  // Compute alts AFTER fulfillment filtering so pickup never shows «Доставлен»
  // and delivery never shows «Выдан» (and no duplicate of the primary).
  const altStatuses = nextStatuses.filter(
    (s) => s !== "cancelled" && s !== actionStatus,
  );

  useDialogFocusTrap(cancelDialogRef, () => setCancelOpen(false), {
    enabled: cancelOpen,
  });

  const steps = PIPELINE.filter((s) => {
    if (s === "handed_over" && fulfillment === "delivery") return false;
    if (s === "delivered" && fulfillment === "pickup") return false;
    return true;
  });
  const currentIdx = steps.indexOf(status === "cancelled" ? "new" : status);

  const orderLabel =
    orderNumber != null ? `№${orderNumber}` : "этот заказ";

  return (
    <section className="orders-pipeline" aria-label="Статус заказа">
      <ol className="orders-pipeline__steps">
        {steps.map((step, idx) => {
          const done =
            status !== "cancelled" && currentIdx >= 0 && idx <= currentIdx;
          const active = step === status;
          return (
            <li
              key={step}
              className={
                "orders-pipeline__step" +
                (done ? " is-done" : "") +
                (active ? " is-active" : "")
              }
            >
              <span>{STATUS_LABELS[step]}</span>
            </li>
          );
        })}
      </ol>
      {status === "cancelled" ? (
        <p className="account-footnote" role="status">
          Заказ отменён.
        </p>
      ) : null}
      <div className="orders-pipeline__actions">
        {actionStatus && actionLabel ? (
          <button
            type="button"
            className="button button--primary"
            disabled={busy}
            onClick={() => onTransition(actionStatus)}
          >
            {actionLabel}
          </button>
        ) : null}
        {altStatuses.map((next) => (
          <button
            key={next}
            type="button"
            className="button button--outline"
            disabled={busy}
            onClick={() => onTransition(next)}
          >
            {STATUS_LABELS[next]}
          </button>
        ))}
        {canCancel ? (
          <button
            type="button"
            className="button button--outline"
            disabled={busy}
            onClick={() => setCancelOpen(true)}
          >
            Отменить
          </button>
        ) : null}
        {!actionStatus && !canCancel && !altStatuses.length ? (
          <p className="account-footnote">Дальнейших переходов нет.</p>
        ) : null}
      </div>

      {cancelOpen ? (
        <div
          className="client-dialog-overlay"
          role="presentation"
          onClick={() => setCancelOpen(false)}
        >
          <div
            ref={cancelDialogRef}
            className="client-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descId}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id={titleId}>Отменить заказ {orderLabel}?</h2>
            <p id={descId}>
              При отмене зарезервированные остатки будут возвращены.
            </p>
            <div className="client-dialog__actions">
              <button
                type="button"
                className="button button--outline"
                disabled={busy}
                onClick={() => setCancelOpen(false)}
              >
                Не отменять
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => {
                  setCancelOpen(false);
                  onTransition("cancelled");
                }}
              >
                Отменить заказ
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
