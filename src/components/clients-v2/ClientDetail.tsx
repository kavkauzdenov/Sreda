"use client";

import { useEffect, useRef, useState } from "react";
import { ClientDetailHeader } from "@/components/clients-v2/ClientDetailHeader";
import { ClientQuickActions } from "@/components/clients-v2/ClientQuickActions";
import { ClientTabs } from "@/components/clients-v2/ClientTabs";
import { ClientOverview } from "@/components/clients-v2/ClientOverview";
import { ClientTimeline } from "@/components/clients-v2/ClientTimeline";
import { ClientLeads } from "@/components/clients-v2/ClientLeads";
import { ClientOrders } from "@/components/clients-v2/ClientOrders";
import { ClientBookings } from "@/components/clients-v2/ClientBookings";
import { ClientConversations } from "@/components/clients-v2/ClientConversations";
import { ClientNotes } from "@/components/clients-v2/ClientNotes";
import { ClientEditorDialog } from "@/components/clients-v2/ClientEditorDialog";
import { ClientDuplicateDialog } from "@/components/clients-v2/ClientDuplicateDialog";
import { getClientDetail } from "@/services/clients.service";
import type {
  ClientDetail as ClientDetailData,
  ClientDetailTab,
} from "@/components/clients-v2/types";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import type { Platform } from "@/types";

export function ClientDetail({
  businessId,
  clientId,
  timezone,
  canMerge,
  canAssignOthers,
  variant = "panel",
  onClose,
  onMerged,
  onListRefresh,
}: {
  businessId: string;
  clientId: string;
  timezone: string;
  canMerge: boolean;
  canAssignOthers: boolean;
  variant?: "panel" | "drawer" | "dialog";
  onClose: () => void;
  onMerged: (targetId: string) => void;
  onListRefresh?: () => void;
}) {
  const [detail, setDetail] = useState<ClientDetailData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ClientDetailTab>("overview");
  const [editOpen, setEditOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setLoading(true);
      setError("");
    });
    void getClientDetail(businessId, clientId)
      .then((data) => {
        if (!active) return;
        setDetail(data);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setDetail(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить клиента.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [businessId, clientId, refreshKey]);

  useEffect(() => {
    if (variant === "panel") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [variant, onClose]);

  useEffect(() => {
    if (variant === "panel") return;
    rootRef.current
      ?.querySelector<HTMLElement>("button, [href], input, select, textarea")
      ?.focus();
  }, [variant, clientId]);

  function refresh() {
    setRefreshKey((v) => v + 1);
    onListRefresh?.();
  }

  const className =
    variant === "dialog"
      ? "client-detail client-detail--dialog"
      : variant === "drawer"
        ? "client-detail client-detail--drawer"
        : "panel client-detail";

  if (loading) {
    return (
      <section className={className} aria-busy="true" ref={rootRef}>
        <div className="clients-skeleton">
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
          <div className="clients-skeleton__row" />
        </div>
      </section>
    );
  }

  if (error || !detail) {
    return (
      <section className={className} ref={rootRef}>
        <p className="account-error" role="alert">
          {error || "Клиент не найден."}
        </p>
        <button type="button" className="button button--outline" onClick={onClose}>
          Закрыть
        </button>
        <button
          type="button"
          className="button button--outline"
          onClick={refresh}
        >
          Попробовать ещё раз
        </button>
      </section>
    );
  }

  return (
    <section
      className={className}
      ref={rootRef}
      aria-label={`Клиент ${detail.client.name}`}
    >
      <ClientDetailHeader
        detail={detail}
        timezone={timezone}
        onClose={onClose}
      />
      <div className="client-detail__contacts">
        {detail.client.phone ? <p>Телефон: {detail.client.phone}</p> : null}
        {detail.client.email ? <p>Email: {detail.client.email}</p> : null}
        {detail.identities.map((identity) => (
          <p key={`${identity.kind}:${identity.value}`}>
            {["telegram", "vk", "whatsapp", "instagram"].includes(
              identity.kind,
            ) ? (
              <PlatformBadge platform={identity.kind as Platform} compact />
            ) : (
              <span>{identity.kind}</span>
            )}{" "}
            {identity.username ? `@${identity.username}` : identity.value}
          </p>
        ))}
      </div>
      <ClientQuickActions
        businessId={businessId}
        detail={detail}
        onRefresh={refresh}
        onEdit={() => setEditOpen(true)}
        onOpenDuplicates={() => setDupOpen(true)}
      />
      <ClientTabs active={tab} stats={detail.stats} onChange={setTab} />
      {tab === "overview" ? (
        <ClientOverview
          businessId={businessId}
          detail={detail}
          timezone={timezone}
          canAssignOthers={canAssignOthers}
          canMerge={canMerge}
          onRefresh={refresh}
          onOpenDuplicates={() => setDupOpen(true)}
        />
      ) : null}
      {tab === "timeline" ? (
        <ClientTimeline
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
        />
      ) : null}
      {tab === "leads" ? (
        <ClientLeads
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
        />
      ) : null}
      {tab === "orders" ? (
        <ClientOrders
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
        />
      ) : null}
      {tab === "bookings" ? (
        <ClientBookings
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
        />
      ) : null}
      {tab === "conversations" ? (
        <ClientConversations
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
        />
      ) : null}
      {tab === "notes" ? (
        <ClientNotes
          businessId={businessId}
          clientId={clientId}
          timezone={timezone}
          onChanged={refresh}
        />
      ) : null}

      {editOpen ? (
        <ClientEditorDialog
          businessId={businessId}
          detail={detail}
          canAssignOthers={canAssignOthers}
          onClose={() => setEditOpen(false)}
          onSaved={refresh}
        />
      ) : null}
      {dupOpen ? (
        <ClientDuplicateDialog
          businessId={businessId}
          detail={detail}
          canMerge={canMerge}
          onClose={() => setDupOpen(false)}
          onMerged={(targetId) => {
            setDupOpen(false);
            onMerged(targetId);
          }}
          onDecided={refresh}
        />
      ) : null}
    </section>
  );
}
