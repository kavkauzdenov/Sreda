"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import { formatMoney } from "@/lib/money";
import {
  createClient,
  getClientDetail,
  getClientPage,
} from "@/services/clients.service";
import {
  createOrder,
  getOrderSettings,
  getProductDetail,
  listProducts,
} from "@/services/orders.service";
import { EMPTY_CLIENT_FILTERS } from "@/components/clients-v2/types";
import type {
  OrderFulfillment,
  OrderSettings,
  ProductListItem,
} from "@/components/orders-v2/types";

type CartLine = {
  key: string;
  productId: string;
  productName: string;
  variantId: string;
  variantLabel: string;
  quantity: number;
  unitPrice: string;
  currency: string;
};

type VariantOpt = { id: string; label: string; price: string | null };

function previewDeliveryFee(
  settings: OrderSettings | null,
  fulfillment: OrderFulfillment,
  subtotal: number,
): number {
  if (!settings || fulfillment === "pickup") return 0;
  const fee = Number(settings.deliveryPrice) || 0;
  const freeFrom =
    settings.freeDeliveryFrom != null
      ? Number(settings.freeDeliveryFrom)
      : null;
  if (freeFrom != null && Number.isFinite(freeFrom) && subtotal >= freeFrom)
    return 0;
  return fee;
}

