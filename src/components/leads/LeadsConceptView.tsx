"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  CheckCircle2,
  ChevronRight,
  ClipboardList,
  Clock,
  FileText,
  MessageCircle,
  Plus,
  Search,
  Settings,
  Sparkles,
  UserRound,
  Users,
  Zap,
} from "lucide-react";
import { useBusinessContext } from "@/hooks/useBusinessContext";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { getLeadPage } from "@/services/leads.service";
import { apiRequest } from "@/lib/apiClient";
import { formatRelativeDateTime } from "@/lib/format";
import type { Lead, LeadStatus, Platform } from "@/types";

type ConceptTab = "work" | "form" | "automation" | "settings" | "stats";
type WorkFilter = "all" | "new" | "processing" | "done";

type FormField = {
  id: string;
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  active: boolean;
  position?: number;
  options?: unknown;
};

const TABS: {
  id: ConceptTab;
  label: string;
  icon: typeof ClipboardList;
}[] = [
  { id: "work", label: "Заявки", icon: ClipboardList },
  { id: "form", label: "Форма", icon: FileText },
  { id: "automation", label: "Автоматизация", icon: Zap },
  { id: "settings", label: "Настройки", icon: Settings },
  { id: "stats", label: "Статистика", icon: BarChart3 },
];

const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Новая",
  processing: "В работе",
  waiting_customer: "Ждём клиента",
  completed: "Завершена",
  rejected: "Неактуальна",
  closed: "Закрыта",
};

const FIELD_TYPE_LABEL: Record<string, string> = {
  name: "Короткий ответ",
  text: "Короткий ответ",
  textarea: "Длинный текст",
  message: "Длинный текст",
  phone: "Телефон",
  email: "Email",
  number: "Число",
  select: "Один вариант",
  multiselect: "Несколько вариантов",
  service: "Выбор услуги",
  checkbox: "Флажок",
  date: "Дата",
  address: "Адрес",
  budget: "Бюджет",
  attachment: "Файл",
};

function demoLeads(businessId: string): Lead[] {
  const now = Date.now();
  return [
    {
      id: "concept-lead-1",
      businessId,
      source: "telegram",
      name: "Анна",
      phone: "+7 900 123-45-67",
      message: "Хочу записаться сегодня после 18:00",
      status: "new",
      createdAt: new Date(now - 6 * 60_000).toISOString(),
      answers: {
        service: "Женская стрижка",
        comment: "Сегодня после 18:00",
      },
    },
    {
      id: "concept-lead-2",
      businessId,
      source: "vk",
      name: "Александр",
      phone: "+7 911 555-21-40",
      message: "Нужно узнать стоимость и ближайшее свободное время",
      status: "processing",
      processingName: "Иван",
      createdAt: new Date(now - 42 * 60_000).toISOString(),
      answers: {
        service: "Комплекс",
        comment: "Интересует ближайшее свободное время",
      },
    },
    {
      id: "concept-lead-3",
      businessId,
      source: "telegram",
      name: "Мария",
      message: "Спасибо, вопрос решён",
      status: "completed",
      processingName: "Анна",
      createdAt: new Date(now - 3 * 60 * 60_000).toISOString(),
      answers: {
        service: "Консультация",
      },
    },
  ];
}

function demoFields(): FormField[] {
  return [
    {
      id: "concept-field-name",
      fieldKey: "name",
      label: "Как вас зовут?",
      fieldType: "name",
      required: true,
      active: true,
      position: 0,
    },
    {
      id: "concept-field-phone",
      fieldKey: "phone",
      label: "Ваш номер телефона",
      fieldType: "phone",
      required: true,
      active: true,
      position: 1,
    },
    {
      id: "concept-field-service",
      fieldKey: "service",
      label: "Что вас интересует?",
      fieldType: "select",
      required: true,
      active: true,
      position: 2,
      options: ["Стрижка", "Борода", "Комплекс", "Другое"],
    },
    {
      id: "concept-field-comment",
      fieldKey: "comment",
      label: "Расскажите подробнее",
      fieldType: "textarea",
      required: false,
      active: true,
      position: 3,
    },
  ];
}

