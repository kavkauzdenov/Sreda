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
      <section className="dashboard-onboarding-card" aria-label="Чеклист настройки">
        <div className="dashboard-onboarding-card__header">
          <h2 className="dashboard-onboarding-card__title">
            Стартовая настройка
          </h2>
          <span className="dashboard-onboarding-card__progress">
            {resolved.done} из {resolved.total}
          </span>
        </div>
        <div className="dashboard-onboarding-card__steps">
          {resolved.steps.map((step) => (
            <div
              key={step.id}
              className={`dashboard-onboarding-card__step ${step.done ? "is-done" : ""} ${!step.done && step === resolved.next ? "is-current" : ""} ${!step.done && step !== resolved.next ? "is-pending" : ""}`}
            >
              <div className="dashboard-onboarding-card__step-icon">
                {step.done ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <span>{step.done ? "✓" : ""}</span>
                )}
              </div>
              <Link href={step.href} className="dashboard-onboarding-card__step-label text-link">
                {step.label}
              </Link>
            </div>
          ))}
        </div>
        {resolved.next && (
          <Link href={resolved.next.href} className="dashboard-onboarding-card__cta">
            {resolved.next.label} →
          </Link>
        )}
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
    <div className="setup-page stack-lg">
      <div className="onboarding-card">
        <h2 className="text-section-title">
          Стартовая настройка: {resolved.done} из {resolved.total} шагов
        </h2>
        <p className="text-body-sm">Отмечайте шаги по мере готовности.</p>
        <ul className="setup-progress__list">
          {resolved.steps.map((step) => (
            <li key={step.id} className={step.done ? "is-done" : ""}>
              {step.derived ? (
                <div className="onboarding-status onboarding-status--success">
                  <div className="onboarding-status__icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <div className="onboarding-status__text">
                    <div className="onboarding-status__label">{step.label}</div>
                    <div className="onboarding-status__detail">подключено автоматически</div>
                  </div>
                  <Link href={step.href} className="onboarding-status__action button button--ghost button--sm">
                    Открыть
                  </Link>
                </div>
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
      </div>
    </div>
  );
}