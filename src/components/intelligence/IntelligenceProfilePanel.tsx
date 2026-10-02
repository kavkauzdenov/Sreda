"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getOsintIntelChanges,
  getOsintIntelContradictions,
  getOsintIntelFacts,
  getOsintIntelProfile,
} from "@/services/intelligence.service";
import type {
  OsintIntelChange,
  OsintIntelContradiction,
  OsintIntelFact,
  OsintIntelProfile,
} from "@/lib/intelligence-types";

/**
 * Stage 4 (§26.13): четыре вопроса к intelligence-слою —
 * «кто это», «что известно», «что изменилось», «есть ли противоречия».
 *
 * Только чтение четырёх GET; факты грузятся лениво (progressive
 * disclosure), провенанс каждой fact раскрывается через <details>.
 * Никаких оценок «качества» — класс сопоставления объясняет процесс.
 */

const FACT_PAGE = 20;

const FACT_TYPE_LABELS: Record<string, string> = {
  business_name: "Название",
  brand_name: "Бренд",
  legal_name: "Юр. название",
  phone: "Телефон",
  email: "E-mail",
  address: "Адрес",
  city: "Город",
  region: "Регион",
  country: "Страна",
  postal_code: "Индекс",
  website: "Сайт",
  domain: "Домен",
  telegram: "Telegram",
  vk: "VK",
  instagram: "Instagram",
  facebook: "Facebook",
  youtube: "YouTube",
  tiktok: "TikTok",
  other_social: "Соцсеть",
  category: "Категория",
  service: "Услуга",
  product: "Продукт",
  opening_hours: "Часы работы",
  registration_identifier: "Рег. номер",
  tax_identifier: "ИНН",
  license_identifier: "Лицензия",
};

const CHANGE_KIND_LABELS: Record<string, string> = {
  FIRST_SEEN: "Новое значение",
  VALUE_CHANGED: "Значение заменено",
  VALUE_REAPPEARED: "Значение вернулось",
  VALUE_DISAPPEARED: "Значение исчезло",
  SOURCE_CHANGED: "Новый источник подтвердил",
};

const FACT_STATUS_LABELS: Record<string, string> = {
  ACTIVE: "подтверждён",
  STALE: "устарел",
  RETIRED: "заменён",
};

const RESOLUTION_LABELS: Record<string, string> = {
  EXACT: "точное совпадение",
  STRONG: "сильное совпадение",
  CANDIDATE: "кандидат",
  AMBIGUOUS: "неоднозначно",
  NO_MATCH: "без совпадения",
};

function typeLabel(factType: string): string {
  return FACT_TYPE_LABELS[factType] ?? factType;
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString("ru-RU");
  } catch {
    return value;
  }
}

function observationUrl(businessId: string, observationId: string): string {
  return `/api/v1/businesses/${encodeURIComponent(businessId)}/intelligence/osint/observations/${encodeURIComponent(observationId)}`;
}

function FactProvenance({
  fact,
  businessId,
}: {
  fact: OsintIntelFact;
  businessId: string;
}) {
  return (
    <details className="intelligence-evidence">
      <summary>Откуда известно</summary>
      <ul>
        <li>
          Источник:{" "}
          {fact.source.url ? (
            <a href={fact.source.url} target="_blank" rel="noreferrer noopener">
              {fact.source.name || fact.source.url}
            </a>
          ) : (
            fact.source.name
          )}
        </li>
        <li>
          Наблюдение:{" "}
          <a
            href={observationUrl(businessId, fact.observationId)}
            rel="noreferrer"
          >
            <code>{fact.observationId.slice(0, 8)}</code>
          </a>
        </li>
        <li>Как извлечено: {fact.origin ?? "неизвестно"}</li>
        {fact.rawValue !== fact.value ? <li>Исходно: «{fact.rawValue}»</li> : null}
        <li>
          Впервые увидено: {formatDate(fact.firstSeenAt)} · последний раз:{" "}
          {formatDate(fact.lastSeenAt)}
        </li>
      </ul>
    </details>
  );
}

