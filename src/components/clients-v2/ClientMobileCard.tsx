"use client";

import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { formatRelativeDateTimeInZone, initialsFromName } from "@/lib/format";
import type { ClientListItem } from "@/components/clients-v2/types";
import type { Platform } from "@/types";

const CHANNEL_KINDS = new Set(["telegram", "vk", "whatsapp", "instagram"]);

export function ClientMobileCard({
  row,
  selected,
  timezone,
  onSelect,
}: {
  row: ClientListItem;
  selected: boolean;
  timezone: string;
  onSelect: (id: string) => void;
}) {
  const channels = row.identities
    .map((i) => i.kind)
    .filter((kind): kind is Platform => CHANNEL_KINDS.has(kind))
    .filter((kind, index, all) => all.indexOf(kind) === index);

  return (
    <button
      type="button"
      className={"client-mobile-card" + (selected ? " is-selected" : "")}
      aria-pressed={selected}
      onClick={() => onSelect(row.id)}
    >
      <span className="client-mobile-card__top">
        <span className="client-avatar" aria-hidden>
          {initialsFromName(row.name)}
        </span>
        <span className="clients-list__client">
          <strong>{row.name}</strong>
          <span>{row.phone || row.email || "Контакты не указаны"}</span>
        </span>
      </span>
      <span className="client-mobile-card__meta">
        {channels.map((platform) => (
          <PlatformBadge key={platform} platform={platform} compact />
        ))}
        <time dateTime={row.lastSeenAt}>
          {formatRelativeDateTimeInZone(
            row.lastActivity?.createdAt ?? row.lastSeenAt,
            timezone,
          )}
        </time>
        <span>
          З {row.leadCount} · Зк {row.orderCount} · Зп {row.bookingCount}
        </span>
      </span>
    </button>
  );
}
