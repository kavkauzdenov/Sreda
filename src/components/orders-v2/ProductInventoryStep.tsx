"use client";

import type { ProductEditorState } from "@/components/orders-v2/types";

export function ProductInventoryStep({
  value,
  onChange,
  disabled,
}: {
  value: ProductEditorState;
  onChange: (next: ProductEditorState) => void;
  disabled?: boolean;
}) {
  if (value.productType === "service") {
    return (
      <fieldset disabled className="orders-wizard__step">
        <legend>Склад</legend>
        <p className="account-footnote">
          Для услуг складской учёт не используется.
        </p>
      </fieldset>
    );
  }

  return (
    <fieldset disabled={disabled} className="orders-wizard__step">
      <legend>Склад</legend>
      <label className="orders-wizard__check">
        <input
          type="checkbox"
          checked={value.trackInventory}
          onChange={(e) =>
            onChange({ ...value, trackInventory: e.target.checked })
          }
        />
        Учитывать остаток
      </label>
      {value.trackInventory && !value.useVariants ? (
        <label className="field">
          <span className="field__label">Количество</span>
          <input
            className="field__control"
            inputMode="numeric"
            value={value.stockQuantity}
            onChange={(e) =>
              onChange({ ...value, stockQuantity: e.target.value })
            }
          />
        </label>
      ) : null}
      {value.trackInventory && value.useVariants ? (
        <ul className="crm-list">
          {value.variants.map((v, index) => (
            <li key={v.option_ids.join("-") || String(index)}>
              <strong>{v.label || "Вариант"}</strong>
              <label className="field">
                <span className="field__label">Остаток</span>
                <input
                  className="field__control"
                  inputMode="numeric"
                  value={v.stock_quantity}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      variants: value.variants.map((row, i) =>
                        i === index
                          ? { ...row, stock_quantity: e.target.value }
                          : row,
                      ),
                    })
                  }
                />
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {value.trackInventory ? (
        <label className="field">
          <span className="field__label">
            Предупредить, когда останется ≤
          </span>
          <input
            className="field__control"
            inputMode="numeric"
            placeholder="Не задано"
            value={
              value.lowStockThreshold != null
                ? String(value.lowStockThreshold)
                : ""
            }
            onChange={(e) => {
              const raw = e.target.value.trim();
              if (!raw) {
                onChange({ ...value, lowStockThreshold: null });
                return;
              }
              const n = Number(raw);
              onChange({
                ...value,
                lowStockThreshold: Number.isFinite(n) ? Math.floor(n) : null,
              });
            }}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
