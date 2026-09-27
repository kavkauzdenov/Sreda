"use client";
import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { apiRequest } from "@/lib/apiClient";
import { formatMoney } from "@/lib/money";
import { DetailDialog } from "@/components/dashboard/DetailDialog";
import {
  EmptyStateCta,
  SolutionSetupBanner,
} from "@/components/solutions/SolutionSetupBanner";
import { ProductEditor } from "@/components/orders/ProductEditor";

type OrderRow = {
  id: string;
  order_number: number | null;
  status: string;
  fulfillment: string;
  customer_name: string;
  customer_phone: string;
  total: string;
  currency: string;
  client_id: string;
  client_name?: string;
  conversation_id: string | null;
  created_at: string;
};

type OrderItem = {
  id: string;
  name: string;
  variant_label: string;
  quantity: number;
  unit_price: string;
  line_total: string;
};

type StatusHistory = {
  id: string;
  from_status: string | null;
  to_status: string;
  note: string;
  created_at: string;
};

type OrderDetail = OrderRow & {
  delivery_address?: string;
  comment?: string;
  items: OrderItem[];
  history: StatusHistory[];
};

type Category = {
  id: string;
  name: string;
  description: string;
  active: boolean;
  position: number;
};

type Product = {
  id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  sku: string | null;
  active: boolean;
  category_id: string | null;
  use_variants: boolean;
  variant_prices_enabled?: boolean;
  track_inventory: boolean;
  availability: string;
  stock_quantity: number | null;
};

const STATUS_LABEL: Record<string, string> = {
  new: "Новый",
  accepted: "Принят",
  assembling: "Сборка",
  ready: "Готов",
  handed_over: "Выдан",
  delivered: "Доставлен",
  completed: "Завершён",
  cancelled: "Отменён",
};

