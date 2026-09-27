"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/apiClient";
import {
  channelDisplayStatus,
  type ChannelConnectionLike,
} from "@/lib/ordersChannelStatus";
import type { BusinessMode, OrderSettings } from "@/components/orders-v2/types";
import {
  getOrderSettings,
  listProducts,
  saveOrderSettings,
} from "@/services/orders.service";

const STEPS = [
  { id: 1, title: "Тип бизнеса" },
  { id: 2, title: "Первый товар" },
  { id: 3, title: "Доставка и самовывоз" },
  { id: 4, title: "Каналы" },
  { id: 5, title: "Проверка" },
  { id: 6, title: "Готовность" },
] as const;

type Conn = ChannelConnectionLike & { platform: string };

function ChannelRow({
  title,
  conn,
}: {
  title: string;
  conn: Conn | undefined;
}) {
  const display = channelDisplayStatus(conn);
  return (
    <li>
      <strong>{title}</strong>
      <span data-testid={`channel-status-${conn?.platform ?? title.toLowerCase()}`}>
        {display.label}
      </span>
      <Link className="button button--outline" href="/connections">
        {display.cta}
      </Link>
    </li>
  );
}

export function OrdersSetupPanel({
  businessId,
  canEdit,
  catalogRevision = 0,
  onModeChange,
  onGoTab,
}: {
  businessId: string;
  canEdit: boolean;
  /** Bumped when catalog create/update/toggle happens so readiness refreshes. */
  catalogRevision?: number;
  onModeChange?: (mode: BusinessMode) => void;
  onGoTab?: (tab: "catalog" | "settings" | "orders") => void;
}) {
  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState<OrderSettings | null>(null);
  const [productCount, setProductCount] = useState(0);
  const [connections, setConnections] = useState<Conn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let alive = true;
    void Promise.all([
      getOrderSettings(businessId),
      listProducts(businessId),
      apiRequest<Conn[]>(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/connections`,
      ).catch(() => [] as Conn[]),
    ])
      .then(([s, products, conns]) => {
        if (!alive) return;
        setSettings(s);
        const activeCount = products.filter((p) => p.active).length;
        setProductCount(activeCount);
        setConnections(Array.isArray(conns) ? conns : []);
        onModeChange?.(s.businessMode);
        // Initial readiness only — do not collapse wizard mid-setup on later refreshes.
        if (activeCount > 0 && (s.pickupEnabled || s.deliveryEnabled)) {
          setDismissed(true);
        }
      })
      .catch((e: unknown) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Не удалось загрузить готовность.",
          );
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId]);

  // Catalog create/update/toggle → refresh active product count without full reload.
  useEffect(() => {
    if (catalogRevision === 0) return;
    let alive = true;
    void listProducts(businessId)
      .then((products) => {
        if (!alive) return;
        const activeCount = products.filter((p) => p.active).length;
        setProductCount(activeCount);
        if (activeCount === 0) setDismissed(false);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [businessId, catalogRevision]);

  async function patchSettings(patch: Partial<OrderSettings>) {
    if (!canEdit || !settings) return;
    setBusy(true);
    setError("");
    try {
      const saved = await saveOrderSettings(businessId, {
        ...settings,
        ...patch,
      });
      setSettings(saved);
      onModeChange?.(saved.businessMode);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
    } finally {
      setBusy(false);
    }
  }

  const telegram = connections.find((c) => c.platform === "telegram");
  const vk = connections.find((c) => c.platform === "vk");
  const telegramStatus = channelDisplayStatus(telegram);
  const vkStatus = channelDisplayStatus(vk);
  const channelOk = telegramStatus.ready || vkStatus.ready;
  const fulfillmentOk = Boolean(
    settings?.pickupEnabled || settings?.deliveryEnabled,
  );
  const ready =
    productCount > 0 && fulfillmentOk && Boolean(settings?.businessMode);

  if (dismissed && ready) {
    return (
      <section className="panel solution-setup-banner" aria-label="Готовность заказов">
        <p className="account-footnote">
          Приём заказов готов к работе.
          {!channelOk
            ? " Каналы Telegram/VK можно подключить и запустить в «Подключениях»."
            : ""}
        </p>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setDismissed(false)}
        >
          Открыть мастер настройки
        </button>
      </section>
    );
  }

  return (
    <section className="panel solution-setup-banner" aria-label="Настройка заказов">
      <h2>Настройка приёма заказов</h2>
      <ol className="setup-steps setup-steps--seven" aria-label="Шаги">
        {STEPS.map((s) => (
          <li
            key={s.id}
            className={
              s.id === step ? "is-current" : s.id < step ? "is-done" : undefined
            }
          >
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setStep(s.id)}
            >
              {s.id}. {s.title}
            </button>
          </li>
        ))}
      </ol>
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}

      {step === 1 ? (
        <div className="setup-editor">
          <p className="setup-description">Выберите тип бизнеса.</p>
          <div className="setup-options">
            {(
              [
                ["store", "Магазин"],
                ["service", "Услуги"],
                ["combined", "Магазин и услуги"],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                className={
                  "setup-option" +
                  (settings?.businessMode === mode ? " is-selected" : "")
                }
                disabled={busy || !canEdit}
                onClick={() => void patchSettings({ businessMode: mode })}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="button button--primary"
            disabled={!settings?.businessMode}
            onClick={() => setStep(2)}
          >
            Далее
          </button>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="setup-editor">
          <p className="setup-description">
            Добавьте хотя бы один товар или услугу в каталог.
          </p>
          <p data-testid="orders-setup-product-count">
            Сейчас в каталоге: <strong>{productCount}</strong>
          </p>
          <div className="solution-setup-banner__actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => onGoTab?.("catalog")}
            >
              Открыть каталог
            </button>
            <button
              type="button"
              className="button button--outline"
              disabled={productCount < 1}
              onClick={() => setStep(3)}
            >
              Далее
            </button>
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="setup-editor">
          <p className="setup-description">
            Включите самовывоз и/или доставку.
          </p>
          <label className="orders-wizard__check">
            <input
              type="checkbox"
              checked={settings?.pickupEnabled ?? true}
              disabled={busy || !canEdit}
              onChange={(e) =>
                void patchSettings({ pickupEnabled: e.target.checked })
              }
            />
            Самовывоз
          </label>
          <label className="orders-wizard__check">
            <input
              type="checkbox"
              checked={settings?.deliveryEnabled ?? true}
              disabled={busy || !canEdit}
              onChange={(e) =>
                void patchSettings({ deliveryEnabled: e.target.checked })
              }
            />
            Доставка
          </label>
          <button
            type="button"
            className="button button--primary"
            disabled={!fulfillmentOk}
            onClick={() => setStep(4)}
          >
            Далее
          </button>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="setup-editor">
          <p className="setup-description">
            Подключите и запустите каналы в разделе Connections — здесь статус
            runtime.
          </p>
          <ul className="orders-channel-status">
            <ChannelRow title="Telegram" conn={telegram} />
            <ChannelRow title="VK" conn={vk} />
          </ul>
          <button
            type="button"
            className="button button--primary"
            onClick={() => setStep(5)}
          >
            Далее
          </button>
        </div>
      ) : null}

      {step === 5 ? (
        <div className="setup-editor">
          <p className="setup-description">Краткая проверка перед запуском.</p>
          <ul className="setup-progress__list">
            <li>{settings?.businessMode ? "✓" : "○"} Тип бизнеса</li>
            <li>{productCount > 0 ? "✓" : "○"} Каталог</li>
            <li>{fulfillmentOk ? "✓" : "○"} Получение заказов</li>
            <li>
              {channelOk ? "✓" : "○"} Канал запущен (можно позже)
            </li>
          </ul>
          <button
            type="button"
            className="button button--primary"
            onClick={() => setStep(6)}
          >
            Далее
          </button>
        </div>
      ) : null}

      {step === 6 ? (
        <div className="setup-editor">
          <p className="setup-description">
            {ready
              ? "Готово — можно принимать заказы."
              : "Дополните каталог и способы получения, затем возвращайтесь."}
          </p>
          <div className="solution-setup-banner__actions">
            <button
              type="button"
              className="button button--primary"
              disabled={!ready}
              onClick={() => {
                setDismissed(true);
                onGoTab?.("orders");
              }}
            >
              К заказам
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setDismissed(true)}
            >
              Скрыть мастер
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
