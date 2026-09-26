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
  const nextSetupStep = resolveSetupSteps({
    steps: setupStepsForIndustry(data.industry),
    progress: data.setup_progress,
    readiness: data.readiness,
  }).next;
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

  if (step === "advanced") {
    return (
      <div className="setup-page stack-lg">
        {statusBlock}
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
            {nextSetupStep ? (
              <Link href={nextSetupStep.href} className="button button--primary">
                {nextSetupStep.label}
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
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="setup-page stack-lg">
        <section className="panel stack-md">
          <span className="eyebrow">Готово</span>
          <h1 className="text-page-title">Направление выбрано</h1>
          <p className="text-body">
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
          <div className="message-actions">
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
        </section>
        <SetupChecklist
          businessId={businessId}
          progress={data.setup_progress}
          industry={data.industry}
          readiness={data.readiness}
        />
      </div>
    );
  }

  if (step === "industry") {
    return (
      <div className="setup-page">
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
      </div>
    );
  }

  if (step === "subtype") {
    return (
      <div className="setup-page">
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
      </div>
    );
  }

  return (
    <div className="setup-page">
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
    </div>
  );
}
