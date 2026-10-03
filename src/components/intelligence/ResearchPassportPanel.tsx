"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOsintResearch,
  launchOsintResearch,
  previewOsintResearch,
  saveOsintResearch,
} from "@/services/intelligence.service";
import type {
  OsintResearch,
  OsintResearchContent,
  OsintResearchGoal,
  OsintResearchPlan,
  OsintResearchUrl,
  OsintResearchUrlRole,
} from "@/lib/intelligence-types";

const STEPS = [
  "О бизнесе",
  "Что искать",
  "Источники и ограничения",
  "План исследования",
  "Запуск",
  "Результаты",
] as const;

const URL_ROLES: { value: OsintResearchUrlRole; label: string }[] = [
  { value: "official", label: "Официальный" },
  { value: "confirmed", label: "Подтверждён" },
  { value: "candidate", label: "Кандидат" },
  { value: "excluded", label: "Исключён" },
];

const EMPTY_CONTENT: OsintResearchContent = {
  formatVersion: 1,
  identification: {
    displayName: "",
    legalName: null,
    aliases: [],
    category: null,
    country: null,
    region: null,
    city: null,
    address: null,
    urls: [],
    domains: [],
    phones: [],
    emails: [],
    notes: null,
  },
  goals: {
    selected: [],
    importantNotes: null,
    excludeNotes: null,
    geoLimits: null,
    searchPhrases: [],
  },
};

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function goalLevelLabel(level: OsintResearchGoal["level"]): string {
  if (level === "supported") return "Поддерживается";
  if (level === "partial") return "Частично";
  return "Недоступно";
}

function launchStatusLabel(status: string): string {
  if (status === "completed") return "Готово";
  if (status === "failed") return "Ошибка";
  if (status === "running") return "Выполняется";
  return "В очереди";
}

