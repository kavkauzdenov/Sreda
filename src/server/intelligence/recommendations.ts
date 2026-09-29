import { randomUUID } from "node:crypto";
import type { BusinessInsight } from "@/lib/intelligence-types.ts";
import type { BusinessRecommendation } from "@/lib/intelligence-types.ts";

export function buildRecommendations(
  insights: BusinessInsight[],
): BusinessRecommendation[] {
  const recs: BusinessRecommendation[] = [];

  for (const insight of insights) {
    if (insight.type === "overdue_order") {
      const count =
        insight.evidence.find((e) => e.metric === "stale_open_orders")
          ?.current ?? 0;
      recs.push({
        id: randomUUID(),
        insightId: insight.id,
        title: "Разобрать зависшие заказы",
        reason: insight.description,
        expectedEffect: "Сократится очередь и риск отмен со стороны клиентов.",
        risk: "Низкий — только просмотр и смена статусов.",
        actionType: "preview",
        status: "open",
        href: "/orders",
        preview: {
          summary: "Открыть список заказов и обновить статусы.",
          affectedCount: Number(count),
          basis: `SLA без движения > 24 ч`,
        },
      });
    }
    if (insight.type === "overdue_lead") {
      const count =
        insight.evidence.find((e) => e.metric === "stale_open_leads")
          ?.current ?? 0;
      recs.push({
        id: randomUUID(),
        insightId: insight.id,
        title: "Назначить ответственных по заявкам",
        reason: insight.description,
        expectedEffect: "Ускорится первичный ответ клиентам.",
        risk: "Низкий — распределение вручную.",
        actionType: "manual_required",
        status: "open",
        href: "/leads",
        preview: {
          summary: "Проверить необработанные заявки и взять в работу.",
          affectedCount: Number(count),
          basis: "Заявки старше 48 ч",
        },
      });
    }
    if (insight.type === "sales_drop" || insight.type === "revenue_change") {
      recs.push({
        id: randomUUID(),
        insightId: insight.id,
        title: "Сверить воронку заказов",
        reason: insight.description,
        expectedEffect: "Поймёте, на каком этапе теряются продажи.",
        risk: "Нет автоматических изменений.",
        actionType: "available",
        status: "open",
        href: "/orders",
        preview: {
          summary: "Сравнить периоды в заказах и каталоге.",
          affectedCount: 0,
          basis: "Сравнение 7 дней",
        },
      });
    }
    if (insight.type === "inactive_customer") {
      const count =
        insight.evidence.find((e) => e.metric === "inactive_clients_30d")
          ?.current ?? 0;
      recs.push({
        id: randomUUID(),
        insightId: insight.id,
        title: "Запланировать возврат клиентов",
        reason: insight.description,
        expectedEffect: "Часть клиентов может вернуться без рекламного бюджета.",
        risk: "Средний — нужен аккуратный контакт.",
        actionType: "manual_required",
        status: "open",
        href: "/clients",
        preview: {
          summary: "Отфильтровать клиентов без активности 30+ дней.",
          affectedCount: Number(count),
          basis: "last_seen_at",
        },
      });
    }
  }

  return recs;
}
