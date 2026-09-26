"use client";

import Link from "next/link";
import { useState } from "react";
import { apiRequest } from "@/lib/apiClient";
import {
  readinessSetupSteps,
  resolveSetupSteps,
  setupStepsForIndustry,
  type SetupReadiness,
  type SetupStep,
} from "@/lib/setupSteps";

export type { SetupReadiness } from "@/lib/setupSteps";

export function SetupChecklist({
  businessId,
  progress,
  industry,
  onProgressChange,
  variant = "full",
  readiness,
}: {
  businessId: string;
  progress: Record<string, boolean>;
  industry?: string | null;
  onProgressChange?: (progress: Record<string, boolean>) => void;
  variant?: "full" | "compact";
  readiness?: SetupReadiness;
}) {
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(progress);

  const source: SetupStep[] =
    variant === "compact" ? readinessSetupSteps() : setupStepsForIndustry(industry);
  const resolved = resolveSetupSteps({
    steps: source,
    progress: local,
    readiness,
  });

  if (variant === "compact") {
    if (resolved.done >= resolved.total) return null;
    return (
      <section className="setup-checklist setup-checklist--compact" aria-label="Чеклист настройки">
        <div className="setup-checklist__head">
          <h2 className="text-section-title">
            Стартовая настройка: {resolved.done} из {resolved.total} шагов
          </h2>
        </div>
        <ul className="setup-progress__list">
          {resolved.steps.map((step) => (
            <li key={step.id} className={step.done ? "is-done" : ""}>
              <Link href={step.href} className="text-link">
                <span aria-hidden>{step.done ? "✓" : "○"}</span> {step.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  async function toggle(id: string, value: boolean) {
    setBusy(true);
    try {
      const next = { ...local, [id]: value };
      const after = resolveSetupSteps({
        steps: setupStepsForIndustry(industry),
        progress: next,
        readiness,
      });
      const allDone = after.done >= after.total;
      const saved = await apiRequest<{
        setup_progress: Record<string, boolean>;
      }>(`/api/v1/businesses/${businessId}/industry`, {
        method: "PATCH",
        body: JSON.stringify({
          setup_progress: next,
          ...(allDone ? { complete_onboarding: true } : {}),
        }),
      });
      setLocal(saved.setup_progress ?? next);
      onProgressChange?.(saved.setup_progress ?? next);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel stack-md" aria-label="Чеклист настройки">
      <h2 className="text-section-title">
        Стартовая настройка: {resolved.done} из {resolved.total} шагов
      </h2>
      <p className="text-body-sm">Отмечайте шаги по мере готовности.</p>
      <ul className="setup-progress__list">
        {resolved.steps.map((step) => (
          <li key={step.id} className={step.done ? "is-done" : ""}>
            {step.derived ? (
              <span>
                <span aria-hidden>{step.done ? "✓" : "○"}</span>{" "}
                <Link href={step.href} className="text-link">
                  {step.label}
                </Link>
                {step.done ? (
                  <span className="text-caption"> · подключено автоматически</span>
                ) : null}
              </span>
            ) : (
              <label className="capability-row">
                <input
                  type="checkbox"
                  checked={step.done}
                  disabled={busy}
                  onChange={(e) => void toggle(step.id, e.target.checked)}
                />
                <span>
                  <span aria-hidden>{step.done ? "✓" : "○"}</span>{" "}
                  <Link href={step.href} className="text-link">
                    {step.label}
                  </Link>
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
