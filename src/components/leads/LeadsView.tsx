"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { LeadFilters, type LeadFilterValues } from "@/components/leads/LeadFilters";
import { LeadDetail } from "@/components/leads/LeadDetail";
import { LeadStatusBadge } from "@/components/leads/LeadStatusBadge";
import {
  LeadSummaryCards,
  type LeadPeriod,
} from "@/components/leads/LeadSummaryCards";
import { getLeadPage } from "@/services/leads.service";
import { isDemoMode } from "@/lib/dataMode";
import { formatRelativeDateTime } from "@/lib/format";
import { EmptyStateCta } from "@/components/solutions/SolutionSetupBanner";
import type { Lead } from "@/types";

export function LeadsView() {
  const {
    businesses,
    currentBusiness,
    setCurrentBusinessId,
    isLoading,
    error,
    refreshBusinesses,
  } = useBusinessContext();
  const canSetup =
    currentBusiness?.role === "owner" || currentBusiness?.role === "admin";

  return (
    <div className="leads-page">
      <header className="leads-page__heading">
        <div>
          <span className="eyebrow">Обращения клиентов</span>
          <h1>Заявки</h1>
          <p>Все обращения вашего бизнеса в одном месте.</p>
        </div>
        <div className="leads-page__heading-actions">
          {canSetup ? (
            <Link
              href="/solutions/leads/setup"
              className="button button--outline"
            >
              Настроить форму
            </Link>
          ) : null}
          <BusinessSwitcher
            businesses={businesses}
            currentBusiness={currentBusiness}
            onSelect={setCurrentBusinessId}
          />
        </div>
      </header>
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
        <LeadWorkspace
          key={`${currentBusiness.id}:${currentBusiness.role}`}
          businessId={currentBusiness.id}
        />
      ) : (
        <p>Выберите бизнес.</p>
      )}
    </div>
  );
}

