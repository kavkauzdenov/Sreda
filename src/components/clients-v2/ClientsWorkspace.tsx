"use client";

import { useEffect, useRef, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { ClientsHeader } from "@/components/clients-v2/ClientsHeader";
import { ClientSummaryCards } from "@/components/clients-v2/ClientSummaryCards";
import { ClientFilters } from "@/components/clients-v2/ClientFilters";
import { ClientList } from "@/components/clients-v2/ClientList";
import { ClientDetail } from "@/components/clients-v2/ClientDetail";
import { NewClientDialog } from "@/components/clients-v2/NewClientDialog";
import {
  EMPTY_CLIENT_FILTERS,
  type ClientFilterValues,
  type ClientListItem,
} from "@/components/clients-v2/types";
import { getClientPage } from "@/services/clients.service";

type LayoutMode = "desktop" | "tablet" | "mobile";

function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>("desktop");
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1280px)");
    const mobile = window.matchMedia("(max-width: 900px)");
    const sync = () => {
      if (mobile.matches) setMode("mobile");
      else if (desktop.matches) setMode("desktop");
      else setMode("tablet");
    };
    sync();
    desktop.addEventListener("change", sync);
    mobile.addEventListener("change", sync);
    return () => {
      desktop.removeEventListener("change", sync);
      mobile.removeEventListener("change", sync);
    };
  }, []);
  return mode;
}

export function ClientsWorkspace() {
  const {
    businesses,
    currentBusiness,
    setCurrentBusinessId,
    isLoading,
    error,
    refreshBusinesses,
  } = useBusinessContext();
  const [newOpen, setNewOpen] = useState(false);

  const role = currentBusiness?.role;
  const canMerge = role === "owner" || role === "admin";
  const canAssignOthers = role === "owner" || role === "admin";

  return (
    <div className="clients-page">
      <ClientsHeader
        businesses={businesses}
        currentBusiness={currentBusiness}
        onSelectBusiness={setCurrentBusinessId}
        onNewClient={() => setNewOpen(true)}
      />
      {error ? (
        <section className="panel">
          <p className="account-error" role="alert">
            {error}
          </p>
          <button
            className="button button--outline"
            onClick={() => void refreshBusinesses().catch(() => undefined)}
          >
            Обновить доступ
          </button>
        </section>
      ) : isLoading ? (
        <LoadingPanel label="Загружаем бизнес" />
      ) : currentBusiness ? (
        <Suspense fallback={<LoadingPanel label="Загружаем клиентов" />}>
          <ClientsWorkspaceBody
            key={`${currentBusiness.id}:${currentBusiness.role}`}
            businessId={currentBusiness.id}
            timezone={currentBusiness.timezone ?? "UTC"}
            canMerge={canMerge}
            canAssignOthers={canAssignOthers}
            newOpen={newOpen}
            onNewOpenChange={setNewOpen}
          />
        </Suspense>
      ) : (
        <p>Выберите бизнес.</p>
      )}
    </div>
  );
}

function ClientsWorkspaceBody({
  businessId,
  timezone,
  canMerge,
  canAssignOthers,
  newOpen,
  onNewOpenChange,
}: {
  businessId: string;
  timezone: string;
  canMerge: boolean;
  canAssignOthers: boolean;
  newOpen: boolean;
  onNewOpenChange: (open: boolean) => void;
}) {
  const searchParams = useSearchParams();
  const layout = useLayoutMode();
  const [filters, setFilters] = useState<ClientFilterValues>({
    ...EMPTY_CLIENT_FILTERS,
  });
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<{
    key: string;
    rows: ClientListItem[];
    cursor: string | null;
    more: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(
    () => searchParams.get("client") || searchParams.get("id") || null,
  );
  const [moreBusy, setMoreBusy] = useState(false);
  const sequence = useRef(0);

  const key = `${attempt}:${filters.search}:${filters.channel}:${filters.activity}:${filters.hasLeads}:${filters.hasOrders}:${filters.hasBookings}:${filters.hasOpenConversation}:${filters.hasNotes}:${filters.tagId}:${filters.assignedUserId}:${filters.newOnly}`;

  useEffect(() => {
    const version = ++sequence.current;
    void getClientPage(businessId, filters)
      .then((result) => {
        if (sequence.current !== version) return;
        setPage({
          key,
          rows: result.items,
          cursor: result.nextCursor,
          more: result.hasMore,
        });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (sequence.current === version)
          setFailure({
            key,
            message:
              e instanceof Error
                ? e.message
                : "Не удалось загрузить клиентов.",
          });
      });
    return () => {
      sequence.current = version + 1;
    };
  }, [businessId, filters, key]);

  const error = failure?.key === key ? failure.message : null;
  const current = page?.key === key && !error ? page : null;

  function refresh() {
    setMoreBusy(false);
    setAttempt((value) => value + 1);
  }

  async function more() {
    if (!current || moreBusy || !current.cursor) return;
    const version = sequence.current;
    setMoreBusy(true);
    try {
      const result = await getClientPage(businessId, filters, current.cursor);
      if (version !== sequence.current) return;
      setPage({
        key,
        rows: [
          ...current.rows,
          ...result.items.filter(
            (row) => !current.rows.some((old) => old.id === row.id),
          ),
        ],
        cursor: result.nextCursor,
        more: result.hasMore,
      });
    } catch (e) {
      if (version === sequence.current)
        setFailure({
          key,
          message:
            e instanceof Error
              ? e.message
              : "Не удалось загрузить клиентов.",
        });
    } finally {
      if (version === sequence.current) setMoreBusy(false);
    }
  }

  const showSidePanel = selected && layout === "desktop";
  const showOverlay = selected && layout !== "desktop";

  return (
    <>
      <ClientSummaryCards businessId={businessId} />
      <ClientFilters
        businessId={businessId}
        value={filters}
        onChange={(next) => {
          setSelected(null);
          setFilters(next);
        }}
        onRefresh={refresh}
        disabled={moreBusy}
      />
      {error ? (
        <section className="panel">
          <p className="account-error" role="alert">
            {error}
          </p>
          <button
            type="button"
            className="button button--outline"
            onClick={refresh}
          >
            Попробовать ещё раз
          </button>
        </section>
      ) : (
        <div
          className={
            "clients-workspace" + (showSidePanel ? " has-detail" : "")
          }
        >
          <ClientList
            rows={current?.rows ?? []}
            selectedId={selected}
            timezone={timezone}
            loading={!current}
            hasMore={current?.more}
            moreBusy={moreBusy}
            onSelect={setSelected}
            onMore={() => void more()}
          />
          {showSidePanel ? (
            <ClientDetail
              key={selected}
              businessId={businessId}
              clientId={selected!}
              timezone={timezone}
              canMerge={canMerge}
              canAssignOthers={canAssignOthers}
              variant="panel"
              onClose={() => setSelected(null)}
              onListRefresh={refresh}
              onMerged={(targetId) => {
                setSelected(targetId);
                refresh();
              }}
            />
          ) : null}
        </div>
      )}

      {showOverlay ? (
        <div
          className="client-detail-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelected(null);
          }}
        >
          <ClientDetail
            key={selected}
            businessId={businessId}
            clientId={selected!}
            timezone={timezone}
            canMerge={canMerge}
            canAssignOthers={canAssignOthers}
            variant={layout === "mobile" ? "dialog" : "drawer"}
            onClose={() => setSelected(null)}
            onListRefresh={refresh}
            onMerged={(targetId) => {
              setSelected(targetId);
              refresh();
            }}
          />
        </div>
      ) : null}

      {newOpen ? (
        <NewClientDialog
          businessId={businessId}
          canAssignOthers={canAssignOthers}
          onClose={() => onNewOpenChange(false)}
          onCreated={(id) => {
            setSelected(id);
            refresh();
          }}
        />
      ) : null}
    </>
  );
}