export function IntelligenceProfilePanel({
  businessId,
}: {
  businessId: string;
}) {
  const [profile, setProfile] = useState<OsintIntelProfile | null>(null);
  const [changes, setChanges] = useState<OsintIntelChange[]>([]);
  const [contradictions, setContradictions] = useState<
    OsintIntelContradiction[]
  >([]);
  const [facts, setFacts] = useState<OsintIntelFact[]>([]);
  const [factsTotal, setFactsTotal] = useState(0);
  const [factsOpen, setFactsOpen] = useState(false);
  const [factsLoading, setFactsLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const factsLoadedFor = useRef<string | null>(null);

  const load = useCallback(() => {
    if (!businessId) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) setLoading(true);
    });
    Promise.all([
      getOsintIntelProfile(businessId),
      getOsintIntelChanges(businessId, { limit: 15 }),
      getOsintIntelContradictions(businessId),
    ])
      .then(([profileData, changesData, contradictionsData]) => {
        if (!alive) return;
        setProfile(profileData);
        setChanges(changesData.items);
        setContradictions(contradictionsData.contradictions);
        setError("");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setError(
          e instanceof Error
            ? e.message
            : "Не удалось загрузить intelligence-данные.",
        );
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [businessId]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  const openFacts = async () => {
    if (factsOpen) {
      setFactsOpen(false);
      return;
    }
    setFactsOpen(true);
    if (factsLoadedFor.current === businessId) return;
    setFactsLoading(true);
    try {
      const page = await getOsintIntelFacts(businessId, { limit: FACT_PAGE });
      setFacts(page.items);
      setFactsTotal(page.total);
      factsLoadedFor.current = businessId;
      setError("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить факты.");
    } finally {
      setFactsLoading(false);
    }
  };

  const moreFacts = async () => {
    setFactsLoading(true);
    try {
      const page = await getOsintIntelFacts(businessId, {
        limit: FACT_PAGE,
        offset: facts.length,
      });
      setFacts((current) => [...current, ...page.items]);
      setFactsTotal(page.total);
      setError("");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить факты.");
    } finally {
      setFactsLoading(false);
    }
  };

  const counts = profile?.counts;

  return (
    <section
      className="panel"
      aria-label="Интеллект бизнеса"
      data-testid="intel-profile-panel"
    >
      <div>
        <h2 className="intelligence-section-title">Что мы знаем о бизнесе</h2>
        <p className="account-footnote">
          {profile?.lastRun
            ? `Последнее обогащение: ${profile.lastRun.status === "completed" ? "готово" : profile.lastRun.status} · ${formatDate(profile.lastRun.createdAt)}`
            : loading
              ? "Загрузка…"
              : "Обогащение ещё не запускалось — запустите OSINT-сбор выше, факты появятся после фонового прохода."}
        </p>
      </div>

      {error ? (
        <p role="alert" className="account-error">
          {error}
        </p>
      ) : null}

      {profile ? (
        <>
          {/* 1. Кто это */}
          <div data-testid="intel-profile">
            <h3 className="intelligence-section-title">Кто это</h3>
            <ul className="setup-progress__list">
              {profile.names.length > 0 ? (
                <li>Названия: {profile.names.join(" · ")}</li>
              ) : null}
              {profile.categories.length > 0 ? (
                <li>Категории: {profile.categories.join(" · ")}</li>
              ) : null}
              {profile.city || profile.address ? (
                <li>
                  Место: {[profile.city, profile.address].filter(Boolean).join(", ")}
                </li>
              ) : null}
              <li>
                Сопоставление:{" "}
                {profile.resolution
                  ? `${RESOLUTION_LABELS[profile.resolution.status] ?? profile.resolution.status}${profile.resolution.entityName ? ` → «${profile.resolution.entityName}»` : ""}`
                  : "нет данных — обогащение ещё не выполнялось"}
              </li>
            </ul>
            {profile.resolution ? (
              <details className="intelligence-evidence">
                <summary>Как принято решение о сопоставлении</summary>
                <p>{profile.resolution.explanation}</p>
                <ul>
                  {profile.resolution.signals.map((signal) => (
                    <li key={signal.signal}>
                      {signal.matched ? "✓" : "·"} {signal.detail}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {counts ? (
              <ul className="clients-summary__cards">
                <li>
                  <span>Фактов подтверждено</span>
                  <strong data-testid="intel-count-active">{counts.active}</strong>
                </li>
                <li>
                  <span>Устарело</span>
                  <strong>{counts.stale}</strong>
                </li>
                <li>
                  <span>Изменений</span>
                  <strong data-testid="intel-count-changes">{counts.changes}</strong>
                </li>
                <li>
                  <span>Противоречий</span>
                  <strong data-testid="intel-count-contradictions">
                    {counts.contradictions}
                  </strong>
                </li>
              </ul>
            ) : null}
            {profile.byType.length > 0 ? (
              <p className="account-footnote">
                Типы фактов:{" "}
                {profile.byType
                  .map((entry) => `${typeLabel(entry.factType)} (${entry.count})`)
                  .join(", ")}
              </p>
            ) : null}
          </div>

          {/* 2. Что известно */}
          <div data-testid="intel-facts">
            <h3 className="intelligence-section-title">Что известно</h3>
            <button
              type="button"
              className="button button--outline"
              onClick={() => void openFacts()}
              data-testid="intel-facts-toggle"
            >
              {factsOpen
                ? "Скрыть факты"
                : `Показать факты (${counts?.active ?? 0})`}
            </button>
            {factsOpen ? (
              factsLoading && facts.length === 0 ? (
                <p className="account-footnote">Читаем факты…</p>
              ) : facts.length === 0 ? (
                <p className="account-footnote">
                  Фактов пока нет — запустите OSINT-сбор и дождитесь фонового
                  обогащения.
                </p>
              ) : (
                <>
                  <ul className="setup-progress__list">
                    {facts.map((fact) => (
                      <li key={fact.id} data-testid="intel-fact">
                        <strong>{fact.value}</strong> · {typeLabel(fact.factType)}{" "}
                        · {FACT_STATUS_LABELS[fact.status] ?? fact.status}
                        <FactProvenance fact={fact} businessId={businessId} />
                      </li>
                    ))}
                  </ul>
                  {facts.length < factsTotal ? (
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => void moreFacts()}
                      disabled={factsLoading}
                      data-testid="intel-facts-more"
                    >
                      {factsLoading ? "Загружаем…" : "Показать ещё"}
                    </button>
                  ) : null}
                </>
              )
            ) : null}
          </div>

          {/* 3. Что изменилось */}
          <div data-testid="intel-changes">
            <h3 className="intelligence-section-title">Что изменилось</h3>
            {changes.length === 0 ? (
              <p className="account-footnote">
                Изменений пока нет: ни одно значение не появилось и не исчезло.
              </p>
            ) : (
              <ul className="setup-progress__list">
                {changes.map((change) => (
                  <li key={change.id} data-testid={`intel-change-${change.changeKind}`}>
                    {CHANGE_KIND_LABELS[change.changeKind] ?? change.changeKind} ·{" "}
                    {typeLabel(change.factType)}:{" "}
                    {change.oldValue ? `«${change.oldValue}»` : null}
                    {change.oldValue && change.newValue ? " → " : null}
                    {change.newValue ? `«${change.newValue}»` : null}
                    {!change.oldValue && !change.newValue ? change.factKey : null}
                    {change.source?.name ? ` · ${change.source.name}` : ""} ·{" "}
                    {formatDate(change.detectedAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* 4. Есть ли противоречия */}
          <div data-testid="intel-contradictions">
            <h3 className="intelligence-section-title">
              Есть ли противоречия
            </h3>
            {contradictions.length === 0 ? (
              <p className="account-footnote">
                Расхождений между источниками не найдено.
              </p>
            ) : (
              contradictions.map((contradiction) => (
                <article
                  key={contradiction.id}
                  data-testid={`intel-contradiction-${contradiction.factType}`}
                >
                  <h4>
                    {typeLabel(contradiction.factType)}: {contradiction.valueCount}{" "}
                    значения, {contradiction.sourceCount} источников
                    {contradiction.status === "resolved"
                      ? " · разрешено"
                      : ""}
                  </h4>
                  <ul className="setup-progress__list">
                    {contradiction.sides.map((side) => (
                      <li key={`${contradiction.id}-${side.value}`}>
                        «{side.value}» — {side.sources.map((source) => source.name || source.url).join(", ")}
                      </li>
                    ))}
                  </ul>
                  <p className="account-footnote">
                    Мы не выбираем победителя: обе стороны трассируются до
                    источников и наблюдений.
                  </p>
                </article>
              ))
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
