"use client";

import { useEffect, useState } from "react";
import { ProductCard } from "@/components/orders-v2/ProductCard";
import { ProductEditorWizard } from "@/components/orders-v2/ProductEditorWizard";
import type {
  BusinessMode,
  ProductCategory,
  ProductListItem,
} from "@/components/orders-v2/types";
import {
  createCategory,
  listCategories,
  listProducts,
  updateProduct,
} from "@/services/orders.service";

export function CatalogView({
  businessId,
  businessMode,
}: {
  businessId: string;
  businessMode: BusinessMode;
}) {
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCategory, setShowCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [editingProductId, setEditingProductId] = useState<string | null>(null);
  const [creatingProduct, setCreatingProduct] = useState(false);

  async function reload() {
    const [cats, rows] = await Promise.all([
      listCategories(businessId),
      listProducts(businessId),
    ]);
    setCategories(cats);
    setProducts(rows);
  }

  useEffect(() => {
    let alive = true;
    void Promise.all([listCategories(businessId), listProducts(businessId)])
      .then(([cats, rows]) => {
        if (!alive) return;
        setCategories(cats);
        setProducts(rows);
        setError("");
      })
      .catch((e: unknown) => {
        if (alive)
          setError(
            e instanceof Error ? e.message : "Ошибка загрузки каталога.",
          );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  async function onCreateCategory(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !categoryName.trim()) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await createCategory(businessId, { name: categoryName.trim() });
      setCategoryName("");
      setShowCategory(false);
      await reload();
      setNotice("Категория создана.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось создать категорию.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(product: ProductListItem) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await updateProduct(businessId, product.id, {
        name: product.name,
        price: product.price,
        description: product.description,
        category_id: product.category_id,
        currency: product.currency,
        sku: product.sku,
        use_variants: product.use_variants,
        variant_prices_enabled: product.variant_prices_enabled ?? false,
        track_inventory: product.track_inventory,
        availability: product.availability,
        stock_quantity: product.stock_quantity,
        active: !product.active,
      });
      await reload();
      setNotice(product.active ? "Товар скрыт." : "Товар активирован.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось обновить товар.",
      );
    } finally {
      setBusy(false);
    }
  }

  const categoryNameOf = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? "Без категории";
  const editorOpen = creatingProduct || editingProductId != null;
  const emptyHint =
    businessMode === "service"
      ? "Добавьте услуги в каталог, чтобы принимать заказы."
      : "Добавьте товары в каталог, чтобы принимать заказы из бота.";

  return (
    <div className="orders-catalog">
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

      <section className="panel" aria-label="Каталог">
        <div className="orders-catalog__toolbar">
          <h2>Товары и услуги</h2>
          <div className="orders-catalog__toolbar-actions">
            {!showCategory ? (
              <button
                type="button"
                className="button button--outline"
                disabled={busy || editorOpen}
                onClick={() => setShowCategory(true)}
              >
                + Категория
              </button>
            ) : null}
            {!editorOpen ? (
              <button
                type="button"
                className="button button--primary"
                disabled={busy}
                onClick={() => {
                  setEditingProductId(null);
                  setCreatingProduct(true);
                  setError("");
                  setNotice("");
                }}
              >
                + Добавить
              </button>
            ) : null}
          </div>
        </div>

        {showCategory ? (
          <form
            className="orders-catalog__category-form"
            onSubmit={(e) => void onCreateCategory(e)}
          >
            <label className="field">
              <span className="field__label">Название категории</span>
              <input
                className="field__control"
                required
                value={categoryName}
                disabled={busy}
                onChange={(e) => setCategoryName(e.target.value)}
              />
            </label>
            <div className="client-dialog__actions">
              <button type="submit" className="button button--outline" disabled={busy}>
                Создать
              </button>
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setShowCategory(false)}
              >
                Отмена
              </button>
            </div>
          </form>
        ) : null}

        {categories.length ? (
          <p className="account-footnote">
            Категории: {categories.map((c) => c.name).join(", ")}
          </p>
        ) : null}

        {loading ? (
          <div className="clients-skeleton" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="clients-skeleton__row" />
            ))}
          </div>
        ) : !products.length ? (
          <div className="empty-state empty-state--compact">
            <p>Каталог пока пуст.</p>
            <p className="account-footnote">{emptyHint}</p>
            <button
              type="button"
              className="button button--primary"
              onClick={() => {
                setCreatingProduct(true);
                setEditingProductId(null);
              }}
            >
              Добавить первый товар
            </button>
          </div>
        ) : (
          <ul className="orders-product-grid">
            {products.map((p) => (
              <li key={p.id}>
                <ProductCard
                  product={p}
                  categoryName={categoryNameOf(p.category_id)}
                  busy={busy || editorOpen}
                  onEdit={() => {
                    setCreatingProduct(false);
                    setEditingProductId(p.id);
                    setError("");
                    setNotice("");
                  }}
                  onToggleActive={() => void toggleActive(p)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {editorOpen ? (
        <ProductEditorWizard
          businessId={businessId}
          categories={categories}
          productId={editingProductId}
          businessMode={businessMode}
          onCancel={() => {
            setCreatingProduct(false);
            setEditingProductId(null);
          }}
          onSaved={async () => {
            await reload();
            setCreatingProduct(false);
            setEditingProductId(null);
          }}
          onError={setError}
          onNotice={setNotice}
        />
      ) : null}
    </div>
  );
}
