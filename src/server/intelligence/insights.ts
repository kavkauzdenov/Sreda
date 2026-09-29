import { randomUUID } from "node:crypto";
import type { BusinessSignal } from "@/lib/intelligence-types.ts";
import type { BusinessInsight } from "@/lib/intelligence-types.ts";

function confidenceFromSignal(s: BusinessSignal): "low" | "medium" | "high" {
  const sample = s.evidence[0]?.sampleSize ?? 0;
  if (sample >= 20) return "high";
  if (sample >= 5) return "medium";
  return "low";
}

export function buildInsights(signals: BusinessSignal[]): BusinessInsight[] {
  return signals.map((signal) => ({
    id: randomUUID(),
    type: signal.type,
    severity: signal.severity,
    title: signal.title,
    description: signal.description,
    evidence: signal.evidence,
    impact:
      signal.severity === "high" || signal.severity === "critical"
        ? "Требует внимания в ближайшее время."
        : "Стоит проверить при планировании смены.",
    confidence: confidenceFromSignal(signal),
  }));
}
