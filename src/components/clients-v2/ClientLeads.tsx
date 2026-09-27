"use client";

import {
  ClientEntityLink,
  ClientTabShell,
  formatTabWhen,
  useClientTabPage,
} from "@/components/clients-v2/clientTabUtils";

export function ClientLeads({
  businessId,
  clientId,
  timezone,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
}) {
  const state = useClientTabPage(businessId, clientId, "leads");
  return (
    <ClientTabShell
      empty="Заявок пока нет."
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
                  {row.name || "Заявка"}
                </ClientEntityLink>
              </strong>
              <span>{row.status}</span>
              <small>{formatTabWhen(row.createdAt, timezone)}</small>
            </li>
          ))}
        </ul>
      )}
    </ClientTabShell>
  );
}
