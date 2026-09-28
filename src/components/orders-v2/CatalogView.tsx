"use client";

import { useEffect, useMemo, useState } from "react";
import { ProductCard } from "@/components/orders-v2/ProductCard";
import { ProductEditorWizard } from "@/components/orders-v2/ProductEditorWizard";
import {
  EMPTY_CATALOG_FILTERS,
  productStockLabel,
  type BusinessMode,
  type CatalogFilterValues,
  type ProductCategory,
  type ProductListItem,
} from "@/components/orders-v2/types";
import {
  createCategory,
  listCategories,
  listProducts,
  updateProduct,
} from "@/services/orders.service";

function stockStateOf(product: ProductListItem): string {
  const label = productStockLabel(product);
  if (!label || label === "Без учёта") return "untracked";
  if (label.startsWith("Нет")) return "out";
  if (label.startsWith("Мало")) return "low";
  if (label.startsWith("В наличии")) return "in_stock";
  return "untracked";
}

function matchesFilters(
  product: ProductListItem,
  filters: CatalogFilterValues,
): boolean {
  if (filters.visibility === "active" && !product.active) return false;
  if (filters.visibility === "hidden" && product.active) return false;
  if (filters.categoryId && product.category_id !== filters.categoryId)
    return false;
  if (filters.stock && stockStateOf(product) !== filters.stock) return false;
  const q = filters.search.trim().toLowerCase();
  if (q) {
    const hay = `${product.name} ${product.sku ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function CatalogView({
  businessId,
  businessMode,
  onCatalogChanged,
}: {
  businessId: string;
  businessMode: BusinessMode;
  onCatalogChanged?: () => void;
}) {
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [products, setProducts] = useState<ProductListItem[]>([]);
  const [filters, setFilters] = useState<CatalogFilterValues>({
    ...EMPTY_CATALOG_FILTERS,
  });
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
      onCatalogChanged?.();
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
      onCatalogChanged?.();
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

  const filtered = useMemo(
    () => products.filter((p) => matchesFilters(p, filters)),
    [products, filters],
  );

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

        <div className="orders-catalog__filters" aria-label="Фильтры каталога">
          <label className="field">
            <span className="field__label">Поиск</span>
            <input
              className="field__control"
              value={filters.search}
              onChange={(e) =>
                setFilters((f) => ({ ...f, search: e.target.value }))
              }
              placeholder="Название или SKU"
              disabled={busy || editorOpen}
            />
          </label>
          <label className="field">
            <span className="field__label">Видимость</span>
            <select
              className="field__control"
              value={filters.visibility}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  visibility: e.target.value as CatalogFilterValues["visibility"],
                }))
              }
              disabled={busy || editorOpen}
            >
              <option value="">Все</option>
              <option value="active">В продаже</option>
              <option value="hidden">Скрытые</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">Категория</span>
            <select
              className="field__control"
              value={filters.categoryId}
              onChange={(e) =>
                setFilters((f) => ({ ...f, categoryId: e.target.value }))
              }
              disabled={busy || editorOpen}
            >
              <option value="">Все категории</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">Остаток</span>
            <select
              className="field__control"
              value={filters.stock}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  stock: e.target.value as CatalogFilterValues["stock"],
                }))
              }
              disabled={busy || editorOpen}
            >
              <option value="">Все</option>
              <option value="in_stock">В наличии</option>
              <option value="low">Мало товара</option>
              <option value="out">Нет в наличии</option>
            </select>
          </label>
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
        ) : !filtered.length ? (
          <div className="empty-state empty-state--compact">
            <p>Ничего не найдено по фильтрам.</p>
            <button
              type="button"
              className="button button--outline"
              onClick={() => setFilters({ ...EMPTY_CATALOG_FILTERS })}
            >
              Сбросить фильтры
            </button>
          </div>
        ) : (
          <ul className="orders-product-grid">
            {filtered.map((p) => (
              <li key={p.id}>
                <ProductCard
                  businessId={businessId}
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
            onCatalogChanged?.();
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
