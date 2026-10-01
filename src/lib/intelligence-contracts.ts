/**
 * Контракты этапа 3 (Stage 3) — «evidence & intelligence».
 *
 * Это ТОЛЬКО контракты: типы и инварианты. Здесь нет рантайм-логики, нет
 * HTTP-ручек, нет миграций и нет новых таблиц — каждая сущность уже
 * проецируется на существующие таблицы Stage 1/2, и этот маппинг обязателен
 * для будущей реализации:
 *
 *   Evidence            → osint_observations + osint_sources
 *   Claim (state/metric)→ osint_facts
 *   Claim (relation)    → osint_entity_relations
 *   Corroboration       → агрегат Claims с одинаковым (subject, predicate, value)
 *   Contradiction       → агрегат Claims с одним (subject, predicate) и разным value
 *   Intelligence Profile→ osint_business_entities (мост) + osint_entities + osint_facts
 *   Report              → read-only проекция всех вышеперечисленных, без хранения
 *
 * Проекция без дублей: `Evidence.id` — это `osint_observations.id`;
 * `EvidenceSourceRef.observationId` указывает на `Evidence.id`, а
 * `osint_sources.id` всегда выводится из наблюдения (`source_id NOT NULL`),
 * поэтому в ссылке его сознательно нет — две взаимосогласованные копии
 * одного поля расходятся первыми.
 *
 * Запреты, которые должны оставаться истиной после подключения Stage 3:
 *  - не создавать дублирующие сущности (новые таблицы под Claim/Evidence);
 *  - не выдавать fuzzy-совпадению право auto-accept;
 *  - не опираться на глобальные таблицы как на тенантские (нет business_id);
 *  - не приписывать бизнесу утверждения без хотя бы одной Evidence ссылки;
 *  - не поднимать Stage 3 раньше, чем цепочка Observation→…→Report
 *    закрыта тестами.
 */

import type { IntelligenceDataMode } from "./intelligence-types";

/** Цитата наблюдения внутри Claim. */
export type EvidenceSourceRef = {
  /** osint_observations.id — наблюдение, в котором найден вывод. */
  observationId: string;
  /** Дословный фрагмент в наблюдении, из которого извлечён вывод. */
  textSpan: string | null;
  /** Способ извлечения: только явные маркеры дают право на OWNER/PUBLISHED_BY. */
  evidenceKind: EvidenceKind;
  /** Доля уверенности извлечения [0..1]; ниже порога — не используется как claim. */
  confidence: number;
};

export type EvidenceKind =
  | "sameAs"
  | "rel_author"
  | "explicit_claim"
  | "text_span";

/** Опорный вывод о мире. У Stage 3 никогда не бывает без Evidence. */
export type Evidence = {
  /** osint_observations.id */
  id: string;
  /** osint_sources.id — провенанс обязателен (NOT NULL в 069). */
  sourceId: string;
  /** Текст наблюдения, как он был получен (без интерпретации). */
  content: string;
  /** SHA/UUID дедупа наблюдения в рамках источника. */
  contentHash: string;
  observedAt: string;
  /** osint_entities.id, если наблюдение уже привязано к сущности. */
  entityId: string | null;
};

export type ClaimKind =
  | "state"
  | "metric"
  | "relation"
  | "identity"
  | "contact";

/**
 * Утверждение бизнеса. Проектируется на osint_facts (state/metric/contact/
 * identity) либо osint_entity_relations (relation).
 */
export type Claim = {
  id: string;
  businessId: string;
  kind: ClaimKind;
  /** Предмет утверждения: имя сущности либо её домен. */
  subject: string;
  /** Предикат из закрытого словаря Stage 1 (phone, address, category…). */
  predicate: string;
  /** Объект/значение; для relation — id целевой сущности. */
  value: string | null;
  valueKind: string | null;
  /** Обязательная доказательная база: ≥ 1 ссылки на Evidence. */
  evidence: EvidenceSourceRef[];
  confidence: number;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
};

/** Claim, который подтверждён независимыми источниками. */
export type Corroboration = {
  subject: string;
  predicate: string;
  value: string | null;
  claims: Claim[];
  /** Количество РАЗНЫХ источников (osint_sources.id), а не наблюдений. */
  distinctSourceCount: number;
  status: "corroborated";
  confidence: number;
};

/** Claim, который конфликтует с другим claim по одному (subject, predicate). */
export type Contradiction = {
  id: string;
  businessId: string;
  subject: string;
  predicate: string;
  /** Конфликтующие значения — каждое со своей evidence-базой. */
  sides: { value: string | null; claims: Claim[] }[];
  detectedAt: string;
  /** Разрешение противоречия — наследует rules Stage 1 (не fuzzy). */
  resolution: "unresolved" | "prefer_newest" | "prefer_official" | "manual";
  status: "unresolved" | "resolved";
};

/** Итоговая оценка присутствия бизнеса — сводка, а не новый источник данных. */
export type IntelligenceProfile = {
  businessId: string;
  /** Сущности, связанные через osint_business_entities. */
  entities: IntelligenceProfileEntity[];
  claims: Claim[];
  corroboration: Corroboration[];
  contradictions: Contradiction[];
  /** Доля claims, имеющих ≥ 2 независимых источника. */
  corroborationRatio: number;
  /** Доля claims, попавших в contradiction. */
  contradictionRatio: number;
  computedAt: string;
};

export type IntelligenceProfileEntity = {
  /** osint_entities.id */
  id: string;
  displayName: string;
  /** osint_business_entities.relationship — значение из CHECK 070
   *  (OWNER | PUBLISHED_BY | MENTIONS | ABOUT | PARTNER | CLIENT | COMPETITOR |
   *   LOCATION | EMPLOYER | SPONSOR | SUPPLIER | CUSTOMER | RELATED_TO). */
  relationship: string;
  /** osint_business_entities.status: candidate | linked | rejected */
  bridgeStatus: string;
  confidence: number;
  /** Ссылка на профиль/домен, если она известна. */
  url: string | null;
  city: string | null;
};

/**
 * Отчёт — read-only проекция. Не хранится отдельно и не создаёт копий данных;
 * собирается на чтение из Claim/Corroboration/Contradiction/IntelligenceProfile.
 */
export type Report = {
  businessId: string;
  generatedAt: string;
  /** Полный срез данных, из которого собран отчёт — наследует Day 1. */
  mode: IntelligenceDataMode;
  summary: {
    claimCount: number;
    corroboratedCount: number;
    contradictedCount: number;
    sourceCount: number;
    entityCount: number;
  };
  sections: ReportSection[];
};

export type ReportSection =
  | { kind: "evidence"; title: string; items: Evidence[] }
  | { kind: "claims"; title: string; items: Claim[] }
  | { kind: "corroboration"; title: string; items: Corroboration[] }
  | { kind: "contradictions"; title: string; items: Contradiction[] }
  | { kind: "profile"; title: string; profile: IntelligenceProfile };
