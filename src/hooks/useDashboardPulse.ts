"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "@/lib/apiClient";

/**
 * Real, already-paginated counters for the dashboard summary.
 *
 * Every field here comes from an existing summary endpoint — no fabricated
 * numbers, no decorative charts. Each shape mirrors the server contract:
 *   orders  → OrderService.list "view=summary"
 *   leads   → LeadService.summary
 *   clients → getClientSummary
 */
export type DashboardOrders = {
  newCount: number;
  inProgressCount: number;
  todayRevenue: { currency: string; amount: string }[];
  timezone: string;
};

export type DashboardLeads = {
  newCount: number;
  processingCount: number;
  waitingCustomerCount: number;
};

export type DashboardClients = {
  total: number;
  new30d: number;
  openConversations: number;
};

export type DashboardBookings = {
  todayCount: number;
  nextStartAt: string | null;
};

export type DashboardPulse = {
  orders: DashboardOrders | null;
  leads: DashboardLeads | null;
  clients: DashboardClients | null;
  bookings: DashboardBookings | null;
};

const EMPTY: DashboardPulse = {
  orders: null,
  leads: null,
  clients: null,
  bookings: null,
};

/** Start/end of the business-local day, as ISO instants. */
function localDayRange(timeZone: string) {
  const now = new Date();
  const key = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const parts = key.split("-").map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  const start = new Date(Date.UTC(year, month - 1, day));
  // Re-read the zone offset at both ends so DST transitions don't shift the window.
  const offsetAt = (date: Date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(raw);
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3])) * 60000;
  };
  const from = new Date(start.getTime() - offsetAt(start));
  const to = new Date(from.getTime() + 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

type PulseState = {
  businessId: string | null;
  data: DashboardPulse;
  loaded: boolean;
};

export function useDashboardPulse(businessId: string | null | undefined) {
  const [state, setState] = useState<PulseState>({
    businessId: null,
    data: EMPTY,
    loaded: false,
  });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!businessId) return;
    let cancelled = false;

    const load = async () => {
      const base = `/api/v1/businesses/${businessId}`;
      // Failures are per-block: a missing section must not blank the whole page.
      const [orders, leads, clients, bookings] = await Promise.all([
        apiRequest<DashboardOrders>(`${base}/orders?view=summary`).catch(
          () => null,
        ),
        apiRequest<DashboardLeads>(`${base}/leads?view=summary&days=1`).catch(
          () => null,
        ),
        apiRequest<DashboardClients>(`${base}/clients?view=summary`).catch(
          () => null,
        ),
        // Timezone comes from the profile; fall back to the browser zone.
        apiRequest<{ timezone?: string }>(`${base}/profile`)
          .then((profile) => {
            const timeZone = profile?.timezone || "UTC";
            const { from, to } = localDayRange(timeZone);
            return apiRequest<unknown[]>(
              `${base}/bookings?from=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}`,
            ).then((rows) => ({ timeZone, rows: Array.isArray(rows) ? rows : [] }));
          })
          .then(({ timeZone, rows }) => {
            const active = rows.filter(
              (row) => (row as { status?: string }).status !== "cancelled",
            );
            const next =
              active
                .map((row) => (row as { starts_at?: string }).starts_at ?? "")
                .filter(Boolean)
                .sort()[0] ?? null;
            return {
              todayCount: active.length,
              nextStartAt: next,
              timeZone,
            };
          })
          .catch(() => null),
      ]);

      if (cancelled) return;
      const leadCounts = (
        (leads as unknown as { counts?: Record<string, number> } | null)?.counts ?? {}
      );
      setState({
        businessId,
        loaded: true,
        data: {
          orders: orders ?? null,
          leads: leads
            ? {
                newCount: Number(leadCounts.new ?? 0),
                processingCount: Number(leadCounts.processing ?? 0),
                waitingCustomerCount: Number(leadCounts.waiting_customer ?? 0),
              }
            : null,
          clients: clients ?? null,
          bookings: bookings ?? null,
        },
      });
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [businessId, attempt]);

  // Stale data from a previously selected business must never be shown.
  const current =
    businessId && state.businessId === businessId ? state : null;
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return {
    pulse: current?.data ?? EMPTY,
    loading: Boolean(businessId) && !current?.loaded,
    retry,
  };
}