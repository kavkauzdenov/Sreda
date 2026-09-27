"use client";

import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import type { Business } from "@/types";

export function ClientsHeader({
  businesses,
  currentBusiness,
  onSelectBusiness,
  onNewClient,
}: {
  businesses: Business[];
  currentBusiness: Business | null;
  onSelectBusiness: (id: string) => void;
  onNewClient: () => void;
}) {
  return (
    <header className="clients-page__heading">
      <div>
        <span className="eyebrow">CRM</span>
        <h1>Клиенты</h1>
        <p>Контакты, история и обращения в одном рабочем месте.</p>
      </div>
      <div className="clients-page__heading-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={!currentBusiness}
          onClick={onNewClient}
        >
          + Новый клиент
        </button>
        <BusinessSwitcher
          businesses={businesses}
          currentBusiness={currentBusiness}
          onSelect={onSelectBusiness}
        />
      </div>
    </header>
  );
}
