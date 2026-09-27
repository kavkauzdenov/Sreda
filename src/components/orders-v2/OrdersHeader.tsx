"use client";

import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import type { Business } from "@/types";
import type { OrdersTab } from "@/components/orders-v2/types";

const TAB_LABELS: Record<OrdersTab, string> = {
  orders: "Заказы",
  catalog: "Каталог",
  inventory: "Склад",
  settings: "Настройки",
};

export function OrdersHeader({
  businesses,
  currentBusiness,
  onSelectBusiness,
  onCreateOrder,
  tabs,
  activeTab,
  onTabChange,
  periodLabel,
}: {
  businesses: Business[];
  currentBusiness: Business | null;
  onSelectBusiness: (id: string) => void;
  onCreateOrder: () => void;
  tabs: OrdersTab[];
  activeTab: OrdersTab;
  onTabChange: (tab: OrdersTab) => void;
  periodLabel?: string;
}) {
  return (
    <header className="orders-page__heading">
      <div>
        <span className="eyebrow">Заказы</span>
        <h1>Приём заказов</h1>
        <p>
          Каталог, склад и обработка заказов.
          {periodLabel ? ` ${periodLabel}` : ""}
        </p>
      </div>
      <div className="orders-page__heading-actions">
        {activeTab === "orders" ? (
          <button
            type="button"
            className="button button--primary"
            disabled={!currentBusiness}
            onClick={onCreateOrder}
          >
            Создать заказ
          </button>
        ) : null}
        <BusinessSwitcher
          businesses={businesses}
          currentBusiness={currentBusiness}
          onSelect={onSelectBusiness}
        />
      </div>
      <nav className="orders-tabs" aria-label="Разделы заказов">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            className={
              activeTab === tab
                ? "button button--primary"
                : "button button--outline"
            }
            aria-pressed={activeTab === tab}
            onClick={() => onTabChange(tab)}
          >
            {TAB_LABELS[tab]}
          </button>
        ))}
      </nav>
    </header>
  );
}
