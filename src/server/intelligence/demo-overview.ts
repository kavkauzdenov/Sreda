import type { IntelligenceOverview } from "@/lib/intelligence-types.ts";

/** Labeled synthetic payload for demos only. */
export function buildDemoOverview(): IntelligenceOverview {
  const now = new Date().toISOString();
  return {
    dataMode: "demo",
    lastUpdated: now,
    summary: {
      status: "attention_required",
      text: "Демонстрационный сценарий (DEMO) — цифры синтетические, не из вашей базы.",
    },
    metrics: [
      { id: "orders_7d", label: "Заказы 7д", value: 42, display: "42" },
      { id: "revenue_7d", label: "Выручка 7д", value: 128400, display: "128 400 ₽" },
      { id: "new_clients", label: "Новые клиенты", value: 6, display: "6" },
      { id: "open_leads", label: "Открытые заявки", value: 9, display: "9" },
    ],
    signals: [],
    insights: [
      {
        id: "demo-insight-1",
        type: "overdue_lead",
        severity: "high",
        title: "Заявки без обработки (DEMO)",
        description: "7 заявок без назначения более 4 часов.",
        evidence: [
          {
            metric: "stale_open_leads",
            current: 7,
            sampleSize: 9,
            unit: "leads",
          },
        ],
        impact: "Пример для презентации Command Center.",
        confidence: "medium",
      },
    ],
    recommendations: [
      {
        id: "demo-rec-1",
        insightId: "demo-insight-1",
        title: "Перераспределить заявки (DEMO)",
        reason: "7 заявок без назначения более 4 часов.",
        expectedEffect: "Ускорится первый ответ.",
        risk: "Только демо — действие не выполняется.",
        actionType: "preview",
        status: "open",
        href: "/leads",
        preview: {
          summary: "Будет изменено: 7 заявок",
          affectedCount: 7,
          basis: "DEMO",
        },
      },
    ],
  };
}