function formatConceptAnswer(value: unknown) {
  if (value == null || value === "") return "—";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return String(value);
  if (Array.isArray(value)) return value.map((item) => String(item)).join(", ");
  try {
    return JSON.stringify(value);
  } catch {
    return "—";
  }
}

function matchesFilter(lead: Lead, filter: WorkFilter) {
  if (filter === "all") return true;
  if (filter === "new") return lead.status === "new";
  if (filter === "processing")
    return lead.status === "processing" || lead.status === "waiting_customer";
  return ["completed", "closed", "rejected"].includes(lead.status);
}

export function LeadsConceptView() {
  const {
    businesses,
    currentBusiness,
    setCurrentBusinessId,
    isLoading,
    error,
    refreshBusinesses,
  } = useBusinessContext();
  const [tab, setTab] = useState<ConceptTab>("work");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [fields, setFields] = useState<FormField[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dataError, setDataError] = useState("");
  const [usingDemo, setUsingDemo] = useState(false);

  useEffect(() => {
    if (!currentBusiness) return;
    let active = true;
    Promise.all([
      getLeadPage(currentBusiness.id).catch(() => [] as Lead[]),
      apiRequest<FormField[]>(
        `/api/v1/businesses/${encodeURIComponent(currentBusiness.id)}/lead-form-fields`,
      ).catch(() => [] as FormField[]),
    ])
      .then(([leadRows, fieldRows]) => {
        if (!active) return;
        const realLeads = leadRows ?? [];
        const realFields = (fieldRows ?? []).filter((field) => field.active !== false);
        setLeads(realLeads.length ? realLeads : demoLeads(currentBusiness.id));
        setFields(realFields.length ? realFields : demoFields());
        setUsingDemo(realLeads.length === 0 && realFields.length === 0);
      })
      .catch((e) => {
        if (!active) return;
        setDataError(
          e instanceof Error ? e.message : "Не удалось загрузить данные для концепта.",
        );
        setLeads(demoLeads(currentBusiness.id));
        setFields(demoFields());
        setUsingDemo(true);
      })
      .finally(() => {
        if (active) setLoadingData(false);
      });
    return () => {
      active = false;
    };
  }, [currentBusiness]);

  return (
    <div className="leads-concept">
      <header className="leads-concept__header">
        <div className="leads-concept__title">
          <span className="eyebrow">Решение · концепт №1</span>
          <div className="leads-concept__title-row">
            <div>
              <h1>Приём заявок</h1>
              <p>
                Клиент оставляет заявку за минуту, а команда сразу видит, что нужно
                сделать и кто этим занимается.
              </p>
            </div>
            <div className="leads-concept__state" aria-label="Состояние решения">
              <span className="leads-concept__state-dot" />
              <div>
                <strong>Работает</strong>
                <small>Telegram · VK</small>
              </div>
            </div>
          </div>
        </div>
        <BusinessSwitcher
          businesses={businesses}
          currentBusiness={currentBusiness}
          onSelect={setCurrentBusinessId}
        />
      </header>

      <section className="leads-concept__notice" role="note">
        <Sparkles size={18} aria-hidden />
        <div>
          <strong>Интерактивный макет нового решения</strong>
          <span>
            Данные на этой странице не изменяются. Здесь можно оценить структуру,
            навигацию и внешний вид до глубокой переработки логики.
          </span>
        </div>
        <Link className="text-link" href="/leads">
          Текущая версия
          <ArrowRight size={16} aria-hidden />
        </Link>
      </section>

      {error ? (
        <section className="panel">
          <p className="account-error" role="alert">
            {error}
          </p>
          <button
            className="button button--outline"
            type="button"
            onClick={() => void refreshBusinesses().catch(() => undefined)}
          >
            Обновить доступ
          </button>
        </section>
      ) : isLoading || !currentBusiness ? (
        <LoadingPanel label="Загружаем бизнес" />
      ) : (
        <>
          <nav className="leads-concept__tabs" aria-label="Разделы приёма заявок">
            {TABS.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={tab === item.id ? "is-active" : undefined}
                  aria-current={tab === item.id ? "page" : undefined}
                  onClick={() => setTab(item.id)}
                >
                  <Icon size={18} aria-hidden />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>

          {dataError ? (
            <p className="account-error" role="alert">
              {dataError}
            </p>
          ) : null}
          {usingDemo ? (
            <p className="leads-concept__demo-note">
              В бизнесе пока нет данных для этого экрана — показываем пример, чтобы
              было видно будущую компоновку.
            </p>
          ) : null}

          {loadingData ? (
            <LoadingPanel label="Собираем экран решения" />
          ) : tab === "work" ? (
            <WorkTab leads={leads} />
          ) : tab === "form" ? (
            <FormTab fields={fields} />
          ) : tab === "automation" ? (
            <AutomationTab />
          ) : tab === "settings" ? (
            <SettingsTab />
          ) : (
            <StatsTab leads={leads} />
          )}
        </>
      )}
    </div>
  );
}

function WorkTab({ leads }: { leads: Lead[] }) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState(leads[0]?.id ?? "");

  const filtered = useMemo(() => {
    const value = query.trim().toLowerCase();
    return leads.filter((lead) => {
      if (!matchesFilter(lead, filter)) return false;
      if (!value) return true;
      return [lead.name, lead.phone, lead.message]
        .filter(Boolean)
        .some((part) => String(part).toLowerCase().includes(value));
    });
  }, [filter, leads, query]);

  const selected =
    leads.find((lead) => lead.id === selectedId) ?? filtered[0] ?? leads[0];

  const counts = {
    all: leads.length,
    new: leads.filter((lead) => lead.status === "new").length,
    processing: leads.filter(
      (lead) =>
        lead.status === "processing" || lead.status === "waiting_customer",
    ).length,
    done: leads.filter((lead) =>
      ["completed", "closed", "rejected"].includes(lead.status),
    ).length,
  };

  return (
    <section className="leads-concept__workspace" aria-label="Работа с заявками">
      <div className="leads-concept__list-column">
        <div className="leads-concept__section-head">
          <div>
            <span className="eyebrow">Работа</span>
            <h2>Заявки</h2>
          </div>
          <div className="leads-concept__head-actions">
            <button className="button button--outline" type="button" disabled>
              <Plus size={17} aria-hidden />
              Создать вручную
            </button>
          </div>
        </div>

        <div className="leads-concept__filters">
          {(
            [
              ["all", "Все"],
              ["new", "Новые"],
              ["processing", "В работе"],
              ["done", "Завершённые"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={filter === id ? "is-active" : undefined}
              onClick={() => setFilter(id)}
            >
              {label}
              <span>{counts[id]}</span>
            </button>
          ))}
        </div>

        <label className="leads-concept__search">
          <Search size={18} aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Имя, телефон или текст заявки"
          />
        </label>

        <div className="leads-concept__records">
          {filtered.length ? (
            filtered.map((lead) => (
              <button
                key={lead.id}
                type="button"
                className={
                  "leads-concept__record" +
                  (selected?.id === lead.id ? " is-selected" : "")
                }
                onClick={() => setSelectedId(lead.id)}
              >
                <span className="leads-concept__record-main">
                  <span className="leads-concept__avatar" aria-hidden>
                    {lead.name.trim().slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong>{lead.name}</strong>
                    <span>{lead.message || "Без комментария"}</span>
                    {lead.processingName ? (
                      <small>Ответственный · {lead.processingName}</small>
                    ) : null}
                  </span>
                </span>
                <span className="leads-concept__record-meta">
                  <PlatformBadge platform={lead.source as Platform} compact />
                  <span className={`status-chip status-chip--${lead.status}`}>
                    {STATUS_LABEL[lead.status]}
                  </span>
                  <time dateTime={lead.createdAt}>
                    {formatRelativeDateTime(lead.createdAt)}
                  </time>
                </span>
              </button>
            ))
          ) : (
            <div className="leads-concept__empty">
              <Search size={24} aria-hidden />
              <strong>Ничего не найдено</strong>
              <span>Попробуйте другой фильтр или запрос.</span>
            </div>
          )}
        </div>
      </div>

      <aside className="leads-concept__detail">
        {selected ? <LeadDetailPreview lead={selected} /> : null}
      </aside>
    </section>
  );
}

function LeadDetailPreview({ lead }: { lead: Lead }) {
  const answerRows = Object.entries(lead.answers ?? {}).filter(([, value]) => value);
  return (
    <>
      <div className="leads-concept__detail-head">
        <div>
          <span className="eyebrow">Заявка</span>
          <h2>{lead.name}</h2>
          <span className={`status-chip status-chip--${lead.status}`}>
            {STATUS_LABEL[lead.status]}
          </span>
        </div>
        <PlatformBadge platform={lead.source as Platform} />
      </div>

      <div className="leads-concept__contact-actions">
        <button type="button" className="button button--outline" disabled>
          <MessageCircle size={17} aria-hidden />
          Написать
        </button>
        <button type="button" className="button button--outline" disabled>
          <UserRound size={17} aria-hidden />
          Клиент
        </button>
      </div>

      <div className="leads-concept__detail-card">
        <h3>Ответы клиента</h3>
        {lead.phone ? (
          <div className="leads-concept__fact">
            <span>Телефон</span>
            <strong>{lead.phone}</strong>
          </div>
        ) : null}
        {answerRows.length ? (
          answerRows.map(([key, value]) => (
            <div className="leads-concept__fact" key={key}>
              <span>
                {key === "service"
                  ? "Что интересует"
                  : key === "comment"
                    ? "Комментарий"
                    : key}
              </span>
              <strong>{formatConceptAnswer(value)}</strong>
            </div>
          ))
        ) : (
          <div className="leads-concept__fact">
            <span>Комментарий</span>
            <strong>{lead.message || "—"}</strong>
          </div>
        )}
      </div>

      <div className="leads-concept__detail-card">
        <h3>Работа с заявкой</h3>
        {lead.processingName ? (
          <div className="leads-concept__assignee">
            <span className="leads-concept__avatar" aria-hidden>
              {lead.processingName.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <small>Ответственный</small>
              <strong>{lead.processingName}</strong>
            </div>
            <button className="text-link" type="button" disabled>
              Передать
            </button>
          </div>
        ) : (
          <button className="button button--primary" type="button" disabled>
            Взять в работу
          </button>
        )}
        <div className="leads-concept__internal-note">
          <strong>Внутренняя заметка</strong>
          <span>Видна только сотрудникам бизнеса.</span>
          <textarea
            rows={3}
            placeholder="Например: клиент просил перезвонить после 19:00"
            disabled
          />
        </div>
      </div>

      <div className="leads-concept__timeline">
        <h3>История</h3>
        <div>
          <span className="leads-concept__timeline-dot is-done" />
          <p>
            <strong>Заявка отправлена</strong>
            <small>{formatRelativeDateTime(lead.createdAt)}</small>
          </p>
        </div>
        {lead.processingName ? (
          <div>
            <span className="leads-concept__timeline-dot is-done" />
            <p>
              <strong>Принята в работу</strong>
              <small>{lead.processingName}</small>
            </p>
          </div>
        ) : null}
        <div>
          <span className="leads-concept__timeline-dot" />
          <p>
            <strong>Завершение</strong>
            <small>Следующее действие команды</small>
          </p>
        </div>
      </div>
    </>
  );
}

function FormTab({ fields }: { fields: FormField[] }) {
  const ordered = [...fields].sort(
    (a, b) => (a.position ?? 0) - (b.position ?? 0),
  );
  return (
    <section className="leads-concept__two-column">
      <div className="leads-concept__builder">
        <div className="leads-concept__section-head">
          <div>
            <span className="eyebrow">Форма</span>
            <h2>Что спросим у клиента</h2>
            <p>Одна форма для бизнеса. Вопросы задаются в Telegram и VK по одному.</p>
          </div>
          <button className="button button--outline" type="button" disabled>
            <Sparkles size={17} aria-hidden />
            Предложить с AI
          </button>
        </div>

        <div className="leads-concept__question-list">
          {ordered.map((field, index) => (
            <article className="leads-concept__question" key={field.id}>
              <span className="leads-concept__question-index">{index + 1}</span>
              <div>
                <strong>{field.label}</strong>
                <span>
                  {FIELD_TYPE_LABEL[field.fieldType] ?? field.fieldType}
                  {field.required ? " · обязательно" : " · необязательно"}
                </span>
                {field.fieldKey === "comment" || field.fieldKey === "message" ? (
                  <small>
                    Условие: можно показать только после выбранного ответа.
                  </small>
                ) : null}
              </div>
              <button type="button" className="leads-concept__chevron" disabled>
                <ChevronRight size={18} aria-hidden />
              </button>
            </article>
          ))}
        </div>

        <button className="button button--outline leads-concept__add-question" type="button" disabled>
          <Plus size={18} aria-hidden />
          Добавить вопрос
        </button>

        <div className="leads-concept__hint-card">
          <Bot size={20} aria-hidden />
          <div>
            <strong>Условные вопросы</strong>
            <span>
              Например: если клиент выбрал «Другое», показать дополнительный вопрос
              «Опишите, что вам нужно».
            </span>
          </div>
        </div>
      </div>

      <aside className="leads-concept__phone-preview">
        <div className="leads-concept__phone">
          <div className="leads-concept__phone-top">
            <span className="leads-concept__phone-dot" />
            <strong>Ваш бизнес</strong>
            <small>бот</small>
          </div>
          <div className="leads-concept__chat">
            <div className="leads-concept__bubble is-bot">
              Хотите оставить заявку? Ответьте на несколько вопросов — это займёт
              около минуты.
            </div>
            <div className="leads-concept__progress">
              <span>2 из {Math.max(ordered.length, 4)}</span>
              <i style={{ width: `${Math.min(100, 200 / Math.max(ordered.length, 4))}%` }} />
            </div>
            <div className="leads-concept__bubble is-bot">
              {ordered[1]?.label || "Ваш номер телефона"}
            </div>
            <div className="leads-concept__contact-button">Отправить номер</div>
            <div className="leads-concept__chat-actions">
              <span>← Назад</span>
              <span>Отменить заявку</span>
            </div>
          </div>
        </div>
        <p>
          Клиент видит простой диалог: один вопрос за раз, прогресс, «Назад» и
          возможность отменить сценарий.
        </p>
      </aside>
    </section>
  );
}

function AutomationTab() {
  return (
    <section className="leads-concept__cards-page">
      <div className="leads-concept__section-head">
        <div>
          <span className="eyebrow">Автоматизация</span>
          <h2>Как заявки двигаются без ручной рутины</h2>
          <p>Настройки собраны по смыслу, а не смешаны с конструктором формы.</p>
        </div>
      </div>

      <div className="leads-concept__settings-grid">
        <ConceptSetting
          icon={Users}
          title="Распределение"
          description="Выберите, кто получает новые заявки."
          value="Кто взял — тот работает"
          secondary="Можно включить автоназначение по очереди между выбранными сотрудниками."
        />
        <ConceptSetting
          icon={Bell}
          title="Если заявку не взяли"
          description="Напомнить команде о необработанной заявке."
          value="Через 15 минут"
          secondary="Повторное уведомление не создаёт дубли."
        />
        <ConceptSetting
          icon={MessageCircle}
          title="Сообщение клиенту"
          description="Ответ после успешной отправки."
          value="Спасибо! Мы получили вашу заявку."
          secondary="Можно изменить текст или предложить вариант с AI."
        />
        <ConceptSetting
          icon={Clock}
          title="Старые заявки"
          description="Закрывать неактивные обращения автоматически."
          value="Через 30 дней"
          secondary="Перед автозакрытием можно предупредить ответственного."
        />
      </div>
    </section>
  );
}

function SettingsTab() {
  return (
    <section className="leads-concept__cards-page">
      <div className="leads-concept__section-head">
        <div>
          <span className="eyebrow">Настройки</span>
          <h2>Системные параметры решения</h2>
          <p>Здесь остаётся только то, что влияет на работу функции целиком.</p>
        </div>
      </div>

      <div className="leads-concept__settings-grid">
        <ConceptSetting
          icon={Bot}
          title="Каналы"
          description="Где клиент может оставить заявку."
          value="Telegram · VK"
          secondary="Можно отключить решение на отдельной площадке."
        />
        <ConceptSetting
          icon={Users}
          title="Команда"
          description="Кто видит заявки и участвует в распределении."
          value="Владелец · Администраторы · Операторы"
          secondary="Права по-прежнему контролируются ролями бизнеса."
        />
        <ConceptSetting
          icon={CheckCircle2}
          title="Статусы"
          description="Внутренний workflow и публичный статус для клиента."
          value="Новая → В работе → Завершена"
          secondary="Внутренний статус можно назвать иначе, чем видит клиент."
        />
        <ConceptSetting
          icon={Settings}
          title="Состояние решения"
          description="Управление функцией без удаления истории."
          value="Работает"
          secondary="Приостановить · Отключить · Сбросить настройки."
        />
      </div>

      <div className="leads-concept__my-leads-preview">
        <div>
          <span className="eyebrow">Клиентский бот</span>
          <h3>«Мои заявки»</h3>
          <p>
            Клиент видит свои обращения, публичный статус, историю обновлений и
            может написать по конкретной заявке или отменить её, если это разрешено.
          </p>
        </div>
        <div className="leads-concept__customer-ticket">
          <span>Заявка №128</span>
          <strong>Женская стрижка</strong>
          <small>В работе · обновлено 12 минут назад</small>
          <div>
            <CheckCircle2 size={16} aria-hidden />
            Заявка отправлена
          </div>
          <div>
            <CheckCircle2 size={16} aria-hidden />
            Принята в работу
          </div>
          <div className="is-pending">
            <Clock size={16} aria-hidden />
            Ожидает завершения
          </div>
          <button className="button button--outline" type="button" disabled>
            Написать по заявке
          </button>
        </div>
      </div>
    </section>
  );
}

function StatsTab({ leads }: { leads: Lead[] }) {
  const total = leads.length;
  const newCount = leads.filter((lead) => lead.status === "new").length;
  const processing = leads.filter((lead) =>
    ["processing", "waiting_customer"].includes(lead.status),
  ).length;
  const done = leads.filter((lead) =>
    ["completed", "closed"].includes(lead.status),
  ).length;
  const telegram = leads.filter((lead) => lead.source === "telegram").length;
  const vk = leads.filter((lead) => lead.source === "vk").length;
  return (
    <section className="leads-concept__cards-page">
      <div className="leads-concept__section-head">
        <div>
          <span className="eyebrow">Статистика</span>
          <h2>Только показатели, которые помогают управлять заявками</h2>
          <p>Без перегруженной BI-панели внутри решения.</p>
        </div>
      </div>

      <div className="leads-concept__kpis">
        <Kpi label="Получено" value={String(total)} hint="за загруженный период" />
        <Kpi label="Новые" value={String(newCount)} hint="требуют внимания" />
        <Kpi label="В работе" value={String(processing)} hint="активные" />
        <Kpi label="Завершено" value={String(done)} hint="обработанные" />
      </div>

      <div className="leads-concept__stats-grid">
        <article className="leads-concept__stat-card">
          <h3>Источники заявок</h3>
          <div className="leads-concept__channel-row">
            <span>Telegram</span>
            <strong>{telegram}</strong>
            <i style={{ width: total ? `${Math.max(8, (telegram / total) * 100)}%` : "8%" }} />
          </div>
          <div className="leads-concept__channel-row">
            <span>VK</span>
            <strong>{vk}</strong>
            <i style={{ width: total ? `${Math.max(8, (vk / total) * 100)}%` : "8%" }} />
          </div>
        </article>
        <article className="leads-concept__stat-card">
          <h3>Что появится после полной реализации</h3>
          <ul>
            <li>Среднее время до взятия в работу</li>
            <li>Доля завершённых заявок</li>
            <li>Динамика по дням</li>
            <li>Популярные ответы / услуги</li>
          </ul>
        </article>
      </div>
    </section>
  );
}

function ConceptSetting({
  icon: Icon,
  title,
  description,
  value,
  secondary,
}: {
  icon: typeof Users;
  title: string;
  description: string;
  value: string;
  secondary: string;
}) {
  return (
    <article className="leads-concept__setting">
      <span className="leads-concept__setting-icon">
        <Icon size={20} aria-hidden />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
        <strong>{value}</strong>
        <small>{secondary}</small>
      </div>
      <ChevronRight size={18} aria-hidden />
    </article>
  );
}

function Kpi({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <article className="leads-concept__kpi">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}
