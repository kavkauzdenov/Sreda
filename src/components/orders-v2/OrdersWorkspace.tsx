"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "next/navigation";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { SolutionSetupBanner } from "@/components/solutions/SolutionSetupBanner";
import { OrdersHeader } from "@/components/orders-v2/OrdersHeader";
import { OrdersSummaryCards } from "@/components/orders-v2/OrdersSummaryCards";
import { OrderFilters } from "@/components/orders-v2/OrderFilters";
import { OrderList } from "@/components/orders-v2/OrderList";
import { OrderDetail } from "@/components/orders-v2/OrderDetail";
import { CreateOrderDialog } from "@/components/orders-v2/CreateOrderDialog";
import { CatalogView } from "@/components/orders-v2/CatalogView";
import { InventoryView } from "@/components/orders-v2/InventoryView";
import { OrderSettingsView } from "@/components/orders-v2/OrderSettingsView";
import {
  EMPTY_ORDER_FILTERS,
  tabsForBusinessMode,
  type BusinessMode,
  type OrderFilterValues,
  type OrderListItem,
  type OrdersTab,
} from "@/components/orders-v2/types";
import {
  getOrderPage,
  getOrderSettings,
} from "@/services/orders.service";

type LayoutMode = "desktop" | "tablet" | "mobile";

function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("desktop");
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const mobile = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      if (mobile.matches) setMode("mobile");
      else if (desktop.matches) setMode("desktop");
      else setMode("tablet");
    };
    sync();
    desktop.addEventListener("change", sync);
    mobile.addEventListener("change", sync);
    return () => {
      desktop.removeEventListener("change", sync);
      mobile.removeEventListener("change", sync);
    };
  }, []);
  return mode;
}

function parseTab(raw: string | null, allowed: OrdersTab[]): OrdersTab {
  if (raw && allowed.includes(raw as OrdersTab)) return raw as OrdersTab;
  return "orders";
}

export function OrdersWorkspace() {
  const {
    businesses,
    currentBusiness,
    setCurrentBusinessId,
    isLoading,
    error,
    refreshBusinesses,
  } = useBusinessContext();
  const [createOpen, setCreateOpen] = useState(false);

  const role = currentBusiness?.role;
  const canAssignOthers = role === "owner" || role === "admin";

  return (
    <div className="orders-page">
      {error ? (
        <section className="panel">
          <p className="account-error" role="alert">
            {error}
          </p>
          <button
            className="button button--outline"
            onClick={() => void refreshBusinesses().catch(() => undefined)}
          >
            Обновить доступ
          </button>
        </section>
      ) : isLoading ? (
        <LoadingPanel label="Загружаем бизнес" />
      ) : currentBusiness ? (
        <Suspense fallback={<LoadingPanel label="Загружаем заказы" />}>
          <OrdersWorkspaceBody
            key={`${currentBusiness.id}:${currentBusiness.role}`}
            businesses={businesses}
            currentBusiness={currentBusiness}
            onSelectBusiness={setCurrentBusinessId}
            timezone={currentBusiness.timezone ?? "UTC"}
            canAssignOthers={canAssignOthers}
            createOpen={createOpen}
            onCreateOpenChange={setCreateOpen}
          />
        </Suspense>
      ) : (
        <>
          <OrdersHeader
            businesses={businesses}
            currentBusiness={null}
            onSelectBusiness={setCurrentBusinessId}
            onCreateOrder={() => undefined}
            tabs={["orders"]}
            activeTab="orders"
            onTabChange={() => undefined}
          />
          <p>Выберите бизнес.</p>
        </>
      )}
    </div>
  );
}

