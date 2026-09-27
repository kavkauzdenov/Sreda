"use client";

import { useEffect, useState } from "react";
import { BusinessModeSettings } from "@/components/orders-v2/BusinessModeSettings";
import { FulfillmentSettings } from "@/components/orders-v2/FulfillmentSettings";
import { OrderBehaviorSettings } from "@/components/orders-v2/OrderBehaviorSettings";
import type { BusinessMode, OrderSettings } from "@/components/orders-v2/types";
import {
  getOrderSettings,
  saveOrderSettings,
} from "@/services/orders.service";

const EMPTY: OrderSettings = {
  customerCancelStatuses: ["new", "accepted"],
  pickupEnabled: true,
  pickupAddress: "",
  pickupInstructions: "",
  deliveryEnabled: true,
  deliveryPrice: "0",
  freeDeliveryFrom: null,
  minimumOrderAmount: null,
  deliveryDescription: "",
  businessMode: "store",
};

export function OrderSettingsView({
  businessId,
  canEdit,
  onModeChange,
}: {
  businessId: string;
  canEdit: boolean;
  onModeChange?: (mode: BusinessMode) => void;
}) {
  const [value, setValue] = useState<OrderSettings>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let alive = true;
    void getOrderSettings(businessId)
      .then((data) => {
        if (!alive) return;
        setValue(data);
        onModeChange?.(data.businessMode);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить настройки.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // Intentionally only reload when business changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !canEdit) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await saveOrderSettings(businessId, value);
      setValue(saved);
      onModeChange?.(saved.businessMode);
      setNotice("Настройки сохранены.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось сохранить настройки.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="panel" aria-busy="true">
        <div className="clients-skeleton">
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
        </div>
      </section>
    );
  }

  return (
    <form className="panel orders-settings" onSubmit={(e) => void save(e)}>
      <h2>Настройки заказов</h2>
      {!canEdit ? (
        <p className="account-footnote">
          Изменять настройки могут владелец и администратор.
        </p>
      ) : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="account-notice" role="status">
          {notice}
        </p>
      ) : null}

      <BusinessModeSettings
        value={value}
        onChange={setValue}
        disabled={busy || !canEdit}
      />
      <FulfillmentSettings
        value={value}
        onChange={setValue}
        disabled={busy || !canEdit}
      />
      <OrderBehaviorSettings
        value={value}
        onChange={setValue}
        disabled={busy || !canEdit}
      />

      {canEdit ? (
        <div className="client-dialog__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy}
          >
            {busy ? "Сохраняем…" : "Сохранить настройки"}
          </button>
        </div>
      ) : null}
    </form>
  );
}
