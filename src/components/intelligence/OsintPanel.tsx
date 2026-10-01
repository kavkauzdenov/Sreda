"use client";

import { useEffect, useState } from "react";
import {
  getOsintSnapshot,
  startOsintDiscovery,
} from "@/services/intelligence.service";
import type {
  OsintDiscoveryRunOutcome,
  OsintSnapshot,
} from "@/lib/intelligence-types";

function runStatusLabel(status: string) {
  switch (status) {
    case "completed":
      return "Готово";
    case "partial":
      return "Частично";
    case "failed":
      return "Ошибка";
    case "running":
      return "Выполняется";
    case "queued":
      return "В очереди";
    default:
      return status;
  }
}

function candidateStatusLabel(status: string) {
  switch (status) {
    case "accepted":
      return "Принят";
    case "rejected":
      return "Отклонён";
    default:
      return "На проверке";
  }
}

export function OsintPanel({ businessId }: { businessId: string }) {
  const [snapshot, setSnapshot] = useState<OsintSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    queueMicrotask(() => setLoading(true));
    getOsintSnapshot(businessId)
      .then((data) => {
        if (!alive) return;
        setSnapshot(data);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить OSINT-данные.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId, reloadKey]);

  const start = async () => {
    setStarting(true);
    setNotice("");
    setError("");
    try {
      const outcome: OsintDiscoveryRunOutcome = await startOsintDiscovery(
        businessId,
      );
      setNotice(
        `Запуск ${runStatusLabel(outcome.status.toLowerCase())}: ` +
          `запросов ${outcome.queriesCount} · кандидатов ${outcome.candidatesCount}` +
          (outcome.errors.length ? ` · ${outcome.errors.join(", ")}` : ""),
      );
      setReloadKey((key) => key + 1);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось запустить сбор.");
    } finally {
      setStarting(false);
    }
  };

  const counts = snapshot?.counts;
  const canRun = Boolean(
    snapshot?.providers.some((provider) => provider.enabledByDefault),
  );

  return (
    <section className="panel" aria-label="Присутствие в открытом интернете" data-testid="osint-panel">
      <div className="solution-setup-banner__actions">
        <div>
          <h2 className="intelligence-section-title">
            Присутствие в открытом интернете
          </h2>
          <p className="account-footnote">
            {snapshot
              ? `Провайдеры: ${snapshot.providers
                  .map((provider) => `${provider.label} (${provider.policy})`)
                  .join(", ")}`
              : "Загрузка источников…"}
          </p>
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => void start()}
          disabled={starting || loading || !canRun}
        >
          {starting ? "Собираем…" : "Запустить сбор"}
        </button>
      </div>

      {notice ? (
        <p role="status" className="account-footnote">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="account-error">
          {error}
        </p>
      ) : null}
      {loading && !snapshot ? (
        <p className="account-footnote">Читаем knowledge graph…</p>
      ) : null}

      {counts ? (
        <ul className="clients-summary__cards">
          <li>
            <span>Кандидаты</span>
            <strong>{counts.candidates}</strong>
          </li>
          <li>
            <span>На проверке</span>
            <strong>{counts.pending}</strong>
          </li>
          <li>
            <span>Источники</span>
            <strong>{counts.sources}</strong>
          </li>
          <li>
            <span>Сущности</span>
            <strong>{counts.entities}</strong>
          </li>
        </ul>
      ) : null}

      {snapshot && snapshot.runs.length > 0 ? (
        <div>
          <h3 className="intelligence-section-title">Запуски</h3>
          <ul className="setup-progress__list">
            {snapshot.runs.map((run) => (
              <li key={run.id}>
                {runStatusLabel(run.status)} · {run.queriesCount} запросов ·{" "}
                {run.candidatesCount} кандидатов ·{" "}
                {new Date(run.createdAt).toLocaleString("ru-RU")}
                {run.error ? ` · ${run.error}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {snapshot && snapshot.candidates.length > 0 ? (
        <div>
          <h3 className="intelligence-section-title">Кандидаты</h3>
          <ul className="setup-progress__list">
            {snapshot.candidates.map((candidate) => (
              <li key={candidate.id}>
                <a
                  href={candidate.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {candidate.title || candidate.url}
                </a>{" "}
                · {candidateStatusLabel(candidate.status)} ·{" "}
                {candidate.provider}
                {candidate.matchReasons.length
                  ? ` · ${candidate.matchReasons.join(", ")}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {snapshot && snapshot.entities.length > 0 ? (
        <div>
          <h3 className="intelligence-section-title">Сущности</h3>
          <ul className="setup-progress__list">
            {snapshot.entities.map((entity) => (
              <li key={entity.id}>
                {entity.displayName}
                {entity.city ? ` · ${entity.city}` : ""} ·{" "}
                {entity.relationship} ({entity.bridgeStatus})
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {snapshot && snapshot.sources.length > 0 ? (
        <div>
          <h3 className="intelligence-section-title">Источники</h3>
          <ul className="setup-progress__list">
            {snapshot.sources.map((source) => (
              <li key={source.id}>
                <a
                  href={source.url}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  {source.name || source.url}
                </a>{" "}
                · {source.type} · {source.trustLevel} · {source.status}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {snapshot && snapshot.counts.candidates === 0 && !loading ? (
        <p className="account-footnote">
          Сбор ещё не запускался — нажмите «Запустить сбор», чтобы найти
          собственные сайты и соцсети бизнеса в открытом интернете.
        </p>
      ) : null}
    </section>
  );
}
