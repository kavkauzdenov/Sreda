"use client";

import type { ClientDetail, ClientDetailTab } from "@/components/clients-v2/types";

const TABS: { id: ClientDetailTab; label: string; countKey?: keyof ClientDetail["stats"] }[] = [
  { id: "overview", label: "Обзор" },
  { id: "timeline", label: "История" },
  { id: "leads", label: "Заявки", countKey: "leadCount" },
  { id: "orders", label: "Заказы", countKey: "orderCount" },
  { id: "bookings", label: "Записи", countKey: "bookingCount" },
  { id: "conversations", label: "Сообщения", countKey: "conversationCount" },
  { id: "notes", label: "Заметки", countKey: "noteCount" },
];

export function ClientTabs({
  active,
  stats,
  onChange,
}: {
  active: ClientDetailTab;
  stats: ClientDetail["stats"];
  onChange: (tab: ClientDetailTab) => void;
}) {
  return (
    <div className="client-tabs" role="tablist" aria-label="Разделы карточки">
      {TABS.map((tab) => {
        const count =
          tab.countKey != null ? Number(stats[tab.countKey] ?? 0) : null;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            className={active === tab.id ? "is-active" : undefined}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
            {count != null ? ` ${count}` : ""}
          </button>
        );
      })}
    </div>
  );
}
