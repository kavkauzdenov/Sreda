"use client";

import { PlatformBadge } from "@/components/ui/PlatformBadge";
import {
  ClientEntityLink,
  ClientTabShell,
  formatTabWhen,
  useClientTabPage,
} from "@/components/clients-v2/clientTabUtils";
import type { Platform } from "@/types";

export function ClientConversations({
  businessId,
  clientId,
  timezone,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
}) {
  const state = useClientTabPage(businessId, clientId, "conversations");
  return (
    <ClientTabShell
      empty="Сообщений пока нет."
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
                <ClientEntityLink href={row.targetPath}>Диалог</ClientEntityLink>{" "}
                {row.platform ? (
                  <PlatformBadge platform={row.platform as Platform} compact />
                ) : null}
              </strong>
              <span>{row.status}</span>
              <small>{formatTabWhen(row.updatedAt, timezone)}</small>
            </li>
          ))}
        </ul>
      )}
    </ClientTabShell>
  );
}
