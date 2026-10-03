"use client";

import { useEffect, useState } from "react";
import {
  getOsintSnapshot,
  startOsintDiscovery,
} from "@/services/intelligence.service";
import type {
  OsintDiscoveryEnqueued,
  OsintSnapshot,
} from "@/lib/intelligence-types";
import {
  osintBridgeStatusLabel,
  osintProviderLabel,
  osintProviderState,
  osintRelationshipLabel,
  osintRunErrorSummary,
  osintRunStatusLabel,
  osintSourceStatusLabel,
  osintSourceTypeLabel,
  osintTrustLabel,
} from "@/lib/osintLabels";

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
      const outcome: OsintDiscoveryEnqueued = await startOsintDiscovery(
        businessId,
      );
      setNotice(
        `Запуск ${osintRunStatusLabel(outcome.status.toLowerCase())}: ` +
          `сайтов в обработке ${outcome.seeds} · обход пойдёт в фоне`,
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
    snapshot?.providers.some(
      (provider) => provider.enabledByDefault && provider.available,
    ),
  );

  return (
    <section className="panel" aria-label="Присутствие в открытом интернете" data-testid="osint-panel">
      <div className="solution-setup-banner__actions">
        <div>
          <h2 className="intelligence-section-title">
            Присутствие в открытом интернете
          </h2>
          {snapshot ? (
        <ul className="setup-progress__list" data-testid="osint-providers">
          {snapshot.providers.map((provider) => {
            const state = osintProviderState({
              available: provider.available,
              reason: provider.unavailableReason,
              policy: provider.policy,
            });
            return (
              <li key={provider.id} data-source-state={state.state}>
                <strong>{osintProviderLabel(provider.id, provider.label)}</strong>{" "}
                <span
                  className={
                    state.state === "ready" ? "account-footnote" : "account-error"
                  }
                >
                  {state.label}
                </span>
                {state.detail ? (
                  <span className="account-footnote"> — {state.detail}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="account-footnote">Загрузка источников…</p>
      )}
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
            {snapshot.runs.map((run) => {
              const problem = osintRunErrorSummary(run.error);
              return (
                <li key={run.id}>
                  {osintRunStatusLabel(run.status)} · {run.queriesCount} запросов ·{" "}
                  {run.candidatesCount} кандидатов ·{" "}
                  {new Date(run.createdAt).toLocaleString("ru-RU")}
                  {problem ? ` · ${problem}` : ""}
                </li>
              );
            })}
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
                {osintProviderLabel(candidate.provider)}
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
                {osintRelationshipLabel(entity.relationship)} (
                {osintBridgeStatusLabel(entity.bridgeStatus)})
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
                · {osintSourceTypeLabel(source.type)} ·{" "}
                {osintTrustLabel(source.trustLevel)} ·{" "}
                {osintSourceStatusLabel(source.status)}
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
