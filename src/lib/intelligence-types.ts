import type {
  Claim,
  Contradiction,
  Corroboration,
  Evidence,
  EvidenceSourceRef,
} from "./intelligence-contracts";

export type SignalSeverity = "low" | "medium" | "high" | "critical";

export type SignalType =
  | "overdue_order"
  | "overdue_lead"
  | "sales_drop"
  | "inactive_customer"
  | "revenue_change";

export type BusinessHealthStatus =
  | "stable"
  | "attention_required"
  | "critical";

export type IntelligenceDataMode = "live" | "insufficient" | "demo";

export type MetricEvidence = {
  metric: string;
  current: number;
  previous?: number;
  unit?: string;
  sampleSize?: number;
  currency?: string;
};

export type BusinessSignal = {
  id: string;
  businessId: string;
  type: SignalType;
  source: string;
  title: string;
  description: string;
  severity: SignalSeverity;
  evidence: MetricEvidence[];
  occurredAt: string;
};

export type BusinessInsight = {
  id: string;
  type: string;
  severity: SignalSeverity;
  title: string;
  description: string;
  evidence: MetricEvidence[];
  impact: string;
  confidence: "low" | "medium" | "high";
};

export type RecommendationActionType =
  | "manual_required"
  | "available"
  | "preview";

export type BusinessRecommendation = {
  id: string;
  insightId: string;
  title: string;
  reason: string;
  expectedEffect: string;
  risk: string;
  actionType: RecommendationActionType;
  status: "open";
  preview?: {
    summary: string;
    affectedCount: number;
    basis: string;
  };
  href?: string;
};

export type IntelligenceMetric = {
  id: string;
  label: string;
  value: number | string;
  display: string;
  hint?: string;
};

export type IntelligenceOverview = {
  summary: {
    status: BusinessHealthStatus;
    text: string;
  };
  metrics: IntelligenceMetric[];
  signals: BusinessSignal[];
  insights: BusinessInsight[];
  recommendations: BusinessRecommendation[];
  lastUpdated: string;
  dataMode: IntelligenceDataMode;
};

/**
 * Wire-контракт OSINT-панели (`GET/POST .../intelligence/osint`).
 * Значения status/type/trust_level ограничены CHECK'ами миграций 069/070 —
 * здесь они остаются `string`, чтобы не плодить вторую копию словарей.
 */
export type OsintProviderInfo = {
  id: string;
  label: string;
  requiresNetwork: boolean;
  policy: string;
  enabledByDefault: boolean;
  /** false — провайдер исключён из run'ов (нет токена/конфига). */
  available: boolean;
  unavailableReason: string | null;
};

export type OsintRunInfo = {
  id: string;
  status: string;
  queriesCount: number;
  resultsCount: number;
  candidatesCount: number;
  acceptedCount: number;
  reviewCount: number;
  rejectedCount: number;
  duplicatesCount: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** Глубина/лимит обхода и crawl-статистика (§25). */
  depth: number;
  maxDepth: number;
  stats: Record<string, unknown>;
};

/** Ответ POST .../osint/discovery: run поставлен в очередь, сеть не тронута. */
export type OsintDiscoveryEnqueued = {
  runId: string;
  status: string;
  /** Сколько seed-строк реально записано в очередь. */
  seeds: number;
};

