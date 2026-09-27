"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { SolutionIcon } from "@/components/solutions/SolutionIcon";
import { LeadFormBuilder, type LeadFormField } from "@/components/leads/LeadFormBuilder";
import { LeadPreview } from "@/components/leads/LeadPreview";
import { apiRequest, ClientError } from "@/lib/apiClient";
import { isDemoMode } from "@/lib/dataMode";
import { platformLabel } from "@/lib/labels";
import {
  LEAD_SETUP_STEPS,
  SLA_PRESETS,
  newLeadSetupV2,
  type LeadChannel,
  type LeadSetupV2,
} from "@/lib/leadSetupV2";
import type { Business } from "@/types";

type ReadinessCheck = {
  code: string;
  ok: boolean;
  message?: string;
  cta?: { label: string; href: string };
};

type Readiness = {
  ready: boolean;
  checks: ReadinessCheck[];
  setup: LeadSetupV2;
  revision: number;
};

const SLA_LABELS: Record<string, string> = {
  null: "Без ограничения",
  "15": "15 минут",
  "30": "30 минут",
  "60": "1 час",
  "120": "2 часа",
};

function humanCheckMessage(check: ReadinessCheck): string {
  if (check.message) return check.message;
  switch (check.code) {
    case "FORM_FIELDS":
      return "Форма заявки заполнена";
    case "MESSAGES":
      return "Тексты для клиента заполнены";
    case "CHANNELS":
      return "Выбран хотя бы один канал";
    case "CHANNEL_TELEGRAM":
      return "Telegram подключён и готов";
    case "CHANNEL_VK":
      return "ВКонтакте подключён и готов";
    case "ENTITLEMENT":
      return "Решение доступно";
    default:
      return "Проверка пройдена";
  }
}

function shouldShowCheck(check: ReadinessCheck): boolean {
  // Hide silent entitlement OK from UI; show only when failed or meaningful.
  if (check.code === "ENTITLEMENT" && check.ok) return false;
  return true;
}

export function LeadSetupWizard({ price }: { price: number }) {
  const { business, businesses, setBusinessId, isLoading, error } =
    useCurrentBusiness();

  return (
    <div className="setup-page">
      <div className="section-topline">
        <Link href="/solutions" className="text-link">
          <ArrowLeft size={17} />
          Все решения
        </Link>
        <BusinessSwitcher
          businesses={businesses}
          currentBusiness={business}
          onSelect={setBusinessId}
        />
      </div>
      {isLoading ? (
        <LoadingPanel label="Загружаем ваш бизнес" />
      ) : error || !business ? (
        <section className="panel load-error" role="alert">
          <h1>Не получилось загрузить бизнес</h1>
          <p>{error ?? "Выберите бизнес, чтобы продолжить."}</p>
          <button
            className="button button--outline"
            onClick={() => window.location.reload()}
          >
            Попробовать ещё раз
          </button>
        </section>
      ) : (
        <WizardBody
          key={`${business.id}:${business.role}`}
          business={business}
          price={price}
        />
      )}
    </div>
  );
}

