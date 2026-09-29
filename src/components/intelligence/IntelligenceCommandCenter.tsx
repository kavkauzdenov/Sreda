"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BusinessSwitcher } from "@/components/dashboard/BusinessSwitcher";
import { LoadingPanel } from "@/components/dashboard/LoadingPanel";
import { getIntelligenceOverview } from "@/services/intelligence.service";
import type {
  BusinessInsight,
  BusinessRecommendation,
  IntelligenceOverview,
} from "@/lib/intelligence-types";
import { useCurrentBusiness } from "@/hooks/useCurrentBusiness";
import { APP_TAGLINE } from "@/config/brand";

function severityLabel(severity: string) {
  switch (severity) {
    case "critical":
      return "Критично";
    case "high":
      return "Высокий";
    case "medium":
      return "Средний";
    default:
      return "Низкий";
  }
}

function InsightCard({
  insight,
  onPreviewRec,
}: {
  insight: BusinessInsight;
  onPreviewRec: (rec: BusinessRecommendation) => void;
}) {
  return (
    <article
      className={`intelligence-card intelligence-card--${insight.severity}`}
      data-testid={`intelligence-insight-${insight.type}`}
    >
      <header className="intelligence-card__head">
        <span className="intelligence-card__severity">
          {severityLabel(insight.severity)}
        </span>
        <h3>{insight.title}</h3>
      </header>
      <p>{insight.description}</p>
      <details className="intelligence-evidence">
        <summary>На каких данных основан вывод</summary>
        <ul>
          {insight.evidence.map((e) => (
            <li key={e.metric}>
              <code>{e.metric}</code>: {e.current}
              {e.previous !== undefined ? ` (было ${e.previous})` : ""}
              {e.sampleSize !== undefined ? ` · выборка ${e.sampleSize}` : ""}
            </li>
          ))}
        </ul>
      </details>
      <p className="account-footnote">{insight.impact}</p>
      <button
        type="button"
        className="button button--ghost"
        onClick={() =>
          onPreviewRec({
            id: insight.id,
            insightId: insight.id,
            title: "Подробнее",
            reason: insight.description,
            expectedEffect: insight.impact,
            risk: "",
            actionType: "preview",
            status: "open",
          })
        }
      >
        Подробнее
      </button>
    </article>
  );
}

function RecommendationCard({
  rec,
  onPreview,
}: {
  rec: BusinessRecommendation;
  onPreview: (rec: BusinessRecommendation) => void;
}) {
  return (
    <article className="intelligence-card intelligence-card--rec">
      <h3>{rec.title}</h3>
      <p className="account-footnote">{rec.reason}</p>
      <div className="solution-setup-banner__actions">
        <button
          type="button"
          className="button button--outline"
          onClick={() => onPreview(rec)}
        >
          Посмотреть действие
        </button>
        {rec.href ? (
          <Link href={rec.href} className="button button--primary">
            Открыть раздел
          </Link>
        ) : null}
      </div>
    </article>
  );
}

export function IntelligenceCommandCenter() {
  const {
    businessId,
    business,
    businesses,
    setBusinessId,
  } = useCurrentBusiness();
  const [overview, setOverview] = useState<IntelligenceOverview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [previewRec, setPreviewRec] = useState<BusinessRecommendation | null>(
    null,
  );

  useEffect(() => {
    if (!businessId) return;
    let alive = true;
    queueMicrotask(() => setLoading(true));
    void getIntelligenceOverview(businessId)
      .then((data) => {
        if (!alive) return;
        setOverview(data);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setOverview(null);
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить Intelligence.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  if (!businessId) {
    return <LoadingPanel label="Выберите пространство…" />;
  }

  if (loading && !overview) {
    return <LoadingPanel label="Анализируем доступные данные…" />;
  }

  return (
    <div className="intelligence-page" data-testid="intelligence-page">
      <header className="intelligence-page__header">
        <div>
          <p className="account-footnote">{APP_TAGLINE}</p>
          <h1>Business Intelligence</h1>
        </div>
        <BusinessSwitcher
          businesses={businesses}
          currentBusiness={business}
          onSelect={setBusinessId}
        />
      </header>

      {error ? (
        <p className="account-error" role="alert">
          {error}
        </p>
      ) : null}

      {overview ? (
        <>
          {overview.dataMode === "demo" ? (
            <p className="intelligence-demo-banner" role="status">
              DEMO — синтетические данные для демонстрации
            </p>
          ) : null}

          <section className="panel intelligence-hero" aria-label="Статус">
            <p className="intelligence-hero__greeting">Сводка по бизнесу</p>
            <p className="intelligence-hero__text">{overview.summary.text}</p>
            {overview.insights.length > 0 ? (
              <p className="account-footnote">
                Сигналов: {overview.signals.length} · Рекомендаций:{" "}
                {overview.recommendations.length}
              </p>
            ) : null}
          </section>

          {overview.metrics.length > 0 ? (
            <section className="panel clients-summary" aria-label="Ключевые метрики">
              <h2 className="intelligence-section-title">Ключевые метрики</h2>
              <ul className="clients-summary__cards">
                {overview.metrics.map((m) => (
                  <li key={m.id}>
                    <span>{m.label}</span>
                    <strong>{m.display}</strong>
                    {m.hint ? (
                      <span className="account-footnote">{m.hint}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {overview.insights.length > 0 ? (
            <section aria-label="Требует внимания">
              <h2 className="intelligence-section-title">Требует внимания</h2>
              <div className="intelligence-grid">
                {overview.insights.map((insight) => (
                  <InsightCard
                    key={insight.id}
                    insight={insight}
                    onPreviewRec={setPreviewRec}
                  />
                ))}
              </div>
            </section>
          ) : null}

          {overview.recommendations.length > 0 ? (
            <section aria-label="Рекомендации">
              <h2 className="intelligence-section-title">Рекомендации</h2>
              <div className="intelligence-grid">
                {overview.recommendations.map((rec) => (
                  <RecommendationCard
                    key={rec.id}
                    rec={rec}
                    onPreview={setPreviewRec}
                  />
                ))}
              </div>
            </section>
          ) : null}

          <p className="account-footnote">
            Обновлено: {new Date(overview.lastUpdated).toLocaleString("ru-RU")}
          </p>
        </>
      ) : null}

      {previewRec ? (
        <dialog
          open
          className="client-detail--dialog intelligence-preview-dialog"
          aria-labelledby="intelligence-preview-title"
        >
          <h2 id="intelligence-preview-title">Предпросмотр действия</h2>
          <p>
            <strong>{previewRec.title}</strong>
          </p>
          <p>{previewRec.reason}</p>
          {previewRec.preview ? (
            <ul className="setup-progress__list">
              <li>{previewRec.preview.summary}</li>
              <li>Затронуто: {previewRec.preview.affectedCount}</li>
              <li>Основание: {previewRec.preview.basis}</li>
            </ul>
          ) : null}
          <p className="account-footnote">
            Статус: требуется подтверждение. Автоматическое выполнение отключено.
          </p>
          <div className="solution-setup-banner__actions">
            <button
              type="button"
              className="button button--primary"
              disabled
              title="День 1 — только предпросмотр"
            >
              Подтвердить действие
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => setPreviewRec(null)}
            >
              Закрыть
            </button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
