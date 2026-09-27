"use client";

import { formatMoney } from "@/lib/money";
import type { ProductListItem } from "@/components/orders-v2/types";

export function ProductCard({
  product,
  categoryName,
  busy,
  onEdit,
  onToggleActive,
}: {
  product: ProductListItem;
  categoryName: string;
  busy?: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  return (
    <article className="orders-product-card">
      <div className="orders-product-card__title">{product.name}</div>
      <div className="orders-product-card__price">
        {formatMoney(product.price, product.currency || "RUB")}
      </div>
      <div className="orders-product-card__meta">
        <span>{categoryName}</span>
        <span aria-hidden="true">·</span>
        <span>{product.active ? "Активен" : "Скрыт"}</span>
        {product.track_inventory ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Остаток:{" "}
              {product.stock_quantity != null ? product.stock_quantity : "—"}
            </span>
          </>
        ) : null}
      </div>
      {product.description ? (
        <p className="orders-product-card__desc">{product.description}</p>
      ) : null}
      <div className="orders-product-card__actions">
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={onEdit}
        >
          Изменить
        </button>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={onToggleActive}
        >
          {product.active ? "Скрыть" : "Активировать"}
        </button>
      </div>
    </article>
  );
}
