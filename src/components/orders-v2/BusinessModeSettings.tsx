"use client";

import type { BusinessMode, OrderSettings } from "@/components/orders-v2/types";

const MODES: { value: BusinessMode; title: string; description: string }[] = [
  {
    value: "store",
    title: "Магазин",
    description: "Каталог товаров и складской учёт.",
  },
  {
    value: "service",
    title: "Услуги",
    description: "Каталог услуг без склада.",
  },
  {
    value: "combined",
    title: "Товары и услуги",
    description: "Каталог с типами позиций и складом для товаров.",
  },
];

export function BusinessModeSettings({
  value,
  onChange,
  disabled,
}: {
  value: OrderSettings;
  onChange: (next: OrderSettings) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset disabled={disabled} className="orders-settings__section">
      <legend>Тип бизнеса</legend>
      <div className="orders-mode-grid" role="radiogroup" aria-label="Тип бизнеса">
        {MODES.map((mode) => (
          <label
            key={mode.value}
            className={
              "orders-mode-option" +
              (value.businessMode === mode.value ? " is-active" : "")
            }
          >
            <input
              type="radio"
              name="businessMode"
              value={mode.value}
              checked={value.businessMode === mode.value}
              onChange={() =>
                onChange({ ...value, businessMode: mode.value })
              }
            />
            <strong>{mode.title}</strong>
            <span>{mode.description}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
