"use client";

import type { ProductEditorState } from "@/components/orders-v2/types";

export function ProductPriceStep({
  value,
  onChange,
  disabled,
}: {
  value: ProductEditorState;
  onChange: (next: ProductEditorState) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="orders-wizard__step">
      <legend>Цена</legend>
      <label className="field">
        <span className="field__label">Базовая цена *</span>
        <input
          className="field__control"
          required
          inputMode="decimal"
          value={value.price}
          onChange={(e) => onChange({ ...value, price: e.target.value })}
        />
      </label>
      <label className="field">
        <span className="field__label">Старая цена / скидка</span>
        <input
          className="field__control"
          inputMode="decimal"
          value={value.compareAtPrice}
          onChange={(e) =>
            onChange({ ...value, compareAtPrice: e.target.value })
          }
        />
      </label>
    </fieldset>
  );
}
