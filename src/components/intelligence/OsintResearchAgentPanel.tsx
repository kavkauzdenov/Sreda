"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getLatestOsintResearch,
  startOsintResearch,
} from "@/services/intelligence.service";
import type {
  OsintResearchMode,
  OsintResearchProgress,
  OsintResearchStarted,
} from "@/lib/intelligence-types";

/**
 * Панель автономного исследования (§31, §32, §51, §52).
 *
 * Главный сдвиг UX: пользователь видит не «провайдеры и их доступность»,
 * а ответ на вопрос «что система знает о моём бизнесе и что она делает
 * сейчас». Единственная кнопка — «Исследовать бизнес». Никаких API-ключей,
 * чек-листов целей и ручных списков источников.
 *
 * Недоступные источники показываются как состояние источника, а не как
 * ошибка: видно, что система пошла другой дорогой.
 */

const PHASE_LABELS: Record<string, string> = {
  idle: "Не запущено",
  planning: "Составляем план",
  searching: "Ищем упоминания",
  discovering: "Изучаем найденные страницы",
  extracting: "Извлекаем факты",
  resolving: "Сопоставляем сущности",
  enriching: "Собираем картину",
  evaluating: "Оцениваем полноту",
  saturating: "Исследование насыщается",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  completed: "Завершено",
  partial: "Завершено частично",
  failed: "Не удалось",
};

export function OsintResearchAgentPanel({ businessId }: { businessId: string }) {
  const [mode, setMode] = useState<OsintResearchMode>("standard");
  const [progress, setProgress] = useState<OsintResearchProgress | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(
    () =>
      getLatestOsintResearch(businessId)
        .then(setProgress)
        .catch(() => setProgress(null)),
    [businessId],
  );

  useEffect(() => {
    let alive = true;
    getLatestOsintResearch(businessId)
      .then((session) => {
        if (alive) setProgress(session);
      })
      .catch(() => {
        if (alive) setProgress(null);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  // Пока исследование идёт, подтягиваем прогресс. Частота скромная:
  // это фоновая задача, а не живой стрим.
  useEffect(() => {
    if (!progress) return;
    if (!["queued", "running"].includes(progress.status)) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [progress, load]);

  const start = async () => {
    setStarting(true);
    setError("");
    setNotice("");
    try {
      const outcome: OsintResearchStarted = await startOsintResearch(businessId, mode);
      setNotice(
        outcome.created
          ? "Исследование запущено — система сама определит, что искать."
          : "Исследование уже выполняется — показываем его прогресс.",
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось запустить исследование.");
    } finally {
      setStarting(false);
    }
  };

  const running = progress ? ["queued", "running"].includes(progress.status) : false;

  return (
    <section
      className="panel"
      aria-label="Исследование бизнеса"
      data-testid="osint-agent-panel"
    >
      <div className="solution-setup-banner__actions">
        <div>
          <h2 className="intelligence-section-title">Исследование бизнеса</h2>
          <p className="account-footnote">
            Система сама определит, что искать, где искать и когда остановиться.
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void start()}
          disabled={starting || running}
          data-testid="osint-agent-start"
        >
          {starting ? "Запускаем…" : running ? "Исследование идёт" : "Исследовать бизнес"}
        </button>
      </div>

      {!progress ? (
        <div className="empty-state empty-state--compact" data-testid="osint-agent-empty">
          <strong>Исследование ещё не запускалось</strong>
          <p className="empty-copy">
            Нажмите «Исследовать бизнес». Настраивать ничего не нужно — агент
            начнёт с названия и города и сам найдёт остальные подсказки.
          </p>
        </div>
      ) : (
        <>
          <div className="biznesoty-section-head" data-testid="osint-agent-status">
            <h3 className="intelligence-section-title">
              {STATUS_LABELS[progress.status] ?? "Выполняется"}
            </h3>
            <p>{PHASE_LABELS[progress.phase] ?? "Работаем"}</p>
          </div>

          <ul className="clients-summary__cards" data-testid="osint-agent-stats">
            <li>
              <span>Запросов выполнено</span>
              <strong>{progress.stats.completed}</strong>
            </li>
            <li>
              <span>В очереди</span>
              <strong>{progress.stats.pending}</strong>
            </li>
            <li>
              <span>Найдено фактов</span>
              <strong>{progress.stats.facts}</strong>
            </li>
          </ul>

          {progress.nextActions.length > 0 ? (
            <div data-testid="osint-agent-next">
              <h3 className="intelligence-section-title">Сейчас ищем</h3>
              <ul className="setup-progress__list">
                {progress.nextActions.map((action) => (
                  <li key={action.query}>
                    {action.query}
                    <span className="account-footnote"> — {action.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {progress.blockedSources.length > 0 ? (
            <div data-testid="osint-agent-blocked">
              <h3 className="intelligence-section-title">Источники недоступны</h3>
              <ul className="setup-progress__list">
                {progress.blockedSources.map((source) => (
                  <li key={`${source.name}:${source.status}`}>
                    {source.name}
                    <span className="account-footnote">
                      {" — "}
                      {source.detail || "Источник временно недоступен"}. {source.nextAction}.
                    </span>
                  </li>
                ))}
              </ul>
              <p className="account-footnote">
                Это состояние источника, а не сбой исследования: система ищет тот же факт
                другим путём.
              </p>
            </div>
          ) : null}

          {progress.unknown.length > 0 ? (
            <div data-testid="osint-agent-unknown">
              <h3 className="intelligence-section-title">Пока неизвестно</h3>
              <p className="empty-copy">{progress.unknown.join(", ")}</p>
            </div>
          ) : null}
        </>
      )}

      <div className="actions-row">
        <label className="account-footnote" htmlFor="osint-agent-mode">
          Глубина
        </label>
        <select
          id="osint-agent-mode"
          className="field__control field--sm"
          value={mode}
          onChange={(event) => setMode(event.target.value as OsintResearchMode)}
          disabled={running}
        >
          <option value="quick">Быстро</option>
          <option value="standard">Обычно</option>
          <option value="deep">Глубоко</option>
        </select>
      </div>

      {notice ? (
        <p role="status" className="account-footnote" data-testid="osint-agent-notice">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="account-error" data-testid="osint-agent-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