const STATUS_FLOW: Record<string, string[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["assembling", "cancelled"],
  assembling: ["ready", "cancelled"],
  ready: ["handed_over", "delivered", "cancelled"],
  handed_over: ["completed"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
};

export function OrdersView() {
  const { currentBusiness } = useBusinessContext();
  return currentBusiness ? (
    <Orders
      key={currentBusiness.id}
      businessId={currentBusiness.id}
      timezone={currentBusiness.timezone ?? "UTC"}
    />
  ) : (
    <p>Выберите бизнес.</p>
  );
}

function Orders({
  businessId,
  timezone,
}: {
  businessId: string;
  timezone: string;
}) {
  const search = useSearchParams();
  const [manualTab, setManualTab] = useState<"orders" | "catalog" | null>(null);
  const tab =
    manualTab ?? (search.get("tab") === "catalog" ? "catalog" : "orders");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  return (
    <div className="crm-page">
      <header>
        <h1>Приём заказов</h1>
        <p>Каталог, товары и обработка заказов из бота.</p>
      </header>
      <SolutionSetupBanner code="orders" />
      <section className="panel crm-panel">
        <nav className="crm-segment" aria-label="Разделы заказов">
          <button
            type="button"
            className={
              tab === "orders" ? "button button--primary" : "button button--outline"
            }
            aria-pressed={tab === "orders"}
            onClick={() => {
              setManualTab("orders");
              setError("");
              setNotice("");
            }}
          >
            Заказы
          </button>
          <button
            type="button"
            className={
              tab === "catalog"
                ? "button button--primary"
                : "button button--outline"
            }
            aria-pressed={tab === "catalog"}
            onClick={() => {
              setManualTab("catalog");
              setError("");
              setNotice("");
            }}
          >
            Каталог
          </button>
        </nav>
      </section>
      {error && (
        <p role="alert" className="account-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="account-notice">
          {notice}
        </p>
      )}
      {tab === "orders" ? (
        <OrdersPanel
          businessId={businessId}
          timezone={timezone}
          onError={setError}
          onNotice={setNotice}
        />
      ) : (
        <CatalogPanel
          businessId={businessId}
          onError={setError}
          onNotice={setNotice}
        />
      )}
    </div>
  );
}

function OrdersPanel({
  businessId,
  timezone,
  onError,
  onNotice,
}: {
  businessId: string;
  timezone: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [deepLinked, setDeepLinked] = useState(false);
  const search = useSearchParams();
  const base = `/api/v1/businesses/${businessId}/orders`;

  useEffect(() => {
    if (deepLinked) return;
    const fromQuery = search.get("order") || "";
    if (fromQuery) {
      setSelected(fromQuery);
      setDeepLinked(true);
    }
  }, [search, deepLinked]);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setLoading(true);
      void apiRequest<OrderRow[]>(
        base + (status ? "?status=" + encodeURIComponent(status) : ""),
      )
        .then((rows) => {
          if (alive) {
            setOrders(rows);
            onError("");
          }
        })
        .catch((e) => {
          if (alive)
            onError(e instanceof Error ? e.message : "Ошибка загрузки.");
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [base, status, onError]);

  useEffect(() => {
    let alive = true;
    if (!selected) {
      const timer = setTimeout(() => {
        if (alive) setDetail(null);
      }, 0);
      return () => {
        alive = false;
        clearTimeout(timer);
      };
    }
    void apiRequest<OrderDetail>(base + "/" + selected)
      .then((row) => {
        if (alive) setDetail(row);
      })
      .catch((e) => {
        if (alive) {
          onError(e instanceof Error ? e.message : "Не удалось открыть заказ.");
          setSelected(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [base, selected, onError]);

  async function transition(next: string) {
    if (!selected || busy) return;
    setBusy(true);
    onError("");
    onNotice("");
    try {
      await apiRequest(base + "/" + selected, {
        method: "PATCH",
        body: JSON.stringify({ status: next }),
      });
      const updated = await apiRequest<OrderDetail>(base + "/" + selected);
      setDetail(updated);
      setOrders((rows) =>
        rows.map((row) =>
          row.id === selected ? { ...row, status: updated.status } : row,
        ),
      );
      onNotice("Статус заказа обновлён.");
    } catch (e) {
      onError(e instanceof Error ? e.message : "Не удалось сменить статус.");
    } finally {
      setBusy(false);
    }
  }

  const nextStatuses = detail ? (STATUS_FLOW[detail.status] ?? []) : [];

  return (
    <>
      <section className="panel crm-panel">
        <label>
          Статус
          <select
            value={status}
            disabled={busy}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Все</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {loading ? (
          <p role="status">Загрузка…</p>
        ) : !orders.length ? (
          <EmptyStateCta
            title="Заказов пока нет"
            description="Когда клиенты оформят заказ в боте, он появится здесь. Сначала добавьте товары в каталог."
            href="/orders?tab=catalog"
            action="Открыть каталог"
          />
        ) : (
          <ul className="crm-list">
            {orders.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  disabled={busy}
                  aria-pressed={selected === o.id}
                  onClick={() => {
                    setSelected(o.id);
                    onError("");
                    onNotice("");
                  }}
                >
                  <strong>
                    {o.order_number != null ? `№${o.order_number} · ` : ""}
                    {o.customer_name} · {STATUS_LABEL[o.status] ?? o.status}
                  </strong>
                  <span>
                    {formatMoney(o.total, o.currency)} ·{" "}
                    {o.fulfillment === "delivery" ? "Доставка" : "Самовывоз"}
                  </span>
                  <small>
                    {new Date(o.created_at).toLocaleString("ru", {
                      timeZone: timezone,
                    })}
                  </small>
                  <span>
                    <Link href="/clients" onClick={(e) => e.stopPropagation()}>
                      Клиент
                    </Link>
                    {o.conversation_id ? (
                      <>
                        {" · "}
                        <Link
                          href="/messages"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Диалог
                        </Link>
                      </>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {detail && (
        <DetailDialog
          title={
            "Заказ" +
            (detail.order_number != null ? " №" + detail.order_number : "") +
            " · " +
            (STATUS_LABEL[detail.status] ?? detail.status)
          }
          onClose={() => setSelected(null)}
        >
          <div className="detail-facts">
            <span>Клиент</span>
            <strong>{detail.customer_name}</strong>
          </div>
          <div className="detail-facts">
            <span>Телефон</span>
            <strong>{detail.customer_phone}</strong>
          </div>
          <div className="detail-facts">
            <span>Сумма</span>
            <strong>{formatMoney(detail.total, detail.currency)}</strong>
          </div>
          <div className="detail-facts">
            <span>Получение</span>
            <strong>
              {detail.fulfillment === "delivery" ? "Доставка" : "Самовывоз"}
            </strong>
          </div>
          {detail.delivery_address ? (
            <div className="detail-facts">
              <span>Адрес</span>
              <strong>{detail.delivery_address}</strong>
            </div>
          ) : null}
          {detail.comment ? (
            <p className="message-preview">{detail.comment}</p>
          ) : null}
          <nav aria-label="Связь с клиентом">
            <Link className="button button--outline" href="/clients">
              Клиент
            </Link>
            {detail.conversation_id ? (
              <Link className="button button--outline" href="/messages">
                Диалог
              </Link>
            ) : null}
            <Link className="button button--primary" href="/messages">
              Связаться
            </Link>
          </nav>
          {detail.items?.length ? (
            <>
              <h3>Позиции</h3>
              <ul className="crm-list">
                {detail.items.map((item) => (
                  <li key={item.id}>
                    <strong>
                      {item.name}
                      {item.variant_label ? " · " + item.variant_label : ""}
                    </strong>
                    <span>
                      {item.quantity} ×{" "}
                      {formatMoney(item.unit_price, detail.currency)} ={" "}
                      {formatMoney(item.line_total, detail.currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {nextStatuses.length ? (
            <fieldset disabled={busy}>
              <legend>Сменить статус</legend>
              <nav aria-label="Переходы статуса">
                {nextStatuses.map((next) => (
                  <button
                    key={next}
                    type="button"
                    className={
                      next === "cancelled"
                        ? "button button--outline"
                        : "button button--primary"
                    }
                    onClick={() => void transition(next)}
                  >
                    {STATUS_LABEL[next] ?? next}
                  </button>
                ))}
              </nav>
            </fieldset>
          ) : (
            <p className="account-footnote">Дальнейших переходов нет.</p>
          )}
          {detail.history?.length ? (
            <>
              <h3>История статусов</h3>
              <ul className="crm-list">
                {detail.history.map((row) => (
                  <li key={row.id}>
                    <strong>
                      {(row.from_status
                        ? (STATUS_LABEL[row.from_status] ?? row.from_status) +
                          " → "
                        : "") + (STATUS_LABEL[row.to_status] ?? row.to_status)}
                    </strong>
                    <small>
                      {new Date(row.created_at).toLocaleString("ru", {
                        timeZone: timezone,
                      })}
                    </small>
                    {row.note ? <span>{row.note}</span> : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </DetailDialog>
      )}
    </>
  );
}

function CatalogPanel({
  businessId,
  onError,
  onNotice,
}: {
  businessId: string;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showCategory, setShowCategory] = useState(false);
  const [editingProductId, setEditingProductId] = useState<string | null>(
    null,
  );
  const [creatingProduct, setCreatingProduct] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const categoriesBase = `/api/v1/businesses/${businessId}/categories`;
  const productsBase = `/api/v1/businesses/${businessId}/products`;

  async function reload() {
    const [cats, rows] = await Promise.all([
      apiRequest<Category[]>(categoriesBase),
      apiRequest<Product[]>(productsBase),
    ]);
    setCategories(cats);
    setProducts(rows);
  }

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setLoading(true);
      void Promise.all([
        apiRequest<Category[]>(categoriesBase),
        apiRequest<Product[]>(productsBase),
      ])
        .then(([cats, rows]) => {
          if (!alive) return;
          setCategories(cats);
          setProducts(rows);
          onError("");
        })
        .catch((e) => {
          if (alive)
            onError(
              e instanceof Error ? e.message : "Ошибка загрузки каталога.",
            );
        })
        .finally(() => {
          if (alive) setLoading(false);
        });
    }, 0);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [categoriesBase, productsBase, onError]);

  async function createCategory(e: FormEvent) {
    e.preventDefault();
    if (busy || !categoryName.trim()) return;
    setBusy(true);
    onError("");
    onNotice("");
    try {
      await apiRequest(categoriesBase, {
        method: "POST",
        body: JSON.stringify({ name: categoryName.trim(), active: true }),
      });
      setCategoryName("");
      setShowCategory(false);
      await reload();
      onNotice("Категория создана.");
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Не удалось создать категорию.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(product: Product) {
    if (busy) return;
    setBusy(true);
    onError("");
    onNotice("");
    try {
      await apiRequest(productsBase + "/" + product.id, {
        method: "PATCH",
        body: JSON.stringify({
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
        }),
      });
      await reload();
      onNotice(product.active ? "Товар скрыт." : "Товар активирован.");
    } catch (err) {
      onError(
        err instanceof Error ? err.message : "Не удалось обновить товар.",
      );
    } finally {
      setBusy(false);
    }
  }

  const categoryNameOf = (id: string | null) =>
    categories.find((c) => c.id === id)?.name ?? "Без категории";

  const editorOpen = creatingProduct || editingProductId != null;

  return (
    <div className="crm-columns">
      <section className="panel crm-panel">
        <h2>Категории</h2>
        {loading ? (
          <p role="status">Загрузка…</p>
        ) : !categories.length ? (
          <p className="account-footnote">Категорий пока нет.</p>
        ) : (
          <ul className="crm-list">
            {categories.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong>
                <span>{c.active ? "Активна" : "Скрыта"}</span>
                {c.description ? <small>{c.description}</small> : null}
              </li>
            ))}
          </ul>
        )}
        <h2>Товары</h2>
        {loading ? (
          <p role="status">Загрузка…</p>
        ) : !products.length ? (
          <p className="account-footnote">Товаров пока нет.</p>
        ) : (
          <ul className="crm-list product-card-list">
            {products.map((p) => (
              <li key={p.id} className="product-card">
                <div className="product-card__title">{p.name}</div>
                <div className="product-card__price">
                  {formatMoney(p.price, p.currency || "RUB")}
                </div>
                <div className="product-card__meta">
                  <span>{categoryNameOf(p.category_id)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{p.active ? "Активен" : "Скрыт"}</span>
                </div>
                {p.description ? (
                  <p className="product-card__desc">{p.description}</p>
                ) : null}
                <div className="product-card__actions">
                  <button
                    type="button"
                    className="button button--outline"
                    disabled={busy || editorOpen}
                    onClick={() => {
                      setCreatingProduct(false);
                      setEditingProductId(p.id);
                      onError("");
                      onNotice("");
                    }}
                  >
                    Изменить
                  </button>
                  <button
                    type="button"
                    className="button button--outline"
                    disabled={busy || editorOpen}
                    onClick={() => void toggleActive(p)}
                  >
                    {p.active ? "Скрыть" : "Активировать"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel crm-panel catalog-create">
        {!showCategory ? (
          <button
            className="button button--outline"
            type="button"
            onClick={() => setShowCategory(true)}
          >
            + Добавить категорию
          </button>
        ) : (
          <form id="new-category" onSubmit={(e) => void createCategory(e)}>
            <h2>Новая категория</h2>
            <fieldset disabled={busy}>
              <label>
                Название
                <input
                  required
                  value={categoryName}
                  onChange={(e) => setCategoryName(e.target.value)}
                />
              </label>
              <div className="catalog-create__actions">
                <button className="button button--outline" type="submit">
                  Создать категорию
                </button>
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => setShowCategory(false)}
                >
                  Закрыть
                </button>
              </div>
            </fieldset>
          </form>
        )}
        {!editorOpen ? (
          <button
            className="button button--primary"
            type="button"
            onClick={() => {
              setEditingProductId(null);
              setCreatingProduct(true);
              onError("");
              onNotice("");
            }}
          >
            + Добавить товар
          </button>
        ) : (
          <ProductEditor
            businessId={businessId}
            categories={categories}
            productId={editingProductId}
            onCancel={() => {
              setCreatingProduct(false);
              setEditingProductId(null);
            }}
            onSaved={async () => {
              await reload();
              setCreatingProduct(false);
              setEditingProductId(null);
            }}
            onError={onError}
            onNotice={onNotice}
          />
        )}
      </section>
    </div>
  );
}
