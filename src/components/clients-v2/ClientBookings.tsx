"use client";

import {
  ClientEntityLink,
  ClientTabShell,
  formatTabWhen,
  useClientTabPage,
} from "@/components/clients-v2/clientTabUtils";

export function ClientBookings({
  businessId,
  clientId,
  timezone,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
}) {
  const state = useClientTabPage(businessId, clientId, "bookings");
  return (
    <ClientTabShell
      empty="Записей пока нет."
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
                  {row.serviceName || "Запись"}
                </ClientEntityLink>
              </strong>
              <span>
                {row.specialistName} · {row.status}
              </span>
              <small>{formatTabWhen(row.startsAt, timezone)}</small>
            </li>
          ))}
        </ul>
      )}
    </ClientTabShell>
  );
}
