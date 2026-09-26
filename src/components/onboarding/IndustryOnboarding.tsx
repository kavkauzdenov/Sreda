"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { apiRequest } from "@/lib/apiClient";
import type {
  CapabilityId,
  IndustryId,
  SetupMode,
} from "@/lib/industryPresets";
import { FieldHint } from "@/components/ui/SetupChrome";
import { AdvancedConfigurator } from "@/components/onboarding/AdvancedConfigurator";
import { SetupChecklist } from "@/components/onboarding/SetupChecklist";
import {
  readinessSetupSteps,
  resolveSetupSteps,
  setupStepsForIndustry,
  type SetupReadiness,
} from "@/lib/setupSteps";

const SOLUTION_LABELS: Record<string, string> = {
  leads: "Приём заявок",
  orders: "Приём заказов",
  booking: "Онлайн-запись",
  admin_messages: "Связь с администратором",
  autopost: "Автопостинг",
};

type IndustryCard = { id: IndustryId; label: string; hint: string };

type PresetSummary = {
  id: IndustryId;
  label: string;
  recommendedSolutions: string[];
  optionalSolutions: string[];
  recommendedCapabilities: CapabilityId[];
  terminology: {
    specialist: string;
    specialists: string;
    service: string;
    booking: string;
  };
  subtypes: { id: string; label: string }[];
  bookingPreset?: string | null;
};

type IndustryState = {
  industry: IndustryId | null;
  industry_subtype: string | null;
  business_model: string | null;
  setup_mode: SetupMode;
  capabilities_enabled: CapabilityId[];
  setup_progress: Record<string, boolean>;
  onboarding_completed_at: string | null;
  readiness: SetupReadiness;
  name: string;
  preset: PresetSummary | null;
  catalogs: {
    industries: IndustryCard[];
    presets: PresetSummary[];
  };
};

type Step = "industry" | "subtype" | "recommend" | "advanced" | "done";

function deriveStep(data: IndustryState, forceEdit: boolean): Step {
  if (data.setup_mode === "advanced" && !forceEdit) return "advanced";
  if (!data.industry) return "industry";
  const subtypes = data.preset?.subtypes ?? [];
  if (subtypes.length > 1 && !data.industry_subtype) return "subtype";
  if (data.setup_progress.industry && !forceEdit) return "done";
  return "recommend";
}

function getStepLabel(step: string): string {
  const labels: Record<string, string> = {
    industry: "Направление",
    subtype: "Формат",
    recommend: "Рекомендации",
    telegram: "Telegram",
    solutions: "Решения",
    catalog: "Каталог",
    orders: "Заказы",
    services: "Услуги",
    specialists: "Специалисты",
    schedule: "Расписание",
    leads: "Заявки",
    ai: "AI-профиль",
  };
  return labels[step] ?? step;
}

function getStepIcon(step: string): React.ReactNode {
  const icons: Record<string, React.ReactNode> = {
    industry: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>,
    subtype: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>,
    recommend: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>,
    telegram: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    solutions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>,
    catalog: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>,
    orders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>,
    services: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    specialists: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
    schedule: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>,
    leads: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
    ai: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 6v6l4 2"/><path d="M8 18a4 4 0 0 0 8 0"/></svg>,
  };
  return icons[step] ?? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/></svg>;
}