function LeadWorkspace({ businessId }: { businessId: string }) {
  const [period, setPeriod] = useState<LeadPeriod>(7);
  const [filters, setFilters] = useState<LeadFilterValues>({
    status: "all",
    search: "",
    source: "",
    from: "",
    until: "",
    processingBy: "",
  });
  const [attempt, setAttempt] = useState(0);
  const key = `${filters.status}:${attempt}:${filters.search}:${filters.source}:${filters.processingBy}:${filters.from}:${filters.until}`;
  const [page, setPage] = useState<{
    key: string;
    rows: Lead[];
    cursor?: string;
    more: boolean;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [moreBusy, setMoreBusy] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const sequence = useRef(0);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const version = ++sequence.current;
    void getLeadPage(
      businessId,
      filters.status === "all" ? undefined : filters.status,
      undefined,
      {
        search: filters.search,
        source: filters.source,
        from: filters.from,
        until: filters.until,
      },
    )
      .then((rows) => {
        if (sequence.current !== version) return;
        const last = rows.at(-1);
        setPage({
          key,
          rows,
          cursor: last ? `${last.createdAt}|${last.id}` : undefined,
          more: rows.length === 100,
        });
        setFailure(null);
      })
      .catch((e: unknown) => {
        if (sequence.current === version)
          setFailure({
            key,
            message:
              e instanceof Error ? e.message : "Не удалось загрузить заявки.",
          });
      });
    return () => {
      sequence.current = version + 1;
    };
  }, [businessId, filters, key]);

  const error = failure?.key === key ? failure.message : null;
  const current = page?.key === key && !error ? page : null;

  function refresh() {
    setSelected(null);
    setMoreBusy(false);
    setAttempt((value) => value + 1);
  }

  async function more() {
    if (!current || moreBusy) return;
    const version = sequence.current;
    setMoreBusy(true);
    try {
      const rows = await getLeadPage(
        businessId,
        filters.status === "all" ? undefined : filters.status,
        current.cursor,
        {
          search: filters.search,
          source: filters.source,
          from: filters.from,
          until: filters.until,
        },
      );
      if (version !== sequence.current) return;
      const last = rows.at(-1);
      setPage({
        key,
        rows: [
          ...current.rows,
          ...rows.filter(
            (row) => !current.rows.some((old) => old.id === row.id),
          ),
        ],
        cursor: last ? `${last.createdAt}|${last.id}` : current.cursor,
        more: rows.length === 100,
      });
    } catch (e) {
      if (version === sequence.current)
        setFailure({
          key,
          message:
            e instanceof Error ? e.message : "Не удалось загрузить заявки.",
        });
    } finally {
      if (version === sequence.current) setMoreBusy(false);
    }
  }

  function onLeadUpdated(updated: Lead) {
    setPage((old) =>
      old?.key === key
        ? {
            ...old,
            rows: old.rows
              .map((row) => (row.id === updated.id ? { ...row, ...updated } : row))
              .filter(
                (row) =>
                  filters.status === "all" || row.status === filters.status,
              ),
          }
        : old,
    );
  }

  return (
    <>
      <LeadSummaryCards
        businessId={businessId}
        period={period}
        onPeriodChange={setPeriod}
      />
      <LeadFilters
        businessId={businessId}
        value={filters}
        onChange={(next) => {
          setSelected(null);
          setFilters(next);
        }}
        onRefresh={refresh}
        disabled={moreBusy}
      />
      {isDemoMode ? (
        <p className="account-footnote">
          Демонстрационные данные. Изменение статуса доступно в рабочем
          аккаунте.
        </p>
      ) : null}
      {error ? (
        <section className="panel">
          <p className="account-error" role="alert">
            {error}
          </p>
          <button className="button button--outline" onClick={refresh}>
            Попробовать ещё раз
          </button>
        </section>
      ) : !current ? (
        <LoadingPanel label="Загружаем заявки" />
      ) : (
        <div
          className={
            "leads-workspace" + (selected && !isMobile ? " has-detail" : "")
          }
        >
          <section className="panel leads-workspace__list">
            <p className="account-footnote">
              Загружено заявок: {current.rows.length}
            </p>
            {current.rows.length ? (
              <ul className="leads-records">
                {current.rows.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={
                        "leads-record" +
                        (selected === row.id ? " is-selected" : "")
                      }
                      aria-pressed={selected === row.id}
                      onClick={() => setSelected(row.id)}
                    >
                      <span className="leads-record__content">
                        <strong>{row.name}</strong>
                        <span>{row.phone}</span>
                        {row.processingName ? (
                          <small>В работе · {row.processingName}</small>
                        ) : null}
                        <span>{row.message || "Без сообщения"}</span>
                      </span>
                      <span className="leads-record__meta">
                        <PlatformBadge platform={row.source} />
                        <LeadStatusBadge status={row.status} />
                        <time dateTime={row.createdAt}>
                          {formatRelativeDateTime(row.createdAt)}
                        </time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="empty-state empty-state--compact">
                {filters.status === "all" &&
                !filters.search &&
                !filters.source ? (
                  <EmptyStateCta
                    title="Заявок пока нет"
                    description="Настройте форму заявки и подключите Telegram или VK — обращения появятся здесь."
                    href="/solutions/leads/setup"
                    action="Настроить приём заявок"
                  />
                ) : (
                  <p>Заявок по выбранным фильтрам пока нет.</p>
                )}
              </div>
            )}
            {current.more ? (
              <button
                type="button"
                className="button button--outline"
                disabled={moreBusy}
                onClick={() => void more()}
              >
                {moreBusy ? "Загружаем…" : "Показать ещё"}
              </button>
            ) : null}
          </section>

          {selected && !isMobile ? (
            <LeadDetail
              key={selected}
              businessId={businessId}
              leadId={selected}
              onClose={() => setSelected(null)}
              onUpdated={onLeadUpdated}
              onOpenLead={setSelected}
              variant="panel"
            />
          ) : null}
        </div>
      )}

      {selected && isMobile ? (
        <div className="lead-detail-overlay">
          <LeadDetail
            key={selected}
            businessId={businessId}
            leadId={selected}
            onClose={() => setSelected(null)}
            onUpdated={onLeadUpdated}
            onOpenLead={setSelected}
            variant="dialog"
          />
        </div>
      ) : null}
    </>
  );
}