export function ResearchPassportPanel({ businessId }: { businessId: string }) {
  const [research, setResearch] = useState<OsintResearch | null>(null);
  const [content, setContent] = useState<OsintResearchContent>(EMPTY_CONTENT);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [plan, setPlan] = useState<OsintResearchPlan | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [newUrl, setNewUrl] = useState("");
  /** Есть несохранённые правки — фоновая перезагрузка их не затирает. */
  const dirtyRef = useRef(false);

  const applyResearch = useCallback((data: OsintResearch) => {
    setResearch(data);
    if (dirtyRef.current) return;
    if (data.passport) {
      setContent(data.passport.content);
      setExpectedRevision(data.passport.revision);
    } else if (data.prefill) {
      const prefill = data.prefill;
      setContent({
        formatVersion: 1,
        identification: {
          displayName: prefill.displayName,
          legalName: null,
          aliases: prefill.aliases,
          category: prefill.category,
          country: null,
          region: prefill.region,
          city: prefill.city,
          address: prefill.address,
          urls: prefill.urls,
          domains: [],
          phones: prefill.phones,
          emails: prefill.emails,
          notes: prefill.notes,
        },
        goals: EMPTY_CONTENT.goals,
      });
      setExpectedRevision(null);
    }
  }, []);

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    queueMicrotask(() => {
      if (!alive) return;
      setLoading(true);
      setPlan(null);
      // notice намеренно НЕ очищаем: save()/launch() дёргают reloadKey сразу
      // после успешного действия, и вычистка в эффекте стёрла бы их сообщение.
      setError("");
    });
    getOsintResearch(businessId)
      .then((data) => {
        if (!alive) return;
        applyResearch(data);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof Error
            ? e.message
            : "Не удалось загрузить паспорт исследования.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, reloadKey, applyResearch]);

  const activeLaunch = research?.launch ?? null;
  const launchActive =
    activeLaunch?.status === "queued" || activeLaunch?.status === "running";

  // Статус активного запуска читается read-through — опрашиваем нежно.
  useEffect(() => {
    if (!launchActive) return;
    const timer = setInterval(() => setReloadKey((key) => key + 1), 5000);
    return () => clearInterval(timer);
  }, [launchActive]);

  const patchIdentification = (
    patch: Partial<OsintResearchContent["identification"]>,
  ) => {
    dirtyRef.current = true;
    setContent((prev) => ({
      ...prev,
      identification: { ...prev.identification, ...patch },
    }));
  };

  const patchGoals = (patch: Partial<OsintResearchContent["goals"]>) => {
    dirtyRef.current = true;
    setContent((prev) => ({ ...prev, goals: { ...prev.goals, ...patch } }));
  };

  const toggleGoal = (id: string) => {
    const selected = content.goals.selected.includes(
      id as OsintResearchContent["goals"]["selected"][number],
    );
    patchGoals({
      selected: selected
        ? content.goals.selected.filter((goal) => goal !== id)
        : [
            ...content.goals.selected,
            id as OsintResearchContent["goals"]["selected"][number],
          ],
    });
  };

  const setUrlRole = (url: string, role: OsintResearchUrlRole) => {
    patchIdentification({
      urls: content.identification.urls.map((entry) =>
        entry.url === url ? { ...entry, role } : entry,
      ),
    });
  };

  const removeUrl = (url: string) => {
    patchIdentification({
      urls: content.identification.urls.filter((entry) => entry.url !== url),
    });
  };

  const addUrl = () => {
    const value = newUrl.trim();
    if (!value) return;
    if (!/^https?:\/\/\S+$/i.test(value)) {
      setError("URL должен начинаться с http:// или https://");
      return;
    }
    if (
      content.identification.urls.some((entry) => entry.url === value)
    ) {
      setNewUrl("");
      return;
    }
    const next: OsintResearchUrl = { url: value, role: "candidate" };
    patchIdentification({ urls: [...content.identification.urls, next] });
    setNewUrl("");
    setError("");
  };

  const save = async () => {
    setSaving(true);
    setNotice("");
    setError("");
    try {
      const saved = await saveOsintResearch(businessId, {
        content,
        expectedRevision,
      });
      setExpectedRevision(saved.revision);
      dirtyRef.current = false;
      setNotice(`Паспорт сохранён — ревизия ${saved.revision}.`);
      setReloadKey((key) => key + 1);
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Не удалось сохранить паспорт.",
      );
    } finally {
      setSaving(false);
    }
  };

  const preview = async () => {
    setPreviewing(true);
    setNotice("");
    setError("");
    try {
      const result = await previewOsintResearch(businessId, { content });
      setPlan(result.plan);
      setStep(3);
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Не удалось построить план.",
      );
    } finally {
      setPreviewing(false);
    }
  };

  const launch = async () => {
    setLaunching(true);
    setNotice("");
    setError("");
    try {
      const outcome = await launchOsintResearch(businessId, {
        content,
        expectedRevision,
      });
      setExpectedRevision(outcome.passportRevision);
      dirtyRef.current = false;
      setNotice(
        outcome.created
          ? `Исследование запущено — ${outcome.runId ?? ""} стоит в очереди.`
          : "Активный запуск уже идёт — показан текущий.",
      );
      setStep(5);
      setReloadKey((key) => key + 1);
    } catch (e: unknown) {
      setError(
        e instanceof Error ? e.message : "Не удалось запустить исследование.",
      );
    } finally {
      setLaunching(false);
    }
  };

  if (loading && !research) {
    return (
      <section className="panel" aria-label="Паспорт OSINT-исследования">
        <h2 className="intelligence-section-title">
          Паспорт OSINT-исследования
        </h2>
        <p className="account-footnote">Загружаем паспорт…</p>
      </section>
    );
  }

  const nameMissing = !content.identification.displayName.trim();
  const goalsMissing = content.goals.selected.length === 0;

  return (
    <section
      className="panel"
      aria-label="Паспорт OSINT-исследования"
      data-testid="intelligence-research-panel"
    >
      <h2 className="intelligence-section-title">
        Паспорт OSINT-исследования
      </h2>
      <p className="account-footnote">
        Объясните системе, что искать: идентификация, цели, источники и план.
        Сохранение не запускает обход — запуск только по явной кнопке.
        {research?.passport
          ? ` Ревизия ${research.passport.revision} от ${new Date(
              research.passport.updatedAt,
            ).toLocaleString("ru-RU")}.`
          : ""}
      </p>

      <nav className="solution-setup-banner__actions" aria-label="Шаги">
        {STEPS.map((label, index) => (
          <button
            key={label}
            type="button"
            className={index === step ? "button button--primary" : "button button--outline"}
            aria-current={index === step ? "step" : undefined}
            data-testid={`research-step-${index + 1}`}
            onClick={() => setStep(index)}
          >
            {index + 1}. {label}
          </button>
        ))}
      </nav>

      {notice ? (
        <p role="status" className="account-footnote" data-testid="research-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="account-error" data-testid="research-error">
          {error}
        </p>
      ) : null}

      {step === 0 ? (
        <div data-testid="research-step-panel-1">
          <h3 className="intelligence-section-title">О бизнесе</h3>
          <p className="account-footnote">
            Значения из карточки бизнеса предложены как начальные — ничего не
            перезаписывается без вашего действия. Одно совпадение по названию
            не объединяет сущности автоматически.
          </p>
          <label className="field">
            <span className="field__label">Название бизнеса *</span>
            <input
              type="text"
              value={content.identification.displayName}
              maxLength={200}
              onChange={(event) =>
                patchIdentification({ displayName: event.target.value })
              }
              data-testid="research-display-name"
            />
          </label>
          <label className="field">
            <span className="field__label">Юридическое название</span>
            <input
              type="text"
              value={content.identification.legalName ?? ""}
              maxLength={200}
              onChange={(event) =>
                patchIdentification({
                  legalName: event.target.value || null,
                })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Альтернативные названия (по одному в строке)</span>
            <textarea
              rows={2}
              value={content.identification.aliases.join("\n")}
              onChange={(event) =>
                patchIdentification({ aliases: lines(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Категория / сфера деятельности</span>
            <input
              type="text"
              value={content.identification.category ?? ""}
              maxLength={120}
              onChange={(event) =>
                patchIdentification({ category: event.target.value || null })
              }
            />
          </label>
          <div className="intelligence-grid">
            <label className="field">
              <span className="field__label">Страна</span>
              <input
                type="text"
                value={content.identification.country ?? ""}
                maxLength={120}
                onChange={(event) =>
                  patchIdentification({ country: event.target.value || null })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Регион</span>
              <input
                type="text"
                value={content.identification.region ?? ""}
                maxLength={120}
                onChange={(event) =>
                  patchIdentification({ region: event.target.value || null })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">Город</span>
              <input
                type="text"
                value={content.identification.city ?? ""}
                maxLength={120}
                onChange={(event) =>
                  patchIdentification({ city: event.target.value || null })
                }
              />
            </label>
          </div>
          <label className="field">
            <span className="field__label">Адрес</span>
            <input
              type="text"
              value={content.identification.address ?? ""}
              maxLength={300}
              onChange={(event) =>
                patchIdentification({ address: event.target.value || null })
              }
            />
          </label>

          <h3 className="intelligence-section-title">URL и источники</h3>
          <ul className="setup-progress__list" data-testid="research-urls">
            {content.identification.urls.map((entry) => (
              <li key={entry.url}>
                <a href={entry.url} target="_blank" rel="noreferrer noopener">
                  {entry.url}
                </a>{" "}
                <label>
                  <span className="account-footnote">Роль: </span>
                  <select
                    value={entry.role}
                    onChange={(event) =>
                      setUrlRole(
                        entry.url,
                        event.target.value as OsintResearchUrlRole,
                      )
                    }
                  >
                    {URL_ROLES.map((role) => (
                      <option key={role.value} value={role.value}>
                        {role.label}
                      </option>
                    ))}
                  </select>
                </label>{" "}
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => removeUrl(entry.url)}
                >
                  Убрать
                </button>
              </li>
            ))}
            {content.identification.urls.length === 0 ? (
              <li className="account-footnote">
                URL пока не добавлены — официальный сайт и соцсети можно
                добавить здесь или оставить кандидатами.
              </li>
            ) : null}
          </ul>
          <div className="solution-setup-banner__actions">
            <label className="field">
              <span className="field__label">Дополнительный стартовый URL</span>
              <input
                type="url"
                value={newUrl}
                placeholder="https://example.ru"
                onChange={(event) => setNewUrl(event.target.value)}
                data-testid="research-new-url"
              />
            </label>
            <button
              type="button"
              className="button button--outline"
              onClick={addUrl}
            >
              Добавить URL
            </button>
          </div>
          {content.identification.domains.length ? (
            <p className="account-footnote">
              Домены: {content.identification.domains.join(", ")}
            </p>
          ) : null}

          <label className="field">
            <span className="field__label">Телефоны (по одному в строке)</span>
            <textarea
              rows={2}
              value={content.identification.phones.join("\n")}
              onChange={(event) =>
                patchIdentification({ phones: lines(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Публичная почта (по одному в строке)</span>
            <textarea
              rows={2}
              value={content.identification.emails.join("\n")}
              onChange={(event) =>
                patchIdentification({ emails: lines(event.target.value) })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">
              Заметки: как отличить бизнес от одноимённых организаций
            </span>
            <textarea
              rows={3}
              maxLength={1000}
              value={content.identification.notes ?? ""}
              onChange={(event) =>
                patchIdentification({ notes: event.target.value || null })
              }
            />
          </label>
        </div>
      ) : null}

      {step === 1 ? (
        <div data-testid="research-step-panel-2">
          <h3 className="intelligence-section-title">Что искать</h3>
          <ul className="setup-progress__list" data-testid="research-goals">
            {(research?.goals ?? []).map((goal) => (
              <li key={goal.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={content.goals.selected.includes(goal.id)}
                    onChange={() => toggleGoal(goal.id)}
                    data-testid={`research-goal-${goal.id}`}
                  />{" "}
                  <strong>{goal.label}</strong>
                </label>{" "}
                <span
                  className={
                    goal.level === "unsupported"
                      ? "account-error"
                      : "account-footnote"
                  }
                >
                  {goalLevelLabel(goal.level)}
                </span>
                <p className="account-footnote">{goal.description}</p>
                {goal.reason ? (
                  <p className="account-footnote">{goal.reason}</p>
                ) : null}
              </li>
            ))}
          </ul>

          <label className="field">
            <span className="field__label">Что особенно важно найти?</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={content.goals.importantNotes ?? ""}
              onChange={(event) =>
                patchGoals({ importantNotes: event.target.value || null })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Что не включать в исследование?</span>
            <textarea
              rows={3}
              maxLength={1000}
              value={content.goals.excludeNotes ?? ""}
              onChange={(event) =>
                patchGoals({ excludeNotes: event.target.value || null })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Географические ограничения</span>
            <textarea
              rows={2}
              maxLength={1000}
              value={content.goals.geoLimits ?? ""}
              onChange={(event) =>
                patchGoals({ geoLimits: event.target.value || null })
              }
            />
          </label>
          <label className="field">
            <span className="field__label">Временной горизонт</span>
            <input type="text" value="" disabled readOnly />
            <span className="account-footnote">
              Временной горизонт пока не поддерживается: система сравнивает
              текущее состояние с предыдущими запусками.
            </span>
          </label>
          <label className="field">
            <span className="field__label">
              Дополнительные поисковые фразы и ключевые слова (по одной в
              строке)
            </span>
            <textarea
              rows={3}
              value={content.goals.searchPhrases.join("\n")}
              onChange={(event) =>
                patchGoals({ searchPhrases: lines(event.target.value) })
              }
              data-testid="research-phrases"
            />
            <span className="account-footnote">
              Фразы становятся отдельными поисковыми запросами — это не
              произвольные инструкции для системы.
            </span>
          </label>
        </div>
      ) : null}

      {step === 2 ? (
        <div data-testid="research-step-panel-3">
          <h3 className="intelligence-section-title">
            Источники и ограничения
          </h3>
          <ul className="setup-progress__list" data-testid="research-providers">
            {(research?.providers ?? []).map((provider) => (
              <li key={`${provider.role}-${provider.id}`}>
                <strong>{provider.label}</strong>{" "}
                <span className="account-footnote">
                  {provider.role === "search" ? "поиск" : "обход страниц"}
                </span>{" "}
                <span
                  className={
                    provider.available ? "account-footnote" : "account-error"
                  }
                >
                  {provider.available
                    ? provider.willParticipate
                      ? "будет участвовать"
                      : "доступен"
                    : `недоступен: ${provider.reason ?? "нет конфигурации"}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="account-footnote">
            Политика источников: только публичные разрешённые источники, robots
            policy и защита от SSRF сохраняются. Исключённые URL (роль
            «Исключён») не попадают в очередь обхода — но страница может
            сослаться на них: полный запрет обхода на уровне переходов пока не
            реализован.
          </p>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void preview()}
            disabled={previewing || nameMissing}
            data-testid="research-preview"
          >
            {previewing ? "Строим план…" : "Показать план исследования"}
          </button>
          {nameMissing ? (
            <p className="account-footnote">
              Для плана нужно название бизнеса (шаг 1).
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 3 ? (
        <div data-testid="research-step-panel-4">
          <h3 className="intelligence-section-title">План исследования</h3>
          {plan ? (
            <div>
              <h4 className="intelligence-section-title">Цели</h4>
              <ul className="setup-progress__list">
                {plan.goals.map((goal) => (
                  <li key={goal.id}>
                    {goal.label} — {goalLevelLabel(goal.level)}
                    {goal.reason ? ` · ${goal.reason}` : ""}
                  </li>
                ))}
              </ul>

              <h4 className="intelligence-section-title">
                Источники, которые будут использованы
              </h4>
              <ul className="setup-progress__list">
                {plan.providers
                  .filter((provider) => provider.willParticipate)
                  .map((provider) => (
                    <li key={`${provider.role}-${provider.id}`}>
                      {provider.label} ({provider.role === "search" ? "поиск" : "обход"})
                    </li>
                  ))}
                {plan.providers.filter((p) => p.willParticipate).length ===
                0 ? (
                  <li className="account-footnote">
                    Ни один провайдер не участвует — запуск бессмысленно.
                  </li>
                ) : null}
              </ul>

              <h4 className="intelligence-section-title">
                Известные официальные источники
              </h4>
              <ul className="setup-progress__list">
                {plan.officialSources.map((entry) => (
                  <li key={entry.url}>{entry.url}</li>
                ))}
                {plan.officialSources.length === 0 ? (
                  <li className="account-footnote">
                    Пометьте официальный сайт ролью «Официальный» на шаге 1.
                  </li>
                ) : null}
              </ul>

              <h4 className="intelligence-section-title">
                Дополнительные URL и проверки
              </h4>
              <ul className="setup-progress__list">
                {plan.extraUrls.map((entry) => (
                  <li key={entry.url}>
                    {entry.url} —{" "}
                    {entry.role === "candidate" ? "кандидат" : "подтверждён"}
                  </li>
                ))}
                {plan.extraUrls.length === 0 ? (
                  <li className="account-footnote">Нет дополнительных URL.</li>
                ) : null}
              </ul>
              {plan.excludedUrls.length ? (
                <p className="account-footnote">
                  Исключены: {plan.excludedUrls.join(", ")}
                </p>
              ) : null}

              <h4 className="intelligence-section-title">
                Поисковые запросы ({plan.queries.length})
              </h4>
              <ul className="setup-progress__list" data-testid="research-queries">
                {plan.queries.map((query) => (
                  <li key={`${query.templateId}-${query.text}`}>
                    «{query.text}»
                    <span className="account-footnote">
                      {" "}
                      {query.servedBy.length
                        ? `· обслужат: ${query.servedBy.join(", ")}`
                        : "· никто не обслужит в этой сборке"}
                    </span>
                  </li>
                ))}
                {plan.queries.length === 0 ? (
                  <li className="account-footnote">Запросы не сформированы.</li>
                ) : null}
              </ul>

              <h4 className="intelligence-section-title">
                Обход и бюджет
              </h4>
              <ul className="setup-progress__list">
                <li>
                  Обход: {plan.crawl.enabled ? "включён" : "выключен"} ·
                  глубина {plan.crawl.maxDepth} · до {plan.crawl.maxPages}{" "}
                  страниц · {plan.crawl.maxRequests} запросов ·{" "}
                  {plan.crawl.maxTotalBytes} байт · {plan.crawl.maxDurationMs} мс
                </li>
                <li>
                  Поисковых запросов: до {plan.budget.maxQueries} · кандидатов:{" "}
                  до {plan.budget.maxCandidates}
                </li>
              </ul>

              <h4 className="intelligence-section-title">
                Что система не сможет проверить
              </h4>
              <ul className="setup-progress__list" data-testid="research-unsupported">
                {plan.unsupported.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <h4 className="intelligence-section-title">
                Требуют подтверждения
              </h4>
              <ul className="setup-progress__list">
                {plan.needsConfirmation.map((item) => (
                  <li key={item.url}>{item.url}</li>
                ))}
                {plan.needsConfirmation.length === 0 ? (
                  <li className="account-footnote">Нет.</li>
                ) : null}
              </ul>

              <h4 className="intelligence-section-title">
                Ожидаемые виды результата
              </h4>
              <ul className="setup-progress__list">
                {plan.results.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {plan.ignoredPhrases.length ? (
                <p className="account-error">
                  Отклонены как некорректные фразы:{" "}
                  {plan.ignoredPhrases.join(", ")}
                </p>
              ) : null}
              <p className="account-footnote">
                {plan.timeHorizon.reason}
              </p>
            </div>
          ) : (
            <p className="account-footnote">
              План ещё не построен — нажмите «Показать план исследования» на
              шаге 3.
            </p>
          )}
          <div className="solution-setup-banner__actions">
            <button
              type="button"
              className="button button--outline"
              onClick={() => void preview()}
              disabled={previewing}
            >
              {previewing ? "Строим план…" : "Обновить план"}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setStep(4)}
            >
              К запуску
            </button>
          </div>
        </div>
      ) : null}

      {step === 4 ? (
        <div data-testid="research-step-panel-5">
          <h3 className="intelligence-section-title">Запуск</h3>
          <p className="account-footnote">
            Сохранение не запускает обход. Запуск создаёт снимок паспорта и
            плана — изменение паспорта после запуска не меняет уже идущее
            исследование.
          </p>
          {nameMissing ? (
            <p className="account-error" role="alert">
              Укажите название бизнеса на шаге 1.
            </p>
          ) : null}
          {goalsMissing ? (
            <p className="account-error" role="alert">
              Выберите хотя бы одну цель на шаге 2.
            </p>
          ) : null}
          <div className="solution-setup-banner__actions">
            <button
              type="button"
              className="button button--outline"
              onClick={() => void save()}
              disabled={saving}
              data-testid="research-save"
            >
              {saving ? "Сохраняем…" : "Сохранить паспорт"}
            </button>
            <button
              type="button"
              className="button button--primary"
              onClick={() => void launch()}
              disabled={launching || nameMissing || goalsMissing || launchActive}
              data-testid="research-launch"
            >
              {launching ? "Запускаем…" : "Запустить исследование"}
            </button>
          </div>
          {launchActive && research?.launch ? (
            <p role="status" className="account-footnote">
              Уже идёт запуск: {launchStatusLabel(research.launch.status)}
              {research.launch.runId ? ` · run ${research.launch.runId}` : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      {step === 5 ? (
        <div data-testid="research-step-panel-6">
          <h3 className="intelligence-section-title">Результаты</h3>
          {research?.launch ? (
            <ul className="setup-progress__list" data-testid="research-launch-status">
              <li>
                Запуск от{" "}
                {new Date(research.launch.createdAt).toLocaleString("ru-RU")} —{" "}
                <strong>{launchStatusLabel(research.launch.status)}</strong>
                {research.launch.passportRevision !== null
                  ? ` · паспорт rev ${research.launch.passportRevision}`
                  : ""}
              </li>
              {research.launch.startedAt ? (
                <li>Начат: {new Date(research.launch.startedAt).toLocaleString("ru-RU")}</li>
              ) : null}
              {research.launch.finishedAt ? (
                <li>
                  Завершён:{" "}
                  {new Date(research.launch.finishedAt).toLocaleString("ru-RU")}
                </li>
              ) : null}
              {research.launch.error ? (
                <li className="account-error">{research.launch.error}</li>
              ) : null}
            </ul>
          ) : (
            <p className="account-footnote">
              Исследование ещё не запускалось — заполните паспорт и нажмите
              «Запустить исследование».
            </p>
          )}
          <p className="account-footnote">
            Кандидаты источников, сущности, факты, изменения и противоречия
            появятся ниже в блоке «Присутствие в открытом интернете» и в
            профиле бизнеса. История паспорта:{" "}
            {research?.history.length
              ? research.history
                  .map(
                    (item) =>
                      `rev ${item.revision} (${new Date(
                        item.createdAt,
                      ).toLocaleDateString("ru-RU")})`,
                  )
                  .join(" · ")
              : "пусто"}{" "}
            .
          </p>
        </div>
      ) : null}
    </section>
  );
}