export function CreateOrderDialog({
  businessId,
  presetClientId,
  onClose,
  onCreated,
}: {
  businessId: string;
  presetClientId?: string | null;
  onClose: () => void;
  onCreated: (orderId: string) => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const requestKey = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [clientMode, setClientMode] = useState<"search" | "create">(
    presetClientId ? "search" : "search",
  );
  const [clientId, setClientId] = useState(presetClientId ?? "");
  const [clientName, setClientName] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientQuery, setClientQuery] = useState("");
  const [clientHits, setClientHits] = useState<
    { id: string; name: string; phone: string | null }[]
  >([]);

  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [productId, setProductId] = useState("");
  const [variants, setVariants] = useState<VariantOpt[]>([]);
  const [variantId, setVariantId] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [cart, setCart] = useState<CartLine[]>([]);

  const [fulfillment, setFulfillment] = useState<OrderFulfillment>("pickup");
  const [settings, setSettings] = useState<OrderSettings | null>(null);
  const [pickupEnabled, setPickupEnabled] = useState(true);
  const [deliveryEnabled, setDeliveryEnabled] = useState(true);
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [comment, setComment] = useState("");

  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    let alive = true;
    void listProducts(businessId)
      .then((rows) => {
        if (alive) setProducts(rows.filter((p) => p.active));
      })
      .catch(() => undefined);
    void getOrderSettings(businessId)
      .then((next) => {
        if (!alive) return;
        setSettings(next);
        setPickupEnabled(next.pickupEnabled);
        setDeliveryEnabled(next.deliveryEnabled);
        if (next.pickupEnabled) setFulfillment("pickup");
        else if (next.deliveryEnabled) setFulfillment("delivery");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [businessId]);

  useEffect(() => {
    if (!presetClientId) return;
    let alive = true;
    void getClientDetail(businessId, presetClientId)
      .then((data) => {
        if (!alive) return;
        setClientId(data.client.id);
        setClientName(data.client.name);
        setClientPhone(data.client.phone ?? "");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [businessId, presetClientId]);

  useEffect(() => {
    if (clientMode !== "search" || clientId) return;
    const q = clientQuery.trim();
    if (q.length < 2) {
      queueMicrotask(() => setClientHits([]));
      return;
    }
    let alive = true;
    const timer = window.setTimeout(() => {
      void getClientPage(businessId, { ...EMPTY_CLIENT_FILTERS, search: q })
        .then((page) => {
          if (!alive) return;
          setClientHits(
            page.items.map((c) => ({
              id: c.id,
              name: c.name,
              phone: c.phone,
            })),
          );
        })
        .catch(() => {
          if (alive) setClientHits([]);
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [businessId, clientMode, clientId, clientQuery]);

  useEffect(() => {
    if (!productId) {
      queueMicrotask(() => {
        setVariants([]);
        setVariantId("");
      });
      return;
    }
    const picked = products.find((p) => p.id === productId);
    if (!picked?.use_variants) {
      queueMicrotask(() => {
        setVariants([]);
        setVariantId("");
      });
      return;
    }
    let alive = true;
    void getProductDetail(businessId, productId)
      .then((data) => {
        if (!alive) return;
        const rows = (
          (data.variants as Array<{
            id: string;
            label: string;
            price: string | null;
            active?: boolean;
          }>) ?? []
        )
          .filter((v) => v.active !== false)
          .map((v) => ({
            id: v.id,
            label: v.label,
            price: v.price,
          }));
        setVariants(rows);
        setVariantId(rows[0]?.id ?? "");
      })
      .catch(() => {
        if (alive) setVariants([]);
      });
    return () => {
      alive = false;
    };
  }, [businessId, productId, products]);

  const currencies = useMemo(
    () => [...new Set(cart.map((l) => l.currency || "RUB"))],
    [cart],
  );
  const mixedCurrency = currencies.length > 1;
  const currency = currencies[0] || "RUB";
  const subtotal = useMemo(() => {
    if (mixedCurrency) return 0;
    return cart.reduce(
      (sum, line) => sum + Number(line.unitPrice) * line.quantity,
      0,
    );
  }, [cart, mixedCurrency]);
  const deliveryFee = previewDeliveryFee(settings, fulfillment, subtotal);
  const total = subtotal + deliveryFee;
  const belowMinimum =
    settings?.minimumOrderAmount != null &&
    Number.isFinite(Number(settings.minimumOrderAmount)) &&
    subtotal > 0 &&
    !mixedCurrency &&
    subtotal < Number(settings.minimumOrderAmount);

  function bumpRequestKey() {
    requestKey.current = "";
  }

  function addLine() {
    const picked = products.find((p) => p.id === productId);
    if (!picked) {
      setError("Выберите товар.");
      return;
    }
    if (picked.use_variants && !variantId) {
      setError("Выберите вариант товара.");
      return;
    }
    const variant = variants.find((v) => v.id === variantId);
    const unitPrice = variant?.price || picked.price;
    const key = `${picked.id}:${variantId || "base"}`;
    setCart((rows) => {
      const existing = rows.find((r) => r.key === key);
      if (existing) {
        return rows.map((r) =>
          r.key === key
            ? { ...r, quantity: Math.min(999, r.quantity + quantity) }
            : r,
        );
      }
      return [
        ...rows,
        {
          key,
          productId: picked.id,
          productName: picked.name,
          variantId,
          variantLabel: variant?.label ?? "",
          quantity,
          unitPrice,
          currency: picked.currency || "RUB",
        },
      ];
    });
    bumpRequestKey();
    setError("");
  }

  function removeLine(key: string) {
    setCart((rows) => rows.filter((r) => r.key !== key));
    bumpRequestKey();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!cart.length) {
      setError("Добавьте хотя бы одну позицию.");
      return;
    }
    if (mixedCurrency) {
      setError("Нельзя смешивать валюты в одном заказе.");
      return;
    }
    if (!clientName.trim()) {
      setError("Укажите имя клиента.");
      return;
    }
    if (!clientPhone.trim()) {
      setError("Укажите телефон клиента.");
      return;
    }
    if (fulfillment === "delivery" && !deliveryAddress.trim()) {
      setError("Укажите адрес доставки.");
      return;
    }
    if (belowMinimum) {
      setError(
        `Минимальная сумма заказа ${Number(settings?.minimumOrderAmount).toFixed(2)}.`,
      );
      return;
    }
    setBusy(true);
    setError("");
    requestKey.current ||= crypto.randomUUID();
    try {
      let resolvedClientId = clientId || undefined;
      if (!resolvedClientId && clientMode === "create") {
        const created = await createClient(businessId, {
          name: clientName.trim(),
          phone: clientPhone.trim() || undefined,
        });
        resolvedClientId = (created as { id: string }).id;
        setClientId(resolvedClientId);
      }
      const result = await createOrder(businessId, {
        request_key: requestKey.current,
        source: "web",
        fulfillment,
        customer_name: clientName.trim(),
        customer_phone: clientPhone.trim(),
        client_id: resolvedClientId,
        delivery_address:
          fulfillment === "delivery" ? deliveryAddress.trim() : undefined,
        comment: comment.trim() || undefined,
        cart_items: cart.map((line) => ({
          product_id: line.productId,
          variant_id: line.variantId || null,
          quantity: line.quantity,
        })),
      });
      requestKey.current = "";
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать заказ.");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    cart.length > 0 &&
    !mixedCurrency &&
    !belowMinimum &&
    Boolean(clientPhone.trim());

  return (
    <div
      className="client-dialog-overlay"
      role="presentation"
      onClick={onClose}
    >
      <form
        ref={dialogRef}
        className="client-dialog orders-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Создать заказ"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className="client-dialog__head">
          <h2>Создать заказ</h2>
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
          >
            Закрыть
          </button>
        </header>

        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}

        <fieldset disabled={busy} className="orders-create-dialog__section">
          <legend>Клиент</legend>
          <div className="orders-create-dialog__client-mode">
            <button
              type="button"
              className={
                clientMode === "search"
                  ? "button button--primary"
                  : "button button--outline"
              }
              onClick={() => setClientMode("search")}
            >
              Найти
            </button>
            <button
              type="button"
              className={
                clientMode === "create"
                  ? "button button--primary"
                  : "button button--outline"
              }
              onClick={() => {
                setClientMode("create");
                setClientId("");
                setClientHits([]);
              }}
            >
              Новый
            </button>
          </div>
          {clientMode === "search" && !clientId ? (
            <label className="field">
              <span className="field__label">Поиск клиента</span>
              <input
                className="field__control"
                value={clientQuery}
                onChange={(e) => setClientQuery(e.target.value)}
                placeholder="Имя или телефон"
                autoFocus={!presetClientId}
              />
            </label>
          ) : null}
          {clientHits.length && !clientId ? (
            <ul className="orders-create-dialog__hits">
              {clientHits.map((hit) => (
                <li key={hit.id}>
                  <button
                    type="button"
                    className="button button--outline"
                    onClick={() => {
                      setClientId(hit.id);
                      setClientName(hit.name);
                      setClientPhone(hit.phone ?? "");
                      setClientHits([]);
                      bumpRequestKey();
                    }}
                  >
                    {hit.name}
                    {hit.phone ? ` · ${hit.phone}` : ""}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <label className="field">
            <span className="field__label">Имя *</span>
            <input
              className="field__control"
              required
              value={clientName}
              onChange={(e) => {
                setClientName(e.target.value);
                bumpRequestKey();
              }}
              maxLength={100}
            />
          </label>
          <label className="field">
            <span className="field__label">Телефон *</span>
            <input
              className="field__control"
              required
              value={clientPhone}
              onChange={(e) => {
                setClientPhone(e.target.value);
                bumpRequestKey();
              }}
              maxLength={40}
            />
          </label>
          {clientId ? (
            <p className="account-footnote">
              Клиент привязан к карточке CRM.
              {!clientPhone.trim()
                ? " Укажите телефон для этого заказа."
                : ""}
            </p>
          ) : null}
        </fieldset>

        <fieldset disabled={busy} className="orders-create-dialog__section">
          <legend>Корзина</legend>
          <label className="field">
            <span className="field__label">Товар</span>
            <select
              className="field__control"
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                bumpRequestKey();
              }}
            >
              <option value="">Выберите</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {formatMoney(p.price, p.currency || "RUB")}
                </option>
              ))}
            </select>
          </label>
          {variants.length ? (
            <label className="field">
              <span className="field__label">Вариант</span>
              <select
                className="field__control"
                value={variantId}
                onChange={(e) => {
                  setVariantId(e.target.value);
                  bumpRequestKey();
                }}
              >
                {variants.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="field">
            <span className="field__label">Количество</span>
            <input
              className="field__control"
              type="number"
              min={1}
              max={999}
              value={quantity}
              onChange={(e) => setQuantity(Number(e.target.value) || 1)}
            />
          </label>
          <button
            type="button"
            className="button button--outline"
            onClick={addLine}
          >
            Добавить в заказ
          </button>
          {cart.length ? (
            <ul className="crm-list">
              {cart.map((line) => (
                <li key={line.key}>
                  <strong>
                    {line.productName}
                    {line.variantLabel ? ` · ${line.variantLabel}` : ""}
                  </strong>
                  <span>
                    {line.quantity} ×{" "}
                    {formatMoney(line.unitPrice, line.currency)}
                  </span>
                  <button
                    type="button"
                    className="button button--ghost"
                    onClick={() => removeLine(line.key)}
                  >
                    Убрать
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="account-footnote">Корзина пуста.</p>
          )}
        </fieldset>

        <fieldset disabled={busy} className="orders-create-dialog__section">
          <legend>Получение</legend>
          <label className="field">
            <span className="field__label">Способ</span>
            <select
              className="field__control"
              value={fulfillment}
              onChange={(e) => {
                setFulfillment(
                  e.target.value === "delivery" ? "delivery" : "pickup",
                );
                bumpRequestKey();
              }}
            >
              {pickupEnabled ? (
                <option value="pickup">Самовывоз</option>
              ) : null}
              {deliveryEnabled ? (
                <option value="delivery">Доставка</option>
              ) : null}
            </select>
          </label>
          {fulfillment === "delivery" ? (
            <label className="field">
              <span className="field__label">Адрес доставки *</span>
              <input
                className="field__control"
                required
                value={deliveryAddress}
                onChange={(e) => {
                  setDeliveryAddress(e.target.value);
                  bumpRequestKey();
                }}
              />
            </label>
          ) : null}
          <label className="field">
            <span className="field__label">Комментарий</span>
            <textarea
              className="field__control"
              rows={2}
              maxLength={2000}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                bumpRequestKey();
              }}
            />
          </label>
        </fieldset>

        {cart.length ? (
          <section
            className="orders-create-dialog__totals"
            aria-label="Итоги заказа"
          >
            {mixedCurrency ? (
              <p className="account-error" role="alert">
                В корзине разные валюты — заказ создать нельзя.
              </p>
            ) : (
              <>
                <div className="detail-facts">
                  <span>Подытог</span>
                  <strong>{formatMoney(subtotal.toFixed(2), currency)}</strong>
                </div>
                <div className="detail-facts">
                  <span>Доставка</span>
                  <strong>
                    {formatMoney(deliveryFee.toFixed(2), currency)}
                  </strong>
                </div>
                <div className="detail-facts">
                  <span>Итого</span>
                  <strong>{formatMoney(total.toFixed(2), currency)}</strong>
                </div>
                {belowMinimum ? (
                  <p className="account-error" role="alert">
                    Минимальная сумма заказа{" "}
                    {formatMoney(
                      Number(settings?.minimumOrderAmount).toFixed(2),
                      currency,
                    )}
                    .
                  </p>
                ) : null}
                <p className="account-footnote">
                  Итог на сервере — источник истины; здесь предварительный расчёт.
                </p>
              </>
            )}
          </section>
        ) : null}

        <div className="client-dialog__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || !canSubmit}
          >
            {busy ? "Создаём…" : "Создать заказ"}
          </button>
          <button
            type="button"
            className="button button--outline"
            onClick={onClose}
          >
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