/** Ответ GET .../osint/discovery/[runId]: состояние run'а и его очереди. */
export type OsintRunStatusInfo = {
  runId: string;
  status: string;
  error: string | null;
  counts: {
    queries: number;
    results: number;
    candidates: number;
    accepted: number;
    review: number;
    rejected: number;
    duplicates: number;
  };
  queue: {
    queued: number;
    fetching: number;
    fetched: number;
    failed: number;
    skipped: number;
    total: number;
  };
  /** Последние неуспешные/пропущенные URL (≤10) — диагностика. */
  recentFailures: Array<{
    url: string;
    status: string;
    skipReason: string | null;
    error: string | null;
  }>;
  stats: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type OsintCandidateInfo = {
  id: string;
  url: string;
  title: string | null;
  type: string;
  status: string;
  confidence: string;
  matchReasons: string[];
  provider: string;
  hasSource: boolean;
  discoveredAt: string;
};

export type OsintEntityInfo = {
  id: string;
  kind: string;
  displayName: string;
  identityKey: string | null;
  category: string | null;
  city: string | null;
  website: string | null;
  relationship: string;
  bridgeStatus: string;
};

export type OsintSourceInfo = {
  id: string;
  name: string;
  url: string;
  type: string;
  trustLevel: string;
  status: string;
  provider: string;
  createdAt: string;
};

export type OsintSnapshot = {
  providers: OsintProviderInfo[];
  counts: {
    runs: number;
    candidates: number;
    pending: number;
    accepted: number;
    rejected: number;
    sources: number;
    entities: number;
  };
  runs: OsintRunInfo[];
  candidates: OsintCandidateInfo[];
  entities: OsintEntityInfo[];
  sources: OsintSourceInfo[];
};

export type OsintDiscoveryRunOutcome = {
  runId: string;
  status: string;
  queriesCount: number;
  resultsCount: number;
  candidatesCount: number;
  duplicatesCount: number;
  acceptedCount: number;
  reviewCount: number;
  rejectedCount: number;
  errors: string[];
};

/**
 * Wire-контракт Stage 3 runtime v1
 * (`GET .../intelligence/osint/observations/:observationId`).
 *
 * `Claim` / `Evidence` / `EvidenceSourceRef` берутся из контрактов
 * `intelligence-contracts.ts` без изменений — здесь только DTO ответа.
 */
export type Stage3SourceInfo = {
  id: string;
  name: string;
  url: string;
  type: string;
  trustLevel: string;
  provider: string;
};

export type Stage3EntityInfo = {
  id: string;
  displayName: string;
  identityKey: string | null;
};

/**
 * Указатели цепочки Claim → Evidence → Observation → Source. Это ссылки на
 * блоки того же ответа (`evidence`, `source`), а не вторая копия данных:
 * контракт запрещает держать `sourceId` внутри `EvidenceSourceRef`.
 */
export type Stage3Provenance = {
  claimId: string;
  evidenceRef: EvidenceSourceRef;
  observationId: string;
  sourceId: string;
};

export type Stage3Claim = Claim & { provenance: Stage3Provenance };

/**
 * Причина пустого результата. Пустой `claims` — это нормальный ответ
 * обработки, а не ошибка (§12).
 */
export type Stage3Reason =
  | "no_extractable_claims"
  | "missing_provenance"
  | "missing_entity";

export type Stage3ObservationSlice = {
  businessId: string;
  observationId: string;
  evidence: Evidence;
  source: Stage3SourceInfo | null;
  entity: Stage3EntityInfo | null;
  claims: Stage3Claim[];
  reason: Stage3Reason | null;
};

/**
 * Wire-контракт Stage 3 runtime v2
 * (`GET .../intelligence/osint/assessment`).
 *
 * Оценка — проекция уже построенных `Claim`, поэтому второго набора данных
 * нет: `Corroboration` и `Contradiction` берутся из
 * `intelligence-contracts.ts` без изменений, сам контракт НЕ меняется.
 * Пояснение к оценке (какое правило сработало, почему результат
 * неопределён, чего не хватает) живёт в группе-обёртке — ровно так, как v1
 * держит провенанс в `Stage3Provenance`, а не внутри `EvidenceSourceRef`.
 */
export type Stage3AssessmentRule =
  /** Ни один claim группы не имеет проверяемой цепочки Observation → Source. */
  | "missing_provenance"
  /** Predicate вне таблицы безопасного сравнения — сравнивать нельзя. */
  | "not_assessed"
  /** Меньше двух разных наблюдений: подтвердить и опровергнуть нечем. */
  | "single_observation"
  /** Два наблюдения отвечают на один вопрос по-разному. */
  | "value_mismatch"
  /** Значение едино, но все наблюдения из одного источника. */
  | "single_source"
  /** Значение едино, источников несколько — есть разнообразие источников. */
  | "distinct_sources";

/**
 * Независимость источников.
 *
 * v2 выдаёт только `"unknown"`: разные `osint_sources.id` доказывают
 * разнообразие, но не независимость — владельцы источников могут совпадать,
 * а данных об этом в Stage 1/2 нет (§4.5–4.7). `"established"` зарезервирован
 * под появление таких данных и сегодня намеренно не достигается.
 */
export type Stage3Independence = "unknown" | "established";

/**
 * Почему уверенному выводу не хватает данных (§1).
 * Список без дублей и отсортирован — детерминизм (§8).
 */
export type Stage3AssessmentGap =
  /** Ни одного claim с проверяемой цепочкой Observation → Source. */
  | "missing_provenance"
  /** Predicate не входит в таблицу безопасного сравнения. */
  | "predicate_not_comparable"
  /** Часть значений группы несравнима (не строка / нет значения). */
  | "value_not_comparable"
  /** Меньше двух разных наблюдений. */
  | "insufficient_observations"
  /** Разные source id ≠ доказанная независимость. */
  | "source_independence_unknown"
  /** Нет temporal semantics (`validTo = null`) — конфликт не разрешается. */
  | "no_temporal_semantics";

export type Stage3AssessmentGroup = {
  businessId: string;
  /** Предмет: имя сущности либо её домен (§5). */
  subject: string;
  predicate: string;
  /** Claims, прошедшие проверку провенанса и вошедшие в группу. */
  claimCount: number;
  distinctObservationCount: number;
  distinctSourceCount: number;
  /** osint_observations.id, участвующие в оценке. */
  observations: string[];
  /** osint_sources.id, участвующие в оценке. */
  sources: string[];
  /** Трассировка каждого claim'а до Observation и Source (§6). */
  provenance: Stage3Provenance[];
  rule: Stage3AssessmentRule;
  independence: Stage3Independence;
  /** `null`, если разнообразия источников нет. */
  corroboration: Corroboration | null;
  contradictions: Contradiction[];
  gaps: Stage3AssessmentGap[];
};

export type Stage3Assessment = {
  businessId: string;
  /** Сколько тенантских наблюдений просмотрено (диагностика, не оценка). */
  observationCount: number;
  /** Сколько наблюдений не дало пригодной цепочки (субъект/вид/контент). */
  skippedObservations: number;
  /** Сколько claims передано в оценку. */
  claimCount: number;
  groups: Stage3AssessmentGroup[];
  /** Пустая проекция — нормальный ответ обработки, а не ошибка (§12). */
  reason: "insufficient_evidence" | null;
};

/* ==========================================================================
 * Stage 4 intelligence layer (§26): wire-контракты четырёх GET-эндпоинтов
 * `GET .../intelligence/osint/{profile,facts,changes,contradictions}`.
 *
 * Детерминированный read model: никаких оценок «качества бизнеса» — только
 * извлечённые факты, их provenance, история изменений и противоречия.
 * Даты — ISO-строки (JSON-сериализация), значения — канонические.
 * ======================================================================== */

export type OsintIntelFactType =
  | "business_name" | "brand_name" | "legal_name"
  | "phone" | "email"
  | "address" | "city" | "region" | "country" | "postal_code"
  | "website" | "domain"
  | "telegram" | "vk" | "instagram" | "facebook" | "youtube" | "tiktok"
  | "other_social"
  | "category" | "service" | "product" | "opening_hours"
  | "registration_identifier" | "tax_identifier" | "license_identifier";

export type OsintIntelFactStatus = "ACTIVE" | "STALE" | "RETIRED";

export type OsintIntelChangeKind =
  | "FIRST_SEEN"
  | "VALUE_CHANGED"
  | "VALUE_REAPPEARED"
  | "VALUE_DISAPPEARED"
  | "SOURCE_CHANGED";

export type OsintIntelEnrichmentStatus =
  | "queued" | "running" | "completed" | "failed";

/** Источник факта — drill-down идёт в существующий Stage 3 observation slice. */
export type OsintIntelSourceRef = {
  id: string;
  name: string;
  url: string;
};

export type OsintIntelFact = {
  id: string;
  factType: OsintIntelFactType;
  factKey: string;
  value: string;
  rawValue: string;
  status: OsintIntelFactStatus;
  source: OsintIntelSourceRef;
  observationId: string;
  /** Происхождение кандидата: source_context | source_url | observation_text. */
  origin: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  observedAt: string;
};

export type OsintIntelPage<T> = {
  businessId: string;
  total: number;
  limit: number;
  offset: number;
  items: T[];
};

export type OsintIntelChange = {
  id: string;
  factType: OsintIntelFactType;
  factKey: string;
  changeKind: OsintIntelChangeKind;
  oldValue: string | null;
  newValue: string | null;
  source: OsintIntelSourceRef | null;
  observationId: string | null;
  detectedAt: string;
};

/** Сторона противоречия: одно активное значение и его источники (§26.10). */
export type OsintIntelContradictionSide = {
  value: string;
  sources: OsintIntelSourceRef[];
  observations: string[];
  firstSeen: string;
  lastSeen: string;
};

export type OsintIntelContradiction = {
  id: string;
  factType: OsintIntelFactType;
  status: "unresolved" | "resolved";
  valueCount: number;
  sourceCount: number;
  sides: OsintIntelContradictionSide[];
  detectedAt: string;
  updatedAt: string;
};

/** Класс сопоставления — классификация процесса, не оценка бизнеса (§26.6). */
export type OsintIntelResolution = {
  status: "EXACT" | "STRONG" | "CANDIDATE" | "AMBIGUOUS" | "NO_MATCH";
  entityId: string | null;
  entityName: string | null;
  explanation: string;
  signals: { signal: string; matched: boolean; detail: string }[];
};

export type OsintIntelLastRun = {
  id: string;
  status: OsintIntelEnrichmentStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  stats: Record<string, unknown> | null;
};

/** `GET .../osint/profile` — «кто это и что о нём известно». */
export type OsintIntelProfile = {
  businessId: string;
  resolution: OsintIntelResolution | null;
  names: string[];
  phones: string[];
  emails: string[];
  websites: string[];
  domains: string[];
  socials: { factType: OsintIntelFactType; value: string }[];
  categories: string[];
  address: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  counts: {
    active: number;
    stale: number;
    retired: number;
    changes: number;
    contradictions: number;
  };
  byType: { factType: OsintIntelFactType; count: number }[];
  lastRun: OsintIntelLastRun | null;
};
