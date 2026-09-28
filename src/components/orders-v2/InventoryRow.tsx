"use client";

import type { InventoryRow as InventoryRowData } from "@/components/orders-v2/types";

const STATE_LABELS: Record<InventoryRowData["state"], string> = {
  in_stock: "В наличии",
  low: "Мало",
  out: "Нет",
  untracked: "Не учитывается",
};

export function InventoryRow({
  row,
  onEdit,
}: {
  row: InventoryRowData;
  onEdit: () => void;
}) {
  const title = row.variantLabel
    ? `${row.name} · ${row.variantLabel}`
    : row.name;

  return (
    <tr>
      <td>
        <strong>{title}</strong>
        {row.sku ? (
          <span className="account-footnote">SKU: {row.sku}</span>
        ) : null}
      </td>
      <td>
        {row.trackInventory
          ? row.stockQuantity != null
            ? row.stockQuantity
            : "—"
          : "—"}
      </td>
      <td>
        <span
          className="orders-status-badge"
          data-inventory={row.state}
        >
          {STATE_LABELS[row.state]}
        </span>
      </td>
      <td>
        <button
          type="button"
          className="button button--outline"
          disabled={!row.trackInventory}
          onClick={onEdit}
        >
          Изменить
        </button>
      </td>
    </tr>
  );
}

export function InventoryMobileCard({
  row,
  onEdit,
}: {
  row: InventoryRowData;
  onEdit: () => void;
}) {
  const title = row.variantLabel
    ? `${row.name} · ${row.variantLabel}`
    : row.name;

  return (
    <article className="client-mobile-card">
      <span className="client-mobile-card__top">
        <strong>{title}</strong>
        <span className="orders-status-badge" data-inventory={row.state}>
          {STATE_LABELS[row.state]}
        </span>
      </span>
      <span className="client-mobile-card__meta">
        <span>
          Остаток:{" "}
          {row.trackInventory
            ? row.stockQuantity != null
              ? row.stockQuantity
              : "—"
            : "не учитывается"}
        </span>
        {row.sku ? <span>SKU: {row.sku}</span> : null}
      </span>
      <button
        type="button"
        className="button button--outline"
        disabled={!row.trackInventory}
        onClick={onEdit}
      >
        Изменить остаток
      </button>
    </article>
  );
}