function WizardBody({
  business,
  price,
}: {
  business: Business;
  price: number;
}) {
  const [draft, setDraft] = useState<LeadSetupV2 | null>(() =>
    isDemoMode ? newLeadSetupV2() : null,
  );
  const [revision, setRevision] = useState(0);
  const [failure, setFailure] = useState("");
  const [fields, setFields] = useState<LeadFormField[]>([]);
  const [staffTelegramAvailable, setStaffTelegramAvailable] = useState(false);

  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    void apiRequest<{ draft: LeadSetupV2; revision: number }>(
      `/api/v1/businesses/${encodeURIComponent(business.id)}/lead-setup`,
    )
      .then((result) => {
        if (cancelled) return;
        setDraft(result.draft?.version === 2 ? result.draft : newLeadSetupV2());
        setRevision(result.revision);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setFailure(
            e instanceof Error ? e.message : "Не удалось загрузить настройку.",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [business.id]);

  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    void apiRequest<{ items?: { platform: string; status: string }[] }>(
      `/api/v1/businesses/${encodeURIComponent(business.id)}/channel-admin`,
    )
      .then((data) => {
        if (cancelled) return;
        const items = data.items ?? [];
        setStaffTelegramAvailable(
          items.some(
            (item) => item.platform === "telegram" && item.status === "active",
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setStaffTelegramAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [business.id]);

  if (failure)
    return (
      <section className="panel">
        <p role="alert">{failure}</p>
        <button
          className="button button--outline"
          onClick={() => window.location.reload()}
        >
          Обновить страницу
        </button>
      </section>
    );

  if (!draft) return <LoadingPanel label="Загружаем сохранённую настройку" />;

  return (
    <WizardSteps
      business={business}
      price={price}
      initialDraft={draft}
      initialRevision={revision}
      fields={fields}
      onFieldsChange={setFields}
      staffTelegramAvailable={staffTelegramAvailable}
    />
  );
}

function WizardSteps({
  business,
  price,
  initialDraft,
  initialRevision,
  fields,
  onFieldsChange,
  staffTelegramAvailable,
}: {
  business: Business;
  price: number;
  initialDraft: LeadSetupV2;
  initialRevision: number;
  fields: LeadFormField[];
  onFieldsChange: (fields: LeadFormField[]) => void;
  staffTelegramAvailable: boolean;
}) {
  const [draft, setDraft] = useState<LeadSetupV2>(initialDraft);
  const [revision, setRevision] = useState(initialRevision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [readiness, setReadiness] = useState<Readiness | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef(draft.setupStep);
  const canWrite =
    isDemoMode || business.role === "owner" || business.role === "admin";

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (previousStep.current !== draft.setupStep) {
      heading.current?.scrollIntoView({ block: "nearest" });
      previousStep.current = draft.setupStep;
    }
  }, [draft.setupStep]);

  useEffect(() => {
    if (draft.setupStep !== 2 && draft.setupStep !== 6) return;
    if (isDemoMode) return;
    let cancelled = false;
    void apiRequest<Readiness>(
      `/api/v1/businesses/${encodeURIComponent(business.id)}/solutions/leads/readiness`,
    )
      .then((data) => {
        if (!cancelled) setReadiness(data);
      })
      .catch(() => {
        if (!cancelled) setReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [business.id, draft.setupStep, draft.channels]);

  async function save(next: LeadSetupV2, opts?: { silent?: boolean }) {
    if (busy || !canWrite) return null;
    if (isDemoMode) {
      setDraft(next);
      setNotice("Сохранено в демонстрации.");
      return next;
    }
    setBusy(true);
    setError("");
    if (!opts?.silent) setNotice("");
    try {
      const result = await apiRequest<{
        draft: LeadSetupV2;
        revision: number;
      }>(`/api/v1/businesses/${encodeURIComponent(business.id)}/lead-setup`, {
        method: "POST",
        body: JSON.stringify({ draft: next, revision }),
      });
      setDraft(result.draft);
      setRevision(result.revision);
      if (!opts?.silent) setNotice("Сохранено.");
      return result.draft;
    } catch (e) {
      setError(
        e instanceof ClientError || e instanceof Error
          ? e.message
          : "Не удалось сохранить настройку.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function goNext() {
    const step = draft.setupStep;
    if (step === 0) {
      if (!draft.buttonLabel.trim() || !draft.greeting.trim() || !draft.finalMessage.trim()) {
        setError("Заполните название кнопки, приветствие и финальный текст.");
        return;
      }
    }
    if (step === 2 && !draft.channels.length) {
      setError("Выберите хотя бы один канал: Telegram или ВКонтакте.");
      return;
    }
    const next: LeadSetupV2 = {
      ...draft,
      setupStep: Math.min(6, step + 1),
      // Email not saved — infra not exposed to client.
      notifications: {
        ...draft.notifications,
        email: false,
        staffTelegram: staffTelegramAvailable
          ? draft.notifications.staffTelegram
          : false,
      },
      processing: {
        ...draft.processing,
        autoAssign: false,
      },
      defaultStatus: "new",
    };
    await save(next);
  }

  async function goBack() {
    if (draft.setupStep <= 0) return;
    await save({ ...draft, setupStep: draft.setupStep - 1 });
  }

  function toggleChannel(channel: LeadChannel) {
    const channels = draft.channels.includes(channel)
      ? draft.channels.filter((c) => c !== channel)
      : [...draft.channels, channel];
    setDraft({ ...draft, channels });
  }

  async function launch() {
    if (!readiness?.ready) {
      setError("Сначала закройте пункты проверки.");
      return;
    }
    const next: LeadSetupV2 = {
      ...draft,
      completed: true,
      setupStep: 6,
      notifications: { ...draft.notifications, email: false },
      processing: { ...draft.processing, autoAssign: false },
      defaultStatus: "new",
    };
    const saved = await save(next);
    if (saved?.completed) {
      setNotice("Приём заявок запущен.");
    }
  }

  const step = draft.setupStep;
  const stepMeta = LEAD_SETUP_STEPS[step] ?? LEAD_SETUP_STEPS[0];

  const channelStatus = (channel: LeadChannel) => {
    const code = channel === "telegram" ? "CHANNEL_TELEGRAM" : "CHANNEL_VK";
    const check = readiness?.checks.find((c) => c.code === code);
    if (!draft.channels.includes(channel))
      return { label: "Не выбран", ok: null as boolean | null };
    if (!check) return { label: "Проверяем…", ok: null };
    return {
      label: check.ok
        ? "Подключён и готов"
        : check.message || "Нужно подключить",
      ok: check.ok,
      cta: check.cta,
    };
  };

  return (
    <>
      <header className="setup-intro">
        <SolutionIcon solution="leads" variant="hero" />
        <div>
          <span className="eyebrow">Готовое решение</span>
          <h1>Приём заявок</h1>
          <p>Клиенты оставляют заявку. Вы видите её в БизнеСотах.</p>
        </div>
        <div className="setup-price">
          <strong>{price} ₽</strong>
          <span>/ месяц</span>
        </div>
      </header>

      <p className="prototype-banner">
        <ShieldCheck size={18} />
        {isDemoMode
          ? "Предпросмотр настройки. Подключения не выполняются."
          : "Настройка сохраняется для этого бизнеса. Изменения останавливают приём заявок до повторного запуска."}
      </p>

      <ol className="setup-steps setup-steps--seven" aria-label="Шаги настройки">
        {LEAD_SETUP_STEPS.map((item) => (
          <li
            key={item.id}
            aria-current={step === item.id ? "step" : undefined}
            className={item.id < step ? "is-complete" : ""}
          >
            <span>
              {item.id < step ? <Check size={16} /> : item.id + 1}
            </span>
            {item.title}
          </li>
        ))}
      </ol>

      <div className="setup-layout">
        <section className="panel setup-form">
          <fieldset className="setup-editor" disabled={busy || !canWrite}>
            <span className="eyebrow">
              Шаг {step + 1} из 7 · {business.name}
            </span>
            <h2 ref={heading} tabIndex={-1}>
              {stepMeta.title}
            </h2>

            {step === 0 && (
              <>
                <p className="setup-description">
                  Настройте тексты, которые увидит клиент в начале и в конце
                  заявки.
                </p>
                <label className="field">
                  <span className="field__label">Текст кнопки</span>
                  <input
                    className="field__control"
                    maxLength={100}
                    value={draft.buttonLabel}
                    onChange={(e) =>
                      setDraft({ ...draft, buttonLabel: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field__label">Приветствие</span>
                  <textarea
                    className="field__control"
                    maxLength={2000}
                    rows={3}
                    value={draft.greeting}
                    onChange={(e) =>
                      setDraft({ ...draft, greeting: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span className="field__label">Сообщение после заявки</span>
                  <textarea
                    className="field__control"
                    maxLength={2000}
                    rows={3}
                    value={draft.finalMessage}
                    onChange={(e) =>
                      setDraft({ ...draft, finalMessage: e.target.value })
                    }
                  />
                </label>
                <LeadPreview
                  businessName={business.name}
                  buttonLabel={draft.buttonLabel}
                  greeting={draft.greeting}
                  finalMessage={draft.finalMessage}
                  channels={draft.channels}
                  fields={fields}
                />
              </>
            )}

            {step === 1 && (
              <>
                <p className="setup-description">
                  Выберите шаблон или соберите вопросы сами. Поле «Имя» всегда
                  остаётся в форме.
                </p>
                <LeadFormBuilder
                  businessId={business.id}
                  canEdit={canWrite && !isDemoMode}
                  onFieldsChange={onFieldsChange}
                />
              </>
            )}

            {step === 2 && (
              <>
                <p className="setup-description">
                  Выберите, где клиенты будут оставлять заявки. Подключение
                  каналов — в разделе «Подключения».
                </p>
                <fieldset className="setup-options">
                  <legend className="sr-only">Каналы</legend>
                  {(["telegram", "vk"] as const).map((channel) => {
                    const status = channelStatus(channel);
                    return (
                      <label
                        key={channel}
                        className={
                          "setup-option" +
                          (draft.channels.includes(channel)
                            ? " is-selected"
                            : "")
                        }
                      >
                        <PlatformBadge platform={channel} compact />
                        <span>
                          <strong>{platformLabel(channel)}</strong>
                          <small>
                            {status.label}
                            {status.cta ? (
                              <>
                                {" · "}
                                <Link href={status.cta.href} className="text-link">
                                  {status.cta.label}
                                </Link>
                              </>
                            ) : null}
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={draft.channels.includes(channel)}
                          onChange={() => toggleChannel(channel)}
                          aria-label={platformLabel(channel)}
                        />
                      </label>
                    );
                  })}
                </fieldset>
              </>
            )}

            {step === 3 && (
              <>
                <p className="setup-description">
                  Как команда будет обрабатывать новые заявки.
                </p>
                <div className="detail-facts">
                  <span>Статус новой заявки</span>
                  <strong>Новая</strong>
                </div>
                <div className="detail-facts">
                  <span>Назначение</span>
                  <strong>Сотрудник нажимает «Взять в работу»</strong>
                </div>
                <label className="capability-row">
                  <input
                    type="checkbox"
                    checked={draft.processing.duplicateDetection}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        processing: {
                          ...draft.processing,
                          duplicateDetection: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>
                    <strong>Предупреждать о похожих заявках</strong>
                    <small>
                      Если клиент уже оставлял заявку недавно — покажем
                      подсказку.
                    </small>
                  </span>
                </label>
                <label className="field">
                  <span className="field__label">
                    Время первой реакции
                  </span>
                  <select
                    className="field__control"
                    value={String(draft.processing.firstResponseSlaMinutes)}
                    onChange={(e) => {
                      const raw = e.target.value;
                      setDraft({
                        ...draft,
                        processing: {
                          ...draft.processing,
                          firstResponseSlaMinutes:
                            raw === "null" ? null : Number(raw),
                        },
                      });
                    }}
                  >
                    {SLA_PRESETS.map((mins) => (
                      <option key={String(mins)} value={String(mins)}>
                        {SLA_LABELS[String(mins)]}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}

            {step === 4 && (
              <>
                <p className="setup-description">
                  Куда приходят уведомления о новых заявках.
                </p>
                <label className="capability-row">
                  <input
                    type="checkbox"
                    checked={draft.notifications.inApp}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        notifications: {
                          ...draft.notifications,
                          inApp: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>
                    <strong>В приложении</strong>
                    <small>Уведомления внутри БизнеСот.</small>
                  </span>
                </label>
                {staffTelegramAvailable ? (
                  <label className="capability-row">
                    <input
                      type="checkbox"
                      checked={draft.notifications.staffTelegram}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          notifications: {
                            ...draft.notifications,
                            staffTelegram: e.target.checked,
                          },
                        })
                      }
                    />
                    <span>
                      <strong>В личный Telegram сотрудников</strong>
                      <small>
                        Для сотрудников с привязанным Telegram в настройках.
                      </small>
                    </span>
                  </label>
                ) : (
                  <p className="field-hint">
                    Уведомления в Telegram станут доступны после привязки
                    личного Telegram в настройках аккаунта.
                  </p>
                )}
              </>
            )}

            {step === 5 && (
              <>
                <p className="setup-description">
                  Так клиент увидит сценарий заявки. Это пример — сообщения не
                  отправляются.
                </p>
                <LeadPreview
                  businessName={business.name}
                  buttonLabel={draft.buttonLabel}
                  greeting={draft.greeting}
                  finalMessage={draft.finalMessage}
                  channels={draft.channels}
                  fields={fields}
                />
              </>
            )}

            {step === 6 && (
              <>
                <p className="setup-description">
                  Проверьте готовность и запустите приём заявок.
                </p>
                <ul className="setup-progress__list" aria-label="Проверки">
                  {(readiness?.checks ?? [])
                    .filter(shouldShowCheck)
                    .map((check) => (
                      <li
                        key={check.code}
                        className={check.ok ? "is-done" : ""}
                      >
                        <span aria-hidden>{check.ok ? "✓" : "○"}</span>
                        {humanCheckMessage(check)}
                        {!check.ok && check.cta ? (
                          <>
                            {" — "}
                            <Link href={check.cta.href} className="text-link">
                              {check.cta.label}
                            </Link>
                          </>
                        ) : null}
                      </li>
                    ))}
                  {!readiness && !isDemoMode ? (
                    <li>Загружаем проверки…</li>
                  ) : null}
                  {isDemoMode ? (
                    <li className="is-done">
                      <span aria-hidden>✓</span>
                      Демо-режим: проверки условные
                    </li>
                  ) : null}
                </ul>
                <div className="setup-review">
                  <div>
                    <span>Каналы</span>
                    <strong>
                      {draft.channels.length
                        ? draft.channels.map(platformLabel).join(" + ")
                        : "Не выбраны"}
                    </strong>
                  </div>
                  <div>
                    <span>Полей в форме</span>
                    <strong>{fields.length || "—"}</strong>
                  </div>
                  <div>
                    <span>Стоимость</span>
                    <strong>{price} ₽/мес.</strong>
                  </div>
                </div>
                {draft.completed ? (
                  <p className="account-notice" role="status">
                    <CheckCircle2 size={18} /> Приём заявок уже запущен.{" "}
                    <Link href="/leads" className="text-link">
                      Открыть заявки
                    </Link>
                  </p>
                ) : (
                  <button
                    type="button"
                    className="button button--primary button--full"
                    disabled={
                      busy ||
                      !canWrite ||
                      (!isDemoMode && !readiness?.ready)
                    }
                    onClick={() => void launch()}
                  >
                    {busy ? "Запускаем…" : "Запустить приём заявок"}
                    <ArrowRight size={18} />
                  </button>
                )}
              </>
            )}

            {error ? (
              <p id="setup-error" className="setup-error" role="alert">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="account-notice" role="status" aria-live="polite">
                {notice}
              </p>
            ) : null}
            {!canWrite ? (
              <p className="field-hint">
                Изменять настройку могут владелец и администратор.
              </p>
            ) : null}

            <div className="setup-footer">
              {step > 0 ? (
                <button
                  type="button"
                  className="button button--outline"
                  disabled={busy}
                  onClick={() => void goBack()}
                >
                  Назад
                </button>
              ) : (
                <span />
              )}
              {step < 6 ? (
                <button
                  type="button"
                  className="button button--primary"
                  disabled={busy || !canWrite}
                  onClick={() => void goNext()}
                >
                  Далее
                  <ArrowRight size={18} />
                </button>
              ) : null}
            </div>
          </fieldset>
        </section>

        <aside className="setup-side panel" aria-label="Подсказка">
          <span className="eyebrow">Подсказка</span>
          <h3>
            {
              [
                "Короткие тексты — выше отклик",
                "Спрашивайте только нужное",
                "Сначала подключите каналы",
                "Сотрудник сам берёт заявку",
                "Уведомления помогают не пропустить",
                "Проверьте глазами клиента",
                "Запуск включает приём заявок",
              ][step]
            }
          </h3>
          <p>
            {
              [
                "Кнопка и приветствие — первое, что видит клиент.",
                "Чем короче форма, тем чаще её заполняют до конца.",
                "Telegram и ВКонтакте — основные каналы для заявок.",
                "Автоназначение отключено: ответственный выбирается вручную.",
                "В приложении уведомления включены по умолчанию.",
                "Предпросмотр не отправляет сообщения клиентам.",
                "После запуска заявки появятся в разделе «Заявки».",
              ][step]
            }
          </p>
        </aside>
      </div>
    </>
  );
}
