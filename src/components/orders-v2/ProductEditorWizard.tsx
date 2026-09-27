"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import { ProductMainStep } from "@/components/orders-v2/ProductMainStep";
import { ProductImagesStep } from "@/components/orders-v2/ProductImagesStep";
import { ProductPriceStep } from "@/components/orders-v2/ProductPriceStep";
import { ProductVariantsStep } from "@/components/orders-v2/ProductVariantsStep";
import { ProductInventoryStep } from "@/components/orders-v2/ProductInventoryStep";
import { ProductPreviewStep } from "@/components/orders-v2/ProductPreviewStep";
import {
  EMPTY_PRODUCT_EDITOR,
  type BusinessMode,
  type ProductCategory,
  type ProductEditorState,
} from "@/components/orders-v2/types";
import {
  createProduct,
  getProductDetail,
  updateProduct,
} from "@/services/orders.service";

const STEPS = [
  "main",
  "images",
  "price",
  "variants",
  "inventory",
  "preview",
] as const;

type Step = (typeof STEPS)[number];

const STEP_LABELS: Record<Step, string> = {
  main: "Основное",
  images: "Фото",
  price: "Цена",
  variants: "Варианты",
  inventory: "Склад",
  preview: "Проверка",
};

function parseOptionIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function ProductEditorWizard({
  businessId,
  categories,
  productId,
  businessMode,
  onCancel,
  onSaved,
  onError,
  onNotice,
}: {
  businessId: string;
  categories: ProductCategory[];
  productId: string | null;
  businessMode: BusinessMode;
  onCancel: () => void;
  onSaved: () => void | Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(!!productId);
  const [uploadNote, setUploadNote] = useState("");
  const [state, setState] = useState<ProductEditorState>(() => ({
    ...EMPTY_PRODUCT_EDITOR,
    productType: businessMode === "service" ? "service" : "product",
  }));

  useDialogFocusTrap(dialogRef, onCancel);

  useEffect(() => {
    if (!productId) return;
    let alive = true;
    void getProductDetail(businessId, productId)
      .then((detail) => {
        if (!alive) return;
        const optionGroups = (
          (detail.option_groups as Array<{
            id: string;
            name: string;
            position: number;
          }>) ?? []
        ).sort((a, b) => a.position - b.position);
        const options =
          (detail.options as Array<{
            id: string;
            group_id: string;
            name: string;
            position: number;
          }>) ?? [];
        const variants =
          (detail.variants as Array<{
            id: string;
            option_ids: unknown;
            label: string;
            price: string | null;
            stock_quantity: number | null;
            active: boolean;
          }>) ?? [];
        const images =
          (detail.images as Array<{ attachment_id: string }>) ?? [];
        setState({
          name: String(detail.name ?? ""),
          description: String(detail.description ?? ""),
          sku: detail.sku != null ? String(detail.sku) : "",
          price: String(detail.price ?? ""),
          compareAtPrice:
            detail.compare_at_price != null
              ? String(detail.compare_at_price)
              : "",
          categoryId: detail.category_id
            ? String(detail.category_id)
            : "",
          active: detail.active !== false,
          trackInventory: detail.track_inventory === true,
          stockQuantity:
            detail.stock_quantity != null
              ? String(detail.stock_quantity)
              : "",
          useVariants: detail.use_variants === true,
          variantPricesEnabled: detail.variant_prices_enabled === true,
          groups: optionGroups.map((g) => ({
            id: g.id,
            name: g.name,
            options: options
              .filter((o) => o.group_id === g.id)
              .sort((a, b) => a.position - b.position)
              .map((o) => ({ id: o.id, name: o.name })),
          })),
          variants: variants.map((v) => ({
            id: v.id,
            option_ids: parseOptionIds(v.option_ids),
            label: v.label || "",
            price: v.price != null ? String(v.price) : "",
            stock_quantity:
              v.stock_quantity != null ? String(v.stock_quantity) : "",
            active: v.active !== false,
          })),
          images: images.map((img, i) => ({
            id: img.attachment_id,
            filename: `Фото ${i + 1}`,
            type: "image",
          })),
          productType:
            detail.product_type === "service" ? "service" : "product",
        });
        onError("");
      })
      .catch((e: unknown) => {
        if (alive)
          onError(
            e instanceof Error ? e.message : "Не удалось загрузить товар.",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, productId, onError]);

  const step = STEPS[stepIndex]!;
  const isLast = stepIndex === STEPS.length - 1;

  async function save() {
    if (busy || loading) return;
    if (!state.name.trim() || !state.price.trim()) {
      onError("Укажите название и базовую цену.");
      setStepIndex(0);
      return;
    }
    if (state.useVariants) {
      const validGroups = state.groups
        .map((g) => ({
          ...g,
          name: g.name.trim(),
          options: g.options
            .map((o) => ({ ...o, name: o.name.trim() }))
            .filter((o) => o.name),
        }))
        .filter((g) => g.name && g.options.length);
      if (!validGroups.length || !state.variants.length) {
        onError("Добавьте хотя бы одну группу атрибутов со значениями.");
        setStepIndex(3);
        return;
      }
    }
    setBusy(true);
    onError("");
    onNotice("");
    setUploadNote("");
    try {
      const imageIds = state.images
        .filter((f) => f.type === "image" || f.type.startsWith("image"))
        .map((f) => f.id);
      const payload: Record<string, unknown> = {
        name: state.name.trim(),
        price: state.price.trim(),
        description: state.description.trim(),
        category_id: state.categoryId || null,
        sku: state.sku.trim() || null,
        compare_at_price: state.compareAtPrice.trim() || null,
        active: state.active,
        use_variants: state.useVariants,
        variant_prices_enabled: state.useVariants
          ? state.variantPricesEnabled
          : false,
        track_inventory:
          state.productType === "service" ? false : state.trackInventory,
        images: imageIds,
        product_type: state.productType,
      };
      if (state.trackInventory && !state.useVariants && state.productType !== "service") {
        payload.availability = "quantity";
        payload.stock_quantity = Number(state.stockQuantity || 0);
      } else if (!state.trackInventory || state.productType === "service") {
        payload.availability = "in_stock";
        payload.stock_quantity = null;
      }
      if (state.useVariants) {
        payload.option_groups = state.groups
          .map((g) => ({
            id: g.id,
            name: g.name.trim(),
            options: g.options
              .map((o) => ({ id: o.id, name: o.name.trim() }))
              .filter((o) => o.name),
          }))
          .filter((g) => g.name && g.options.length);
        payload.variants = state.variants.map((v) => ({
          ...(v.id ? { id: v.id } : {}),
          option_ids: v.option_ids,
          label: v.label,
          price: state.variantPricesEnabled
            ? v.price.trim()
              ? v.price.trim()
              : null
            : null,
          availability: state.trackInventory ? "quantity" : "in_stock",
          stock_quantity: state.trackInventory
            ? Number(v.stock_quantity || 0)
            : null,
          active: v.active,
        }));
      } else {
        payload.option_groups = [];
        payload.variants = [];
      }
      if (productId) {
        await updateProduct(businessId, productId, payload);
        onNotice("Товар обновлён.");
      } else {
        await createProduct(businessId, payload);
        onNotice("Товар создан.");
      }
      await onSaved();
    } catch (err) {
      onError(
        err instanceof Error
          ? err.message
          : productId
            ? "Не удалось обновить товар."
            : "Не удалось создать товар.",
      );
    } finally {
      setBusy(false);
    }
  }

  const body = (
    <div
      className="client-dialog-overlay"
      role="presentation"
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        className="client-dialog orders-wizard"
        role="dialog"
        aria-modal="true"
        aria-label={productId ? "Редактирование товара" : "Новый товар"}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="client-dialog__head">
          <h2>{productId ? "Редактирование" : "Новый товар"}</h2>
          <button
            type="button"
            className="button button--ghost"
            onClick={onCancel}
          >
            Закрыть
          </button>
        </header>

        <ol className="orders-wizard__nav" aria-label="Шаги редактора">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button
                type="button"
                className={
                  i === stepIndex
                    ? "button button--primary button--sm"
                    : "button button--outline button--sm"
                }
                disabled={busy || loading}
                onClick={() => setStepIndex(i)}
              >
                {STEP_LABELS[s]}
              </button>
            </li>
          ))}
        </ol>

        {loading ? (
          <p role="status">Загрузка товара…</p>
        ) : (
          <>
            {step === "main" ? (
              <ProductMainStep
                value={state}
                onChange={setState}
                categories={categories}
                businessMode={businessMode}
                disabled={busy}
              />
            ) : null}
            {step === "images" ? (
              <ProductImagesStep
                businessId={businessId}
                value={state}
                onChange={setState}
                disabled={busy}
                uploadNote={uploadNote}
                onUploadNote={setUploadNote}
              />
            ) : null}
            {step === "price" ? (
              <ProductPriceStep
                value={state}
                onChange={setState}
                disabled={busy}
              />
            ) : null}
            {step === "variants" ? (
              <ProductVariantsStep
                value={state}
                onChange={setState}
                disabled={busy}
              />
            ) : null}
            {step === "inventory" ? (
              <ProductInventoryStep
                value={state}
                onChange={setState}
                disabled={busy}
              />
            ) : null}
            {step === "preview" ? (
              <ProductPreviewStep value={state} categories={categories} />
            ) : null}
          </>
        )}

        <div className="client-dialog__actions">
          <button
            type="button"
            className="button button--outline"
            disabled={busy || stepIndex === 0}
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
          >
            Назад
          </button>
          {!isLast ? (
            <button
              type="button"
              className="button button--primary"
              disabled={busy || loading}
              onClick={() =>
                setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))
              }
            >
              Далее
            </button>
          ) : (
            <button
              type="button"
              className="button button--primary"
              disabled={busy || loading}
              onClick={() => void save()}
            >
              {busy ? "Сохраняем…" : productId ? "Сохранить" : "Создать"}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  if (typeof document === "undefined") return null;
  return createPortal(body, document.body);
}
