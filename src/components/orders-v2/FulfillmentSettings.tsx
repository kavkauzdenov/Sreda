"use client";

import type { OrderSettings } from "@/components/orders-v2/types";

export function FulfillmentSettings({
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
      <legend>Доставка и самовывоз</legend>
      <label className="orders-wizard__check">
        <input
          type="checkbox"
          checked={value.pickupEnabled}
          onChange={(e) =>
            onChange({ ...value, pickupEnabled: e.target.checked })
          }
        />
        Самовывоз
      </label>
      {value.pickupEnabled ? (
        <>
          <label className="field">
            <span className="field__label">Адрес самовывоза</span>
            <input
              className="field__control"
              value={value.pickupAddress}
              maxLength={500}
              onChange={(e) =>
                onChange({ ...value, pickupAddress: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Инструкция</span>
            <textarea
              className="field__control"
              rows={2}
              maxLength={2000}
              value={value.pickupInstructions}
              onChange={(e) =>
                onChange({ ...value, pickupInstructions: e.target.value })
              }
            />
          </label>
        </>
      ) : null}

      <label className="orders-wizard__check">
        <input
          type="checkbox"
          checked={value.deliveryEnabled}
          onChange={(e) =>
            onChange({ ...value, deliveryEnabled: e.target.checked })
          }
        />
        Доставка
      </label>
      {value.deliveryEnabled ? (
        <>
          <label className="field">
            <span className="field__label">Стоимость доставки</span>
            <input
              className="field__control"
              inputMode="decimal"
              value={value.deliveryPrice}
              onChange={(e) =>
                onChange({ ...value, deliveryPrice: e.target.value })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Бесплатно от суммы</span>
            <input
              className="field__control"
              inputMode="decimal"
              value={value.freeDeliveryFrom ?? ""}
              onChange={(e) =>
                onChange({
                  ...value,
                  freeDeliveryFrom: e.target.value || null,
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Описание доставки</span>
            <textarea
              className="field__control"
              rows={2}
              maxLength={2000}
              value={value.deliveryDescription}
              onChange={(e) =>
                onChange({ ...value, deliveryDescription: e.target.value })
              }
            />
          </label>
        </>
      ) : null}
    </fieldset>
  );
}
