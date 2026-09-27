"use client";

import {
  ClientEntityLink,
  ClientTabShell,
  formatTabWhen,
  useClientTabPage,
} from "@/components/clients-v2/clientTabUtils";

export function ClientOrders({
  businessId,
  clientId,
  timezone,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
}) {
  const state = useClientTabPage(businessId, clientId, "orders");
  return (
    <ClientTabShell
      empty="Заказов пока нет."
      error={state.error}
      items={state.items}
      hasMore={state.hasMore}
      busy={state.busy}
      onMore={() => void state.more()}
    >
      {(items) => (
        <ul className="client-entity-list">
          {items.map((row) => (
            <li key={row.id}>
              <strong>
                <ClientEntityLink href={row.targetPath}>
                  Заказ{row.number != null ? ` №${row.number}` : ""}
                </ClientEntityLink>
              </strong>
              <span>
                {row.status}
                {row.total != null
                  ? ` · ${row.total} ${row.currency ?? ""}`
                  : ""}
              </span>
              <small>{formatTabWhen(row.createdAt, timezone)}</small>
            </li>
          ))}
        </ul>
      )}
    </ClientTabShell>
  );
}
