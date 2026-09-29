import { randomUUID } from "node:crypto";
import type { InternalBusinessSnapshot } from "./internal-data.ts";
import type { BusinessSignal } from "@/lib/intelligence-types.ts";

export function buildSignals(
  snap: InternalBusinessSnapshot,
  now = new Date(),
): BusinessSignal[] {
  const signals: BusinessSignal[] = [];
  const occurredAt = now.toISOString();

  if (snap.ordersStale > 0) {
    signals.push({
      id: randomUUID(),
      businessId: snap.businessId,
      type: "overdue_order",
      source: "order",
      title: "Заказы без движения",
      description: `${snap.ordersStale} заказ(ов) в работе дольше ${24} ч без обновления статуса.`,
      severity: snap.ordersStale >= 5 ? "high" : "medium",
      evidence: [
        {
          metric: "stale_open_orders",
          current: snap.ordersStale,
          sampleSize: snap.ordersOpen,
          unit: "orders",
        },
      ],
      occurredAt,
    });
  }

  if (snap.leadsStale > 0) {
    signals.push({
      id: randomUUID(),
      businessId: snap.businessId,
      type: "overdue_lead",
      source: "lead",
      title: "Заявки без обработки",
      description: `${snap.leadsStale} заявок в статусе «новая/в работе» дольше ${48} ч.`,
      severity: snap.leadsStale >= 3 ? "high" : "medium",
      evidence: [
        {
          metric: "stale_open_leads",
          current: snap.leadsStale,
          sampleSize: snap.leadsOpen,
          unit: "leads",
        },
      ],
      occurredAt,
    });
  }

  if (
    snap.ordersPrevious7d >= 3 &&
    snap.ordersCurrent7d < snap.ordersPrevious7d * 0.85
  ) {
    const dropPct = Math.round(
      (1 - snap.ordersCurrent7d / snap.ordersPrevious7d) * 100,
    );
    signals.push({
      id: randomUUID(),
      businessId: snap.businessId,
      type: "sales_drop",
      source: "order",
      title: "Снижение числа заказов",
      description: `За 7 дней заказов ${snap.ordersCurrent7d} против ${snap.ordersPrevious7d} в предыдущем периоде (−${dropPct}%).`,
      severity: dropPct >= 30 ? "high" : "medium",
      evidence: [
        {
          metric: "orders_7d",
          current: snap.ordersCurrent7d,
          previous: snap.ordersPrevious7d,
          sampleSize: snap.ordersPrevious7d + snap.ordersCurrent7d,
          unit: "orders",
        },
      ],
      occurredAt,
    });
  }

  if (snap.clientsInactive >= 3 && snap.clientsTotal >= 5) {
    signals.push({
      id: randomUUID(),
      businessId: snap.businessId,
      type: "inactive_customer",
      source: "client",
      title: "Неактивные клиенты",
      description: `${snap.clientsInactive} клиентов без активности более ${30} дней.`,
      severity: snap.clientsInactive >= 10 ? "medium" : "low",
      evidence: [
        {
          metric: "inactive_clients_30d",
          current: snap.clientsInactive,
          sampleSize: snap.clientsTotal,
          unit: "clients",
        },
      ],
      occurredAt,
    });
  }

  if (
    snap.revenuePrevious7d > 0 &&
    snap.revenueCurrent7d < snap.revenuePrevious7d * 0.8
  ) {
    signals.push({
      id: randomUUID(),
      businessId: snap.businessId,
      type: "revenue_change",
      source: "order",
      title: "Падение выручки",
      description: `Выручка за 7 дней ${snap.revenueCurrent7d.toFixed(0)} ${snap.revenueCurrency} против ${snap.revenuePrevious7d.toFixed(0)} ранее.`,
      severity: "medium",
      evidence: [
        {
          metric: "revenue_7d",
          current: snap.revenueCurrent7d,
          previous: snap.revenuePrevious7d,
          currency: snap.revenueCurrency,
          unit: snap.revenueCurrency,
        },
      ],
      occurredAt,
    });
  }

  return signals;
}
