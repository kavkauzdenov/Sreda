"use client";

import { STATUS_LABELS, type OrderSettings } from "@/components/orders-v2/types";

const CANCEL_OPTIONS = ["new", "accepted", "assembling", "ready"] as const;

export function OrderBehaviorSettings({
  value,
  onChange,
  disabled,
}: {
  value: OrderSettings;
  onChange: (next: OrderSettings) => void;
  disabled?: boolean;
}) {
  function toggleCancel(status: string) {
    const set = new Set(value.customerCancelStatuses);
    if (set.has(status)) set.delete(status);
    else set.add(status);
    onChange({ ...value, customerCancelStatuses: [...set] });
  }

  return (
    <fieldset disabled={disabled} className="orders-settings__section">
      <legend>Поведение заказов</legend>
      <label className="field">
        <span className="field__label">Минимальная сумма заказа</span>
        <input
          className="field__control"
          inputMode="decimal"
          value={value.minimumOrderAmount ?? ""}
          onChange={(e) =>
            onChange({
              ...value,
              minimumOrderAmount: e.target.value || null,
            })
          }
        />
      </label>
      <div
        className="clients-filters__checks"
        role="group"
        aria-label="Клиент может отменить в статусах"
      >
        <p className="account-footnote">Клиент может отменить заказ в статусах:</p>
        {CANCEL_OPTIONS.map((status) => (
          <label
            key={status}
            className={
              value.customerCancelStatuses.includes(status) ? "is-active" : undefined
            }
          >
            <input
              type="checkbox"
              checked={value.customerCancelStatuses.includes(status)}
              onChange={() => toggleCancel(status)}
            />
            {STATUS_LABELS[status]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