function OrdersWorkspaceBody({
  businesses,
  currentBusiness,
  onSelectBusiness,
  timezone,
  canAssignOthers,
  createOpen,
  onCreateOpenChange,
}: {
  businesses: Parameters<typeof OrdersHeader>[0]["businesses"];
  currentBusiness: NonNullable<
    Parameters<typeof OrdersHeader>[0]["currentBusiness"]
  >;
  onSelectBusiness: (id: string) => void;
  timezone: string;
  canAssignOthers: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  const businessId = currentBusiness.id;
  const searchParams = useSearchParams();
  const layout = useLayoutMode();

  const [businessMode, setBusinessMode] = useState<BusinessMode>("store");
  const allowedTabs = tabsForBusinessMode(businessMode);
  const [tab, setTab] = useState<OrdersTab>(() =>
    parseTab(searchParams.get("tab"), ["orders", "catalog", "inventory", "settings"]),
  );
  const activeTab = allowedTabs.includes(tab) ? tab : "orders";

  const [filters, setFilters] = useState<OrderFilterValues>({
    ...EMPTY_ORDER_FILTERS,
  });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{
    key: string;
    rows: OrderListItem[];
    cursor: string | null;
    more: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(
    () => searchParams.get("order") || null,
  );
  const [presetClientId, setPresetClientId] = useState<string | null>(
    () => searchParams.get("client") || null,
  );
  const [moreBusy, setMoreBusy] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    let alive = true;
    void getOrderSettings(businessId)
      .then((settings) => {
        if (!alive) return;
        setBusinessMode(settings.businessMode || "store");
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [businessId]);

  // Deep-link: ?client= opens create dialog once.
  useEffect(() => {
    if (presetClientId) onCreateOpenChange(true);
  }, [presetClientId, onCreateOpenChange]);

  // Keep shareable ?order= / ?tab= in sync.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const orderParam = url.searchParams.get("order");
    const tabParam = url.searchParams.get("tab");
    let dirty = false;
    if ((selected || null) !== (orderParam || null)) {
      if (selected) url.searchParams.set("order", selected);
      else url.searchParams.delete("order");
      dirty = true;
    }
    const desiredTab = activeTab === "orders" ? null : activeTab;
    if ((desiredTab || null) !== (tabParam || null)) {
      if (desiredTab) url.searchParams.set("tab", desiredTab);
      else url.searchParams.delete("tab");
      dirty = true;
    }
    if (!dirty) return;
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash,
    );
  }, [selected, activeTab]);

  const key = `${attempt}:${filters.search}:${filters.status}:${filters.source}:${filters.fulfillment}:${filters.date}:${filters.assignedUserId}`;

  useEffect(() => {
    if (activeTab !== "orders") return;
    const version = ++sequence.current;
    void getOrderPage(businessId, filters)
      .then((result) => {
        if (sequence.current !== version) return;
        setPage({
          key,
          rows: result.items,
          cursor: result.nextCursor,
          more: result.hasMore,
        });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (sequence.current === version)
          setFailure({
            key,
            message:
              e instanceof Error
                ? e.message
                : "Не удалось загрузить заказы.",
          });
      });
    return () => {
      sequence.current = version + 1;
    };
  }, [businessId, filters, key, activeTab]);

  const listError = failure?.key === key ? failure.message : null;
  const current = page?.key === key && !listError ? page : null;

  function refresh() {
    setMoreBusy(false);
    setAttempt((value) => value + 1);
  }

  async function more() {
    if (!current || moreBusy || !current.cursor) return;
    const version = sequence.current;
    setMoreBusy(true);
    try {
      const result = await getOrderPage(businessId, filters, current.cursor);
      if (version !== sequence.current) return;
      setPage({
        key,
        rows: [
          ...current.rows,
          ...result.items.filter(
            (row) => !current.rows.some((old) => old.id === row.id),
          ),
        ],
        cursor: result.nextCursor,
        more: result.hasMore,
      });
    } catch (e) {
      if (version === sequence.current)
        setFailure({
          key,
          message:
            e instanceof Error
              ? e.message
              : "Не удалось загрузить заказы.",
        });
    } finally {
      if (version === sequence.current) setMoreBusy(false);
    }
  }

  const showSidePanel = selected && layout === "desktop" && activeTab === "orders";
  const showOverlay = selected && layout !== "desktop" && activeTab === "orders";

  const periodLabel =
    filters.date === "today"
      ? "Период: сегодня"
      : filters.date === "7d"
        ? "Период: 7 дней"
        : filters.date === "30d"
          ? "Период: 30 дней"
          : undefined;

  return (
    <>
      <OrdersHeader
        businesses={businesses}
        currentBusiness={currentBusiness}
        onSelectBusiness={onSelectBusiness}
        onCreateOrder={() => {
          setPresetClientId(null);
          onCreateOpenChange(true);
        }}
        tabs={allowedTabs}
        activeTab={activeTab}
        onTabChange={(next) => {
          setSelected(null);
          setTab(next);
        }}
        periodLabel={periodLabel}
      />
      <SolutionSetupBanner code="orders" />

      {activeTab === "orders" ? (
        <>
          <OrdersSummaryCards businessId={businessId} />
          <OrderFilters
            businessId={businessId}
            value={filters}
            onChange={(next) => {
              setSelected(null);
              setFilters(next);
            }}
            onRefresh={refresh}
            disabled={moreBusy}
          />
          {listError ? (
            <section className="panel">
              <p className="account-error" role="alert">
                {listError}
              </p>
              <button
                type="button"
                className="button button--outline"
                onClick={refresh}
              >
                Попробовать ещё раз
              </button>
            </section>
          ) : (
            <div
              className={
                "clients-workspace" + (showSidePanel ? " has-detail" : "")
              }
            >
              <OrderList
                rows={current?.rows ?? []}
                selectedId={selected}
                timezone={timezone}
                loading={!current}
                hasMore={current?.more}
                moreBusy={moreBusy}
                onSelect={setSelected}
                onMore={() => void more()}
                onCreate={() => {
                  setPresetClientId(null);
                  onCreateOpenChange(true);
                }}
              />
              {showSidePanel ? (
                <OrderDetail
                  key={selected}
                  businessId={businessId}
                  orderId={selected!}
                  timezone={timezone}
                  canAssignOthers={canAssignOthers}
                  variant="panel"
                  onClose={() => setSelected(null)}
                  onListRefresh={refresh}
                />
              ) : null}
            </div>
          )}

          {showOverlay && typeof document !== "undefined"
            ? createPortal(
                <div
                  className="client-detail-overlay"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) setSelected(null);
                  }}
                >
                  <OrderDetail
                    key={selected}
                    businessId={businessId}
                    orderId={selected!}
                    timezone={timezone}
                    canAssignOthers={canAssignOthers}
                    variant={layout === "mobile" ? "dialog" : "drawer"}
                    onClose={() => setSelected(null)}
                    onListRefresh={refresh}
                  />
                </div>,
                document.body,
              )
            : null}
        </>
      ) : null}

      {activeTab === "catalog" ? (
        <CatalogView businessId={businessId} businessMode={businessMode} />
      ) : null}
      {activeTab === "inventory" ? (
        <InventoryView businessId={businessId} />
      ) : null}
      {activeTab === "settings" ? (
        <OrderSettingsView
          businessId={businessId}
          canEdit={canAssignOthers}
          onModeChange={(mode) => setBusinessMode(mode)}
        />
      ) : null}

      {createOpen ? (
        <CreateOrderDialog
          businessId={businessId}
          presetClientId={presetClientId}
          onClose={() => {
            onCreateOpenChange(false);
            setPresetClientId(null);
            if (typeof window !== "undefined") {
              const url = new URL(window.location.href);
              if (url.searchParams.has("client")) {
                url.searchParams.delete("client");
                window.history.replaceState(
                  window.history.state,
                  "",
                  url.pathname + url.search + url.hash,
                );
              }
            }
          }}
          onCreated={(id) => {
            onCreateOpenChange(false);
            setPresetClientId(null);
            setTab("orders");
            setSelected(id);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
