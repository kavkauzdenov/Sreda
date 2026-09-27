"use client";

import { formatRelativeDateTimeInZone, initialsFromName } from "@/lib/format";
import type { ClientDetail } from "@/components/clients-v2/types";

export function ClientDetailHeader({
  detail,
  timezone,
  onClose,
}: {
  detail: ClientDetail;
  timezone: string;
  onClose: () => void;
}) {
  const { client, stats } = detail;
  return (
    <div className="client-detail__head">
      <div className="client-detail__identity">
        <span className="client-avatar client-avatar--lg" aria-hidden>
          {initialsFromName(client.name)}
        </span>
        <div>
          <h2>{client.name}</h2>
          <p className="client-detail__status">
            <span
              className={
                "client-detail__status-dot" +
                (stats.openConversation ? " is-open" : "")
              }
              aria-hidden
            />
            {stats.openConversation
              ? "Есть открытое обращение"
              : "Нет открытых обращений"}
          </p>
          <p className="account-footnote">
            Первый контакт:{" "}
            {formatRelativeDateTimeInZone(client.firstSeenAt, timezone)}
          </p>
        </div>
      </div>
      <button
        type="button"
        className="button button--outline"
        onClick={onClose}
        aria-label="Закрыть карточку"
      >
        Закрыть
      </button>
    </div>
  );
}
