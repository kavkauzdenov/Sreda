"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Send,
  ShieldCheck,
  RotateCcw,
} from "lucide-react";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { SolutionIcon } from "@/components/solutions/SolutionIcon";
import {
  LEAD_FIELDS,
  newLeadSetupDraft,
  parseLeadSetupDraft,
  readLeadSetupDraftRaw,
  writeLeadSetupDraftRaw,
  type LeadSetupDraft,
  type LeadFieldId,
  type SetupChannel,
} from "@/lib/leadSetupDraft";
import type { Business } from "@/types";
import { apiRequest } from "@/lib/apiClient";
import { isDemoMode } from "@/lib/dataMode";
import { platformLabel } from "@/lib/labels";
const STEPS = ["Площадки", "Поля заявки", "Проверка", "Итог"];
function loadDraft(businessId: string) {
  if (!isDemoMode) return newLeadSetupDraft();
  try {
    return parseLeadSetupDraft(readLeadSetupDraftRaw(businessId));
  } catch {
    return newLeadSetupDraft();
  }
}
export function LeadsSetupView({ price }: { price: number }) {
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
        <ServerLeadsWizard
          key={`${business.id}:${business.role}`}
          business={business}
          price={price}
        />
      )}
    </div>
  );
}
function ServerLeadsWizard({
  business,
  price,
}: {
  business: Business;
  price: number;
}) {
  const [value, setValue] = useState<{
    draft: LeadSetupDraft;
    revision: number;
  } | null>(null);
  const [failure, setFailure] = useState("");
  useEffect(() => {
    if (isDemoMode) return;
    let cancelled = false;
    void apiRequest<{ draft: LeadSetupDraft; revision: number }>(
      `/api/v1/businesses/${encodeURIComponent(business.id)}/lead-setup`,
    )
      .then((result) => {
        if (!cancelled) setValue(result);
      })
      .catch((e) => {
        if (!cancelled)
          setFailure(
            e instanceof Error ? e.message : "Не удалось загрузить настройку.",
          );
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
  if (!isDemoMode && !value)
    return <LoadingPanel label="Загружаем сохранённую настройку" />;
  return (
    <LeadsWizard
      business={business}
      price={price}
      initialDraft={value?.draft}
      initialRevision={value?.revision ?? 0}
    />
  );
}
function LeadsWizard({
  business,
  price,
  initialDraft,
  initialRevision,
}: {
  business: Business;
  price: number;
  initialDraft?: LeadSetupDraft;
  initialRevision: number;
}) {
  const [draft, setDraft] = useState<LeadSetupDraft>(
    () => initialDraft ?? loadDraft(business.id),
  );
  const [storage, setStorage] = useState<"unchanged" | "saved" | "unavailable">(
    "unchanged",
  );
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(initialRevision);
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const canWrite =
    isDemoMode || business.role === "owner" || business.role === "admin";
  async function startTelegram() {
    setBusy(true);
    setError("");
    try {
      await apiRequest(
        `/api/v1/businesses/${encodeURIComponent(business.id)}/telegram/start`,
        { method: "POST", body: "{}" },
      );
      setStarted(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Не удалось запустить Telegram.",
      );
    } finally {
      setBusy(false);
    }
  }
  const [previewChannel, setPreviewChannel] = useState<SetupChannel>(
    draft.channels[0] ?? "telegram",
  );
  const [testSent, setTestSent] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstChannel = useRef<HTMLInputElement>(null);
  const previousStep = useRef(draft.step);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
    if (previousStep.current !== draft.step) {
      heading.current?.scrollIntoView({ block: "nearest" });
      previousStep.current = draft.step;
    }
  }, [draft.step]);
  async function update(next: LeadSetupDraft) {
    if (busy || !canWrite) return;
    if (!isDemoMode) {
      setBusy(true);
      setError("");
      try {
        const result = await apiRequest<{
          draft: LeadSetupDraft;
          revision: number;
        }>(`/api/v1/businesses/${encodeURIComponent(business.id)}/lead-setup`, {
          method: "POST",
          body: JSON.stringify({ draft: next, revision }),
        });
        setDraft(result.draft);
        setRevision(result.revision);
        setStorage("saved");
        setStarted(false);
        setTestSent(false);
      } catch (e) {
        setError(
          e instanceof Error ? e.message : "Не удалось сохранить настройку.",
        );
      } finally {
        setBusy(false);
      }
      return;
    }
    setDraft(next);
    setError("");
    setTestSent(false);
    if (!isDemoMode) return;
    try {
      writeLeadSetupDraftRaw(business.id, JSON.stringify(next));
      setStorage("saved");
    } catch {
      setStorage("unavailable");
    }
  }
  function nextStep() {
    if (!draft.channels.length) {
      setError("Выберите хотя бы одну площадку.");
      firstChannel.current?.focus();
      return;
    }
    update({
      ...draft,
      step: Math.min(3, draft.step + 1) as LeadSetupDraft["step"],
    });
  }
  function toggleChannel(channel: SetupChannel) {
    const channels = draft.channels.includes(channel)
      ? draft.channels.filter((item) => item !== channel)
      : [...draft.channels, channel];
    update({ ...draft, channels });
    if (!channels.includes(previewChannel))
      setPreviewChannel(channels[0] ?? "telegram");
  }
  function toggleField(id: LeadFieldId) {
    if (id === "name") return;
    const selected = draft.fields.includes(id)
      ? draft.fields.filter((item) => item !== id)
      : [...draft.fields, id];
    update({
      ...draft,
      fields: LEAD_FIELDS.filter((item) => selected.includes(item.id)).map(
        (item) => item.id,
      ),
    });
  }
  const fields = LEAD_FIELDS.filter((field) => draft.fields.includes(field.id));
  const activePreviewChannel = draft.channels.includes(previewChannel)
    ? previewChannel
    : (draft.channels[0] ?? "telegram");
  return (
    <>
      <header className="setup-intro">
        <SolutionIcon solution="leads" variant="feature" alt="" />
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
          ? "Предпросмотр настройки. Подключения и оплата не выполняются."
          : "Настройка сохраняется для этого бизнеса. Изменения останавливают сценарий до повторного запуска. Оплата пока не подключена."}
      </p>
      <ol className="setup-steps" aria-label="Шаги настройки">
        {STEPS.map((step, index) => (
          <li
            key={step}
            aria-current={draft.step === index ? "step" : undefined}
            className={index < draft.step ? "is-complete" : ""}
          >
            <span>{index < draft.step ? <Check size={16} /> : index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
      <div className="setup-layout">
        <section className="panel setup-form">
          <fieldset className="setup-editor" disabled={busy || !canWrite}>
            <span className="eyebrow">
              Шаг {draft.step + 1} из 4 · {business.name}
            </span>
            <h2 ref={heading} tabIndex={-1}>
              {
                [
                  "Где клиенты будут оставлять заявки?",
                  "Что спросим у клиента?",
                  "Посмотрите глазами клиента",
                  "Настройка подготовлена",
                ][draft.step]
              }
            </h2>
            {draft.step === 0 && (
              <>
                <p className="setup-description">
                  Выберите одну или обе площадки. Все заявки будут собраны в
                  одном месте.
                </p>
                <fieldset
                  className="setup-options"
                  aria-describedby={error ? "setup-error" : undefined}
                >
                  <legend className="sr-only">Площадки для заявок</legend>
                  {(["telegram", "vk", "whatsapp", "instagram"] as const).map(
                    (channel, index) => (
                    <label
                      key={channel}
                      className={`setup-option ${draft.channels.includes(channel) ? "is-selected" : ""}`}
                    >
                      <PlatformBadge platform={channel} compact />
                      <span>
                        <strong>
                          {channel === "telegram"
                            ? "Telegram"
                            : channel === "vk"
                              ? "ВКонтакте"
                              : channel === "whatsapp"
                                ? "WhatsApp"
                                : "Instagram"}
                        </strong>
                        <small>
                          {channel === "telegram"
                            ? "Ваш бот для клиентов"
                            : channel === "vk"
                              ? "Сообщество вашего бизнеса"
                              : channel === "whatsapp"
                                ? "WhatsApp Business (опционально)"
                                : "Instagram Direct (опционально)"}
                        </small>
                      </span>
                      <input
                        ref={index === 0 ? firstChannel : undefined}
                        type="checkbox"
                        checked={draft.channels.includes(channel)}
                        onChange={() => toggleChannel(channel)}
                        aria-label={
                          channel === "telegram"
                            ? "Telegram"
                            : channel === "vk"
                              ? "ВКонтакте"
                              : channel === "whatsapp"
                                ? "WhatsApp"
                                : "Instagram"
                        }
                      />
                    </label>
                  ),
                  )}
                </fieldset>
                <p className="setup-hint">
                  Выберите каналы приёма заявок. Подключение и запуск
                  выполняются в разделе «Подключения».
                </p>
              </>
            )}
            {draft.step === 1 && (
              <>
                <p className="setup-description">
                  Оставьте только нужные вопросы. Чем короче заявка, тем проще
                  её заполнить.
                </p>
                <div className="crm-panel">
                  <label>
                    Название сценария
                    <input
                      maxLength={100}
                      disabled={busy || !canWrite}
                      value={draft.title ?? "Оставить заявку"}
                      onChange={(e) =>
                        setDraft({ ...draft, title: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Приветствие
                    <textarea
                      maxLength={2000}
                      disabled={busy || !canWrite}
                      value={draft.greeting ?? ""}
                      placeholder="По умолчанию бот представится от имени бизнеса"
                      onChange={(e) =>
                        setDraft({ ...draft, greeting: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    Сообщение после отправки
                    <textarea
                      maxLength={2000}
                      disabled={busy || !canWrite}
                      value={draft.finalMessage ?? ""}
                      placeholder="Спасибо! Ваша заявка принята."
                      onChange={(e) =>
                        setDraft({ ...draft, finalMessage: e.target.value })
                      }
                    />
                  </label>
                </div>
                <fieldset className="setup-options">
                  <legend className="sr-only">Поля заявки</legend>
                  {LEAD_FIELDS.map((field) => (
                    <label
                      className={`field-option ${draft.fields.includes(field.id) ? "is-selected" : ""}`}
                      key={field.id}
                    >
                      <input
                        type="checkbox"
                        checked={draft.fields.includes(field.id)}
                        disabled={field.required}
                        onChange={() => toggleField(field.id)}
                      />
                      <span>
                        <strong>{field.label}</strong>
                        {field.required && <small>Обязательное поле</small>}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <div className="crm-panel">
                  {LEAD_FIELDS.filter((f) => draft.fields.includes(f.id)).map(
                    (f) => (
                      <fieldset key={f.id}>
                        <legend>{f.label}</legend>
                        <label>
                          Текст вопроса
                          <input
                            maxLength={150}
                            disabled={busy || !canWrite}
                            value={draft.fieldOptions?.[f.id]?.label ?? f.label}
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                fieldOptions: {
                                  ...draft.fieldOptions,
                                  [f.id]: {
                                    label: e.target.value,
                                    required:
                                      f.required ||
                                      draft.fieldOptions?.[f.id]?.required ||
                                      false,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            disabled={busy || !canWrite || f.required}
                            checked={
                              f.required ||
                              draft.fieldOptions?.[f.id]?.required ||
                              false
                            }
                            onChange={(e) =>
                              setDraft({
                                ...draft,
                                fieldOptions: {
                                  ...draft.fieldOptions,
                                  [f.id]: {
                                    label:
                                      draft.fieldOptions?.[f.id]?.label ||
                                      f.label,
                                    required: e.target.checked,
                                  },
                                },
                              })
                            }
                          />
                          Обязательный ответ
                        </label>
                      </fieldset>
                    ),
                  )}
                  <button
                    className="button button--outline"
                    disabled={busy || !canWrite}
                    onClick={() => void update(draft)}
                  >
                    Сохранить тексты и вопросы
                  </button>
                  <p>Получателей можно выбрать в разделе «Уведомления».</p>
                </div>
                <p className="setup-hint">
                  Выбрано вопросов: {fields.length}. Порядок вопросов показан в
                  предпросмотре.
                </p>
              </>
            )}
            {draft.step === 2 && (
              <>
                <p className="setup-description">
                  Это пример диалога с вымышленными ответами. Реальные сообщения
                  не отправляются.
                </p>
                <div
                  className="preview-channel-switch"
                  aria-label="Площадка предпросмотра"
                >
                  {draft.channels.map((channel) => (
                    <button
                      key={channel}
                      className="button button--outline"
                      aria-pressed={activePreviewChannel === channel}
                      onClick={() => {
                        setPreviewChannel(channel);
                        setTestSent(false);
                      }}
                    >
                      <PlatformBadge platform={channel} compact />
                      {platformLabel(channel)}
                    </button>
                  ))}
                </div>
                <div className="conversation-preview">
                  <div className="conversation-preview__heading">
                    <PlatformBadge platform={activePreviewChannel} compact />
                    <strong>{business.name}</strong>
                    <span>Пример</span>
                  </div>
                  <p className="chat-bubble">
                    Здравствуйте! Оставьте заявку — мы свяжемся с вами.
                  </p>
                  {fields.map((field) => (
                    <div key={field.id} className="chat-pair">
                      <p className="chat-bubble">
                        {field.label === "Имя"
                          ? "Как к вам обращаться?"
                          : field.label === "Телефон"
                            ? "Оставьте номер телефона для связи."
                            : field.label === "Что интересует"
                              ? "Что вас интересует?"
                              : "Хотите что-нибудь добавить?"}
                      </p>
                      <p className="chat-bubble chat-bubble--reply">
                        {field.example}
                      </p>
                    </div>
                  ))}
                  <button
                    className="button button--primary button--full"
                    onClick={() => setTestSent(true)}
                  >
                    <Send size={17} />
                    Показать результат заявки
                  </button>
                  {testSent && (
                    <div className="preview-success" role="status">
                      <CheckCircle2 size={20} />
                      <span>
                        <strong>Так будет выглядеть подтверждение</strong>
                        Спасибо! Ваша заявка принята. Мы скоро свяжемся с вами.
                        <small>
                          Это пример. Заявка в рабочем пространстве не
                          создавалась.
                        </small>
                      </span>
                    </div>
                  )}
                </div>
              </>
            )}
            {draft.step === 3 && (
              <>
                <div className="setup-complete-mark">
                  <CheckCircle2 size={34} />
                </div>
                <p className="setup-description">
                  Вы выбрали площадки и вопросы для клиентов. Черновик относится
                  к бизнесу {business.name}.
                </p>
                <div className="setup-review">
                  <div>
                    <span>Площадки</span>
                    <strong>
                      {draft.channels
                        .map((c) => platformLabel(c))
                        .join(" + ")}
                    </strong>
                  </div>
                  <div>
                    <span>Поля заявки</span>
                    <strong>
                      {fields.map((field) => field.label).join(", ")}
                    </strong>
                  </div>
                  <div>
                    <span>Стоимость после запуска</span>
                    <strong>{price} ₽/мес.</strong>
                  </div>
                </div>
                <p className="prototype-banner">
                  {isDemoMode
                    ? "Предпросмотр завершён. Это демонстрация."
                    : started
                      ? "Telegram подтвердил подключение. Отправьте боту /start для проверки первой заявки. Для ответов должен работать обработчик сообщений."
                      : "Подключите и запустите выбранные Telegram/VK-каналы в разделе «Подключения»."}
                </p>
                {!isDemoMode && (
                  <>
                    <Link
                      href="/connections"
                      className="button button--outline"
                    >
                      Подключения
                    </Link>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => void startTelegram()}
                    >
                      Запустить Telegram
                    </button>
                  </>
                )}
                <Link
                  href="/dashboard"
                  className="button button--primary button--full"
                >
                  В рабочее пространство
                  <ArrowRight size={18} />
                </Link>
              </>
            )}
            {error && (
              <p id="setup-error" className="setup-error" role="alert">
                {error}
              </p>
            )}
            <div className="setup-footer">
              {draft.step > 0 ? (
                <button
                  className="button button--outline"
                  onClick={() =>
                    update({
                      ...draft,
                      step: (draft.step - 1) as LeadSetupDraft["step"],
                    })
                  }
                >
                  <ArrowLeft size={17} />
                  Назад
                </button>
              ) : (
                <Link className="text-link" href="/solutions">
                  Вернуться позже
                </Link>
              )}
              {draft.step < 3 && (
                <button className="button button--primary" onClick={nextStep}>
                  {draft.step === 2
                    ? isDemoMode
                      ? "Завершить предпросмотр"
                      : "Завершить настройку"
                    : "Далее"}
                  <ArrowRight size={17} />
                </button>
              )}
            </div>
            <p className="draft-status" role="status">
              {!isDemoMode
                ? busy
                  ? "Сохраняем…"
                  : "Настройка хранится на сервере отдельно для этого бизнеса."
                : storage === "unavailable"
                  ? "Браузер не позволяет сохранить черновик. Не закрывайте страницу, чтобы не потерять выбор."
                  : storage === "saved"
                    ? "Черновик сохранён в этом браузере для выбранного бизнеса."
                    : "Ваш выбор сохраняется в этом браузере отдельно для каждого бизнеса."}
            </p>
            <button
              className="text-link"
              onClick={() => {
                update(newLeadSetupDraft());
                setPreviewChannel("telegram");
              }}
            >
              <RotateCcw size={15} />
              Начать настройку заново
            </button>
          </fieldset>
        </section>
        <aside className="setup-summary panel">
          <SolutionIcon solution="leads" variant="hero" />
          <h2>Заявки без лишней работы</h2>
          <p>
            Клиент отвечает на несколько вопросов. Вы получаете
            структурированную заявку и решаете, что делать дальше.
          </p>
          <ul>
            <li>
              <Check size={17} />
              Готовый сценарий
            </li>
            <li>
              <Check size={17} />
              Общие данные Telegram и VK
            </li>
            <li>
              <Check size={17} />
              Управление из браузера
            </li>
          </ul>
        </aside>
      </div>
    </>
  );
}
