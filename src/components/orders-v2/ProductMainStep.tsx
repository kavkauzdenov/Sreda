"use client";

import type {
  BusinessMode,
  ProductCategory,
  ProductEditorState,
} from "@/components/orders-v2/types";

export function ProductMainStep({
  value,
  onChange,
  categories,
  businessMode,
  disabled,
}: {
  value: ProductEditorState;
  onChange: (next: ProductEditorState) => void;
  categories: ProductCategory[];
  businessMode: BusinessMode;
  disabled?: boolean;
}) {
  const showType = businessMode === "combined";

  return (
    <fieldset disabled={disabled} className="orders-wizard__step">
      <legend>Основное</legend>
      {showType ? (
        <label className="field">
          <span className="field__label">Тип</span>
          <select
            className="field__control"
            value={value.productType}
            onChange={(e) =>
              onChange({
                ...value,
                productType:
                  e.target.value === "service" ? "service" : "product",
                trackInventory:
                  e.target.value === "service" ? false : value.trackInventory,
              })
            }
          >
            <option value="product">Товар</option>
            <option value="service">Услуга</option>
          </select>
        </label>
      ) : null}
      <label className="field">
        <span className="field__label">Название *</span>
        <input
          className="field__control"
          required
          value={value.name}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">Описание</span>
        <textarea
          className="field__control"
          rows={3}
          value={value.description}
          onChange={(e) => onChange({ ...value, description: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">Артикул (SKU)</span>
        <input
          className="field__control"
          value={value.sku}
          onChange={(e) => onChange({ ...value, sku: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">Категория</span>
        <select
          className="field__control"
          value={value.categoryId}
          onChange={(e) => onChange({ ...value, categoryId: e.target.value })}
        >
          <option value="">Без категории</option>
          {categories
            .filter((c) => c.active)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      </label>
      <label className="orders-wizard__check">
        <input
          type="checkbox"
          checked={value.active}
          onChange={(e) => onChange({ ...value, active: e.target.checked })}
        />
        Активен в каталоге
      </label>
    </fieldset>
  );
}
