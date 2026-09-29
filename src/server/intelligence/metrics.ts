import type { InternalBusinessSnapshot } from "./internal-data.ts";
import type { IntelligenceMetric } from "@/lib/intelligence-types.ts";

export function buildMetrics(snap: InternalBusinessSnapshot): IntelligenceMetric[] {
  const metrics: IntelligenceMetric[] = [
    {
      id: "orders_7d",
      label: "Заказы за 7 дней",
      value: snap.ordersCurrent7d,
      display: String(snap.ordersCurrent7d),
    },
    {
      id: "orders_open",
      label: "Заказы в работе",
      value: snap.ordersOpen,
      display: String(snap.ordersOpen),
    },
    {
      id: "new_orders",
      label: "Новые заказы",
      value: snap.newOrdersToday,
      display: String(snap.newOrdersToday),
    },
    {
      id: "clients_total",
      label: "Клиенты",
      value: snap.clientsTotal,
      display: String(snap.clientsTotal),
    },
  ];

  if (snap.clientsTotal > 0) {
    metrics.push({
      id: "clients_new_30d",
      label: "Новые клиенты 30д",
      value: snap.clientsNew30d,
      display: String(snap.clientsNew30d),
    });
  }

  if (snap.revenueCurrent7d > 0 || snap.revenuePrevious7d > 0) {
    metrics.push({
      id: "revenue_7d",
      label: "Выручка 7д",
      value: snap.revenueCurrent7d,
      display: `${Math.round(snap.revenueCurrent7d).toLocaleString("ru-RU")} ${snap.revenueCurrency}`,
      hint:
        snap.revenuePrevious7d > 0
          ? `Было ${Math.round(snap.revenuePrevious7d).toLocaleString("ru-RU")}`
          : undefined,
    });
  }

  if (snap.leadsOpen > 0) {
    metrics.push({
      id: "leads_open",
      label: "Открытые заявки",
      value: snap.leadsOpen,
      display: String(snap.leadsOpen),
    });
  }

  return metrics.slice(0, 6);
}
