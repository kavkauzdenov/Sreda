import type { BusinessHealthStatus, BusinessSignal } from "@/lib/intelligence-types.ts";

export function aggregateBusinessStatus(
  signals: BusinessSignal[],
): BusinessHealthStatus {
  if (signals.some((s) => s.severity === "critical")) return "critical";
  if (signals.some((s) => s.severity === "high" || s.severity === "medium"))
    return "attention_required";
  return "stable";
}

export function summaryText(
  status: BusinessHealthStatus,
  signalCount: number,
  dataMode: "live" | "insufficient" | "demo",
): string {
  if (dataMode === "insufficient")
    return "Недостаточно данных для выводов — начните принимать заказы, заявки или добавьте клиентов.";
  if (dataMode === "demo")
    return "Демонстрационный сценарий (DEMO) — цифры синтетические, не из вашей базы.";
  if (status === "stable")
    return signalCount === 0
      ? "По доступным данным критичных отклонений не обнаружено."
      : "Есть точечные сигналы, но критичных проблем нет.";
  if (status === "critical")
    return `Обнаружено ${signalCount} сигнал(ов), включая критичные — нужны действия.`;
  return `Обнаружено ${signalCount} сигнал(ов), требующих внимания.`;
}