export function IndustryOnboarding({ businessId }: { businessId: string }) {
  const url = `/api/v1/businesses/${businessId}/industry`;
  const [data, setData] = useState<IndustryState | null>(null);
  const [forceEdit, setForceEdit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const next = await apiRequest<IndustryState>(url);
    setData(next);
    return next;
  }, [url]);

  useEffect(() => {
    let active = true;
    void apiRequest<IndustryState>(url)
      .then((next) => {
        if (active) setData(next);
      })
      .catch((e) => {
        if (active)
          setError(e instanceof Error ? e.message : "Не удалось загрузить.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [url]);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await apiRequest<IndustryState>(url, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setData(next);
      setNotice("Сохранено.");
      return next;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить.");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function applyRecommendations(current: IndustryState) {
    const caps =
      current.preset?.recommendedCapabilities ??
      current.capabilities_enabled ??
      [];
    const next = await patch({
      capabilities_enabled: caps,
      setup_mode: "guided",
      setup_progress: { ...current.setup_progress, industry: true },
      apply_lead_preset: true,
    });
    if (next) setForceEdit(false);
  }

  function confirmIndustryChange(nextIndustry: string) {
    if (!data?.industry || data.industry === nextIndustry) return true;
    return window.confirm(
      "Мы обновим рекомендации, но ваши данные и уже подключённые функции сохранятся.\n\nПродолжить?",
    );
  }

  if (loading || !data) {
    return (
      <div className="setup-page">
        <section className="panel">
          <p>{error || "Загружаем онбординг…"}</p>
        </section>
      </div>
    );
  }

const step = deriveStep(data, forceEdit);
  const industries = data.catalogs.industries;
  const subtypes = data.preset?.subtypes ?? [];
  const recommended = data.preset?.recommendedSolutions ?? [];
  const resolvedSteps = resolveSetupSteps({
    steps: setupStepsForIndustry(data.industry),
    progress: data.setup_progress,
    readiness: data.readiness,
  });
  const isBookingIndustry =
    recommended.includes("booking") || Boolean(data.preset?.bookingPreset);

  const statusBlock = (
    <>
      {notice ? (
        <p className="account-notice" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );

  const stepOrder = ["industry", "subtype", "recommend", "telegram", "solutions", "catalog", "orders", "services", "specialists", "schedule", "leads", "ai"];
  const currentStepIndex = stepOrder.findIndex(s => s === step);
  const allSteps = data.industry ? setupStepsForIndustry(data.industry) : readinessSetupSteps();

  const onboardingStepper = (
    <div className="onboarding-stepper" role="progressbar" aria-valuenow={resolvedSteps.done} aria-valuemin={0} aria-valuemax={resolvedSteps.total}>
      {allSteps.map((s) => (
        <div
          key={s.id}
          className={`onboarding-stepper__item ${resolvedSteps.steps.find(r => r.id === s.id)?.done ? "is-complete" : ""} ${resolvedSteps.next?.id === s.id ? "is-current" : ""}`}
        >
          <div className="onboarding-stepper__dot">
            {resolvedSteps.steps.find(r => r.id === s.id)?.done ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
            ) : (
              getStepIcon(s.id)
            )}
          </div>
          <span className="onboarding-stepper__label">{getStepLabel(s.id)}</span>
        </div>
      ))}
    </div>
  );

  const renderOnboardingCard = (children: React.ReactNode, header?: React.ReactNode) => (
    <div className="setup-page stack-lg">
      {statusBlock}
      <div className="onboarding-card">
        {onboardingStepper}
        {header && (
          <div className="onboarding-card__header">
            <div className="onboarding-card__icon">
              {header}
            </div>
            <div className="onboarding-card__meta">
              <p className="onboarding-card__eyebrow">Онбординг</p>
              <h1 className="onboarding-card__title">Настройка бизнеса</h1>
            </div>
          </div>
        )}
        <div className="onboarding-card__body">{children}</div>
      </div>
    </div>
  );

  if (step === "advanced") {
    return renderOnboardingCard((
      <>
        <AdvancedConfigurator
          businessId={businessId}
          initialEnabled={data.capabilities_enabled}
          onSaved={() => {
            setForceEdit(false);
            void reload();
          }}
        />
        <section className="panel stack-md">
          <h2 className="text-section-title">Что дальше</h2>
          <p className="text-body-sm">
            Возможности сохранены. Дальше — подключить площадку и довести
            стартовую настройку до конца.
          </p>
          <div className="message-actions">
            {resolvedSteps.next ? (
              <Link href={resolvedSteps.next.href} className="button button--primary">
                {resolvedSteps.next.label}
              </Link>
            ) : (
              <Link href="/dashboard" className="button button--primary">
                Перейти в дашборд
              </Link>
            )}
            <Link href="/dashboard" className="button button--outline">
              Вернуться в дашборд
            </Link>
          </div>
        </section>
        <SetupChecklist
          businessId={businessId}
          progress={data.setup_progress}
          industry={data.industry}
          readiness={data.readiness}
          onProgressChange={(progress) =>
            setData((prev) => (prev ? { ...prev, setup_progress: progress } : prev))
          }
        />
        <p>
          <button
            type="button"
            className="button button--outline"
            disabled={busy}
            onClick={() => {
              setForceEdit(true);
              void patch({ setup_mode: "guided" });
            }}
          >
            Вернуться к подсказкам по отрасли
          </button>
        </p>
      </>
    ), (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    ));
  }

  if (step === "done") {
    return renderOnboardingCard((
      <>
        <div className="onboarding-complete">
          <div className="onboarding-complete__icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <h2 className="onboarding-complete__title">Направление выбрано</h2>
          <p className="onboarding-complete__description">
            {data.preset?.label
              ? `Вы указали: ${data.preset.label}${
                  data.industry_subtype
                    ? ` · ${
                        subtypes.find((s) => s.id === data.industry_subtype)
                          ?.label ?? data.industry_subtype
                      }`
                    : ""
                }.`
              : "Базовая настройка сохранена."}
          </p>
          {statusBlock}
          <div className="onboarding-complete__actions">
            <Link href="/solutions" className="button button--primary">
              К решениям
            </Link>
            {isBookingIndustry ? (
              <Link
                href="/bookings?tab=config"
                className="button button--outline"
              >
                Настроить запись
              </Link>
            ) : null}
            <button
              type="button"
              className="button button--outline"
              onClick={() => {
                if (
                  data.industry &&
                  !window.confirm(
                    "Мы обновим рекомендации, но ваши данные и уже подключённые функции сохранятся.\n\nПродолжить?",
                  )
                ) {
                  return;
                }
                setForceEdit(true);
              }}
            >
              Изменить выбор
            </button>
            <button
              type="button"
              className="button button--outline"
              disabled={busy}
              onClick={() => {
                setForceEdit(false);
                void patch({ setup_mode: "advanced" });
              }}
            >
              Расширенная настройка
            </button>
          </div>
        </div>
        <SetupChecklist
          businessId={businessId}
          progress={data.setup_progress}
          industry={data.industry}
          readiness={data.readiness}
        />
      </>
    ), (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
    ));
  }

  if (step === "industry") {
    return renderOnboardingCard((
      <section className="panel stack-md">
        <p className="eyebrow">Шаг 1 из 3</p>
        <h1 className="text-page-title">Настройка бизнеса</h1>
        <h2 className="text-section-title">Чем занимается ваш бизнес?</h2>
        <p className="text-body">
          Выберите направление — мы предложим подходящие инструменты и поможем
          всё настроить. Это можно изменить позже.
        </p>
        {statusBlock}
        <div className="industry-grid">
          {industries.map((card) => (
            <button
              key={card.id}
              type="button"
              className={
                "industry-card" +
                (data.industry === card.id ? " is-selected" : "")
              }
              disabled={busy}
              onClick={() => {
                if (!confirmIndustryChange(card.id)) return;
                void patch({
                  industry: card.id,
                  setup_mode: "guided",
                }).then((next) => {
                  if (next) setForceEdit(true);
                });
              }}
            >
              <strong>{card.label}</strong>
              <span>{card.hint}</span>
            </button>
          ))}
        </div>
        <div className="industry-advanced">
          <h3 className="text-card-title">Расширенная настройка</h3>
          <p className="text-body-sm">
            Пропустите подбор по отрасли и включите нужные возможности сами.
            Отрасль указывать не обязательно.
          </p>
          <button
            type="button"
            className="button button--outline"
            disabled={busy}
            onClick={() => {
              setForceEdit(false);
              void patch({ setup_mode: "advanced" });
            }}
          >
            Открыть расширенную настройку
          </button>
          <p className="text-caption" style={{ marginTop: 8 }}>
            ⚙️ Не уверены, какой вариант подходит? Настройте всё самостоятельно.
          </p>
        </div>
      </section>
    ), (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
    ));
  }

  if (step === "subtype") {
    return renderOnboardingCard((
      <section className="panel stack-md">
        <p className="eyebrow">Шаг 2 из 3 · {data.preset?.label}</p>
        <h1 className="text-page-title">Уточните формат</h1>
        <p className="text-body">Выберите ближайший вариант.</p>
        {statusBlock}
        <div className="industry-grid">
          {subtypes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={
                "industry-card" +
                (data.industry_subtype === item.id ? " is-selected" : "")
              }
              disabled={busy}
              onClick={() => {
                void patch({ industry_subtype: item.id }).then((next) => {
                  if (next) setForceEdit(true);
                });
              }}
            >
              <strong>{item.label}</strong>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={() => {
            void patch({ industry: null, industry_subtype: null }).then(() =>
              setForceEdit(true),
            );
          }}
        >
          Назад
        </button>
      </section>
    ), (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6v6H9z"/></svg>
    ));
  }

  return renderOnboardingCard((
    <section className="panel stack-md">
      <p className="eyebrow">Шаг 3 из 3 · {data.preset?.label}</p>
      <h1 className="text-page-title">Мы подготовили БизнеСоты для вашего бизнеса</h1>
      <p className="text-body">
        Это стартовый набор. Платные решения не подключаются автоматически —
        сохраняются только возможности и прогресс настройки.
      </p>
      {statusBlock}
      <ul className="setup-progress__list">
        {recommended.map((code) => (
          <li key={code}>
            <span aria-hidden>○</span> {SOLUTION_LABELS[code] ?? code}
          </li>
        ))}
      </ul>
      {data.preset?.optionalSolutions?.length ? (
        <>
          <FieldHint>По желанию позже:</FieldHint>
          <p className="text-body-sm">
            {data.preset.optionalSolutions
              .map((c) => SOLUTION_LABELS[c] ?? c)
              .join(" · ")}
          </p>
        </>
      ) : null}
      <div className="message-actions">
        <button
          type="button"
          className="button button--primary"
          disabled={busy}
          onClick={() => void applyRecommendations(data)}
        >
          Использовать рекомендации
        </button>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={() => {
            setForceEdit(true);
            if (subtypes.length > 1) {
              void patch({ industry_subtype: null });
            } else {
              void patch({ industry: null, industry_subtype: null });
            }
          }}
        >
          Изменить
        </button>
        <button
          type="button"
          className="button button--outline"
          disabled={busy}
          onClick={() => {
            setForceEdit(false);
            void patch({ setup_mode: "advanced" });
          }}
        >
          Перейти к расширенной настройке
        </button>
      </div>
      {isBookingIndustry ? (
        <FieldHint>
          После сохранения откройте настройку записи на странице онлайн-записи
          или по ссылке в чеклисте.
        </FieldHint>
      ) : null}
      {isBookingIndustry && data.setup_progress.industry ? (
        <Link href="/bookings?tab=config" className="text-link">
          Перейти к настройке записи
        </Link>
      ) : null}
    </section>
  ), (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
  ));
}