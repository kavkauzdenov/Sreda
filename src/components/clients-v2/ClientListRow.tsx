"use client";

import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { formatRelativeDateTimeInZone, initialsFromName } from "@/lib/format";
import type { ClientListItem } from "@/components/clients-v2/types";
import type { Platform } from "@/types";

const CHANNEL_KINDS = new Set(["telegram", "vk", "whatsapp", "instagram"]);

function channelsOf(row: ClientListItem): Platform[] {
  const found: Platform[] = [];
  for (const identity of row.identities) {
    if (CHANNEL_KINDS.has(identity.kind)) {
      const platform = identity.kind as Platform;
      if (!found.includes(platform)) found.push(platform);
    }
  }
  return found;
}

export function ClientListRow({
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
  const channels = channelsOf(row);
  const activity = row.lastActivity
    ? `${row.lastActivity.title} · ${formatRelativeDateTimeInZone(row.lastActivity.createdAt, timezone)}`
    : formatRelativeDateTimeInZone(row.lastSeenAt, timezone);

  return (
    <tr
      className={"clients-list__row" + (selected ? " is-selected" : "")}
      aria-selected={selected}
      tabIndex={0}
      onClick={() => onSelect(row.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(row.id);
        }
      }}
    >
      <td>
        <span className="clients-list__client">
          <span className="client-avatar" aria-hidden>
            {initialsFromName(row.name)}
          </span>
          <span>
            <strong>{row.name}</strong>
            {row.assignedUser ? (
              <span>{row.assignedUser.name}</span>
            ) : null}
          </span>
        </span>
      </td>
      <td>
        <span className="clients-list__contacts">
          {row.phone ? <span>{row.phone}</span> : null}
          {row.email ? <span>{row.email}</span> : null}
          {!row.phone && !row.email ? <span>—</span> : null}
        </span>
      </td>
      <td>
        <span className="clients-list__channels">
          {channels.length
            ? channels.map((platform) => (
                <PlatformBadge key={platform} platform={platform} compact />
              ))
            : "—"}
        </span>
      </td>
      <td>
        <span title={activity}>{activity}</span>
      </td>
      <td>{row.leadCount}</td>
      <td>{row.orderCount}</td>
      <td>{row.bookingCount}</td>
    </tr>
  );
}
