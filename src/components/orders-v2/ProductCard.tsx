"use client";

import { formatMoney } from "@/lib/money";
import {
  productPriceLabel,
  productStockLabel,
  type ProductListItem,
} from "@/components/orders-v2/types";

export function ProductCard({
  businessId,
  product,
  categoryName,
  busy,
  onEdit,
  onToggleActive,
}: {
  businessId: string;
  product: ProductListItem;
  categoryName: string;
  busy?: boolean;
  onEdit: () => void;
  onToggleActive: () => void;
}) {
  const imageId =
    product.images?.[0]?.attachment_id || product.images?.[0]?.id || null;
  const priceRaw = productPriceLabel(product);
  const fromPrefix = priceRaw.startsWith("от ");
  const amount = fromPrefix ? priceRaw.slice(3) : priceRaw;
  const stockLabel = productStockLabel(product);

  return (
    <article
      className={
        "orders-product-card" + (product.active ? "" : " is-hidden")
      }
    >
      <div className="orders-product-card__media" aria-hidden={!imageId}>
        {imageId ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="orders-product-card__img"
            src={`/api/v1/businesses/${encodeURIComponent(businessId)}/attachments/${encodeURIComponent(imageId)}`}
            alt=""
          />
        ) : (
          <div className="orders-product-card__placeholder" role="img" aria-label="Нет фото">
            Нет фото
          </div>
        )}
      </div>
      <div className="orders-product-card__title">{product.name}</div>
      <div className="orders-product-card__price">
        {fromPrefix ? "от " : ""}
        {formatMoney(amount, product.currency || "RUB")}
      </div>
      <div className="orders-product-card__meta">
        <span>{categoryName}</span>
        <span aria-hidden="true">·</span>
        <span>{product.active ? "В продаже" : "Скрыт"}</span>
        {stockLabel ? (
          <>
            <span aria-hidden="true">·</span>
            <span>{stockLabel}</span>
          </>
        ) : null}
        {product.sku ? (
          <>
            <span aria-hidden="true">·</span>
            <span>SKU {product.sku}</span>
          </>
        ) : null}
      </div>
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
