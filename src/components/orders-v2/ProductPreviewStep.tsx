"use client";

import { formatMoney } from "@/lib/money";
import type {
  ProductCategory,
  ProductEditorState,
} from "@/components/orders-v2/types";

export function ProductPreviewStep({
  value,
  categories,
}: {
  value: ProductEditorState;
  categories: ProductCategory[];
}) {
  const category =
    categories.find((c) => c.id === value.categoryId)?.name ?? "Без категории";

  return (
    <section className="orders-wizard__step" aria-label="Предпросмотр">
      <h3>Предпросмотр</h3>
      <div className="detail-facts">
        <span>Название</span>
        <strong>{value.name || "—"}</strong>
      </div>
      <div className="detail-facts">
        <span>Тип</span>
        <strong>{value.productType === "service" ? "Услуга" : "Товар"}</strong>
      </div>
      <div className="detail-facts">
        <span>Цена</span>
        <strong>{formatMoney(value.price || 0, "RUB")}</strong>
      </div>
      <div className="detail-facts">
        <span>Категория</span>
        <strong>{category}</strong>
      </div>
      <div className="detail-facts">
        <span>Статус</span>
        <strong>{value.active ? "Активен" : "Скрыт"}</strong>
      </div>
      <div className="detail-facts">
        <span>Варианты</span>
        <strong>
          {value.useVariants ? `${value.variants.length} комбинаций` : "Нет"}
        </strong>
      </div>
      <div className="detail-facts">
        <span>Склад</span>
        <strong>
          {value.productType === "service"
            ? "Не применяется"
            : value.trackInventory
              ? value.useVariants
                ? "По вариантам"
                : value.stockQuantity || "0"
              : "Не учитывается"}
        </strong>
      </div>
      <div className="detail-facts">
        <span>Фото</span>
        <strong>{value.images.length}</strong>
      </div>
      {value.description ? (
        <p className="message-preview">{value.description}</p>
      ) : null}
    </section>
  );
}
