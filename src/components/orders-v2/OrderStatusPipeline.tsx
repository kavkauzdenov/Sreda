"use client";

import {
  nextActionLabel,
  primaryNextStatus,
  STATUS_FLOW,
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
  busy,
  onTransition,
}: {
  status: OrderStatus;
  fulfillment: "pickup" | "delivery";
  busy?: boolean;
  onTransition: (next: OrderStatus) => void;
}) {
  const nextStatuses = STATUS_FLOW[status] ?? [];
  const primary = primaryNextStatus(status);
  const primaryLabel = nextActionLabel(status);
  const canCancel = nextStatuses.includes("cancelled");
  const altStatuses = nextStatuses.filter(
    (s) => s !== "cancelled" && s !== primary,
  );

  // For pickup, prefer handed_over; for delivery, prefer delivered in ready step.
  const preferredPrimary =
    status === "ready"
      ? fulfillment === "delivery"
        ? "delivered"
        : "handed_over"
      : primary;

  const actionStatus =
    preferredPrimary && nextStatuses.includes(preferredPrimary)
      ? preferredPrimary
      : primary;

  const actionLabel = actionStatus
    ? `Перевести в «${STATUS_LABELS[actionStatus]}»`
    : primaryLabel;

  const steps = PIPELINE.filter((s) => {
    if (s === "handed_over" && fulfillment === "delivery") return false;
    if (s === "delivered" && fulfillment === "pickup") return false;
    return true;
  });
  const currentIdx = steps.indexOf(status === "cancelled" ? "new" : status);

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
            onClick={() => onTransition("cancelled")}
          >
            Отменить
          </button>
        ) : null}
        {!actionStatus && !canCancel && !altStatuses.length ? (
          <p className="account-footnote">Дальнейших переходов нет.</p>
        ) : null}
      </div>
    </section>
  );
}
