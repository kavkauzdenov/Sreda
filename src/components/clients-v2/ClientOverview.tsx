"use client";

import { useState } from "react";
import { ClientAssignee } from "@/components/clients-v2/ClientAssignee";
import { ClientDuplicateCard } from "@/components/clients-v2/ClientDuplicateCard";
import { ClientTags } from "@/components/clients-v2/ClientTags";
import type { ClientDetail } from "@/components/clients-v2/types";
import { clientAction } from "@/services/clients.service";
import { formatRelativeDateTimeInZone } from "@/lib/format";

function formatMoney(amount: string, currency: string): string {
  const value = Number(amount);
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: currency || "RUB",
      maximumFractionDigits: 2,
    }).format(Number.isFinite(value) ? value : 0);
  } catch {
    return `${amount} ${currency}`;
  }
}

export function ClientOverview({
  businessId,
  detail,
  timezone,
  canAssignOthers,
  canMerge,
  onRefresh,
  onOpenDuplicates,
}: {
  businessId: string;
  detail: ClientDetail;
  timezone: string;
  canAssignOthers: boolean;
  canMerge: boolean;
  onRefresh: () => void;
  onOpenDuplicates: () => void;
}) {
  const [profileDraft, setProfileDraft] = useState(
    detail.client.profileNote ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function saveProfileNote() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await clientAction(businessId, detail.client.id, {
        action: "profile_note",
        profileNote: profileDraft,
      });
      onRefresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить заметку.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="client-tab-panel client-overview">
      <ul className="client-overview__stats">
        <li>
          <span>Заявки</span>
          <strong>{detail.stats.leadCount}</strong>
        </li>
        <li>
          <span>Заказы</span>
          <strong>{detail.stats.orderCount}</strong>
        </li>
        <li>
          <span>Записи</span>
          <strong>{detail.stats.bookingCount}</strong>
        </li>
        <li>
          <span>Сообщения</span>
          <strong>{detail.stats.conversationCount}</strong>
        </li>
      </ul>

      {detail.stats.orderTotals.length ? (
        <section className="client-overview__section">
          <h3>Сумма заказов</h3>
          <ul className="client-entity-list">
            {detail.stats.orderTotals.map((row) => (
              <li key={row.currency}>
                <strong>{formatMoney(row.amount, row.currency)}</strong>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="client-overview__section">
        <h3>Ответственный</h3>
        <ClientAssignee
          businessId={businessId}
          clientId={detail.client.id}
          assignedUser={detail.assignedUser}
          canAssignOthers={canAssignOthers}
          onChanged={onRefresh}
        />
      </section>

      <section className="client-overview__section">
        <h3>Теги</h3>
        <ClientTags
          businessId={businessId}
          clientId={detail.client.id}
          tags={detail.tags}
          onChanged={onRefresh}
        />
      </section>

      <section className="client-overview__section">
        <h3>Профильная заметка</h3>
        <label className="field">
          <span className="sr-only">Профильная заметка</span>
          <textarea
            className="field__control"
            rows={3}
            value={profileDraft}
            onChange={(e) => setProfileDraft(e.target.value)}
          />
        </label>
        <button
          type="button"
          className="button button--outline"
          disabled={busy || profileDraft === (detail.client.profileNote ?? "")}
          onClick={() => void saveProfileNote()}
        >
          Сохранить заметку
        </button>
        {detail.latestNote ? (
          <p className="account-footnote">
            Последняя внутренняя: {detail.latestNote.text.slice(0, 120)}
            {detail.latestNote.text.length > 120 ? "…" : ""} ·{" "}
            {formatRelativeDateTimeInZone(detail.latestNote.createdAt, timezone)}
          </p>
        ) : null}
      </section>

      {detail.duplicateSummary.count > 0 ? (
        <ClientDuplicateCard
          summary={detail.duplicateSummary}
          canMerge={canMerge}
          onOpen={onOpenDuplicates}
        />
      ) : null}

      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
