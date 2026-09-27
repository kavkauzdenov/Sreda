"use client";

import { formatMoney } from "@/lib/money";
import { formatRelativeDateTimeInZone } from "@/lib/format";
import {
  FULFILLMENT_LABELS,
  SOURCE_LABELS,
  STATUS_LABELS,
  type OrderListItem,
} from "@/components/orders-v2/types";

export function OrderRow({
  row,
  selected,
  timezone,
  onSelect,
}: {
  row: OrderListItem;
  selected: boolean;
  timezone: string;
  onSelect: (id: string) => void;
}) {
  const title =
    (row.orderNumber != null ? `№${row.orderNumber}` : "Заказ") +
    " · " +
    (row.clientName || row.customerName);

  return (
    <tr
      className={"clients-list__row" + (selected ? " is-selected" : "")}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
    >
      <td>
        <span className="orders-list__primary">
          <strong>{title}</strong>
          <span className="orders-status-badge" data-status={row.status}>
            {STATUS_LABELS[row.status] ?? row.status}
          </span>
        </span>
      </td>
      <td>
        <span className="clients-list__contacts">
          <span>{row.customerPhone || row.clientPhone || "—"}</span>
          <span>
            {FULFILLMENT_LABELS[row.fulfillment] ?? row.fulfillment}
            {" · "}
            {SOURCE_LABELS[row.source] ?? row.source}
          </span>
        </span>
      </td>
      <td>
        <strong>{formatMoney(row.total, row.currency)}</strong>
        <span className="account-footnote">
          {row.itemCount} поз.
          {row.assignedUser ? ` · ${row.assignedUser.name}` : ""}
        </span>
      </td>
      <td>
        <time dateTime={row.createdAt}>
          {formatRelativeDateTimeInZone(row.createdAt, timezone)}
        </time>
      </td>
    </tr>
  );
}

export function OrderMobileCard({
  row,
  selected,
  timezone,
  onSelect,
}: {
  row: OrderListItem;
  selected: boolean;
  timezone: string;
  onSelect: (id: string) => void;
}) {
  const title =
    (row.orderNumber != null ? `№${row.orderNumber}` : "Заказ") +
    " · " +
    (row.clientName || row.customerName);

  return (
    <button
      type="button"
      className={"client-mobile-card" + (selected ? " is-selected" : "")}
      aria-pressed={selected}
      onClick={() => onSelect(row.id)}
    >
      <span className="client-mobile-card__top">
        <span className="orders-list__primary">
          <strong>{title}</strong>
          <span className="orders-status-badge" data-status={row.status}>
            {STATUS_LABELS[row.status] ?? row.status}
          </span>
        </span>
      </span>
      <span className="client-mobile-card__meta">
        <span>{formatMoney(row.total, row.currency)}</span>
        <span>{FULFILLMENT_LABELS[row.fulfillment]}</span>
        <time dateTime={row.createdAt}>
          {formatRelativeDateTimeInZone(row.createdAt, timezone)}
        </time>
      </span>
    </button>
  );
}
