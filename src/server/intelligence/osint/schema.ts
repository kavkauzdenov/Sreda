import type { Generated } from "kysely";

/**
 * Запись JSON-массива в jsonb-колонку через драйвер pg.
 *
 * Драйвер сериализует топовый JS-массив как литерал массива PostgreSQL
 * (`{a,b}`), а не как JSON — колонка jsonb отвечает `22P02 invalid input
 * syntax for type json`. Объекты драйвер сериализует сам (prepareObject →
 * JSON.stringify), массивы — нет. Кодируем явно; на чтение это не влияет:
 * pg разбирает jsonb обратно в JS-массив.
 */
export function jsonbArray<T>(value: readonly T[] | null | undefined): string[] {
  return JSON.stringify(value ?? []) as unknown as string[];
}

/** Один источник-тип наружу; расширяемый текстовый provider в отдельной колонке. */
export type OsintSourceType =
  | "website"
  | "search"
  | "maps"
  | "review_platform"
  | "social_network"
  | "directory"
  | "news"
  | "public_registry"
  | "other";

export type OsintSourceStatus = "active" | "paused" | "error" | "disabled";

/** Техническое происхождение данных, не рейтинг и не «качество мнения». */
export type OsintTrustLevel =
  | "official"
  | "public_directory"
  | "review_platform"
  | "search_result"
  | "third_party";

export type OsintCandidateStatus = "candidate" | "accepted" | "rejected";

export type OsintDiscoveryMethod =
  | "search"
  | "website_link"
  | "structured_data"
  | "social"
  | "map"
  | "manual";

export type OsintDiscoveryRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
  | "failed";

export type OsintEntityKind = "business" | "location" | "organization";

export type OsintObservationKind =
  | "page"
  | "review"
  | "search_result"
  | "post"
  | "listing";

export type OsintCrawlQueueStatus =
  | "queued"
  | "fetching"
  | "fetched"
  | "failed"
  | "skipped";

export type OsintFindingType =
  | "REPUTATION"
  | "COMPETITOR"
  | "PRICING"
  | "SERVICE"
  | "ACTIVITY"
  | "CUSTOMER_COMPLAINT"
  | "CUSTOMER_PRAISE"
  | "MARKET"
  | "CONTENT"
  | "WEBSITE"
  | "CONTACT"
  | "LOCATION"
  | "OPERATIONAL";

export type OsintFindingSeverity = "critical" | "high" | "medium" | "low";

export type OsintFindingStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "dismissed";

export type OsintCompetitorStatus =
  | "proposed"
  | "confirmed"
  | "rejected"
  | "watching";

/**
 * Единый словарь семантических связей (§6 source→entity, §8 mention,
 * §15 relation, §4 business→entity bridge).
 *
 * Правило OWNERSHIP VS MENTION: MENTIONS никогда не интерпретируется как
 * OWNER или PUBLISHED_BY — эти две выставляются только по явному evidence
 * (sameAs, rel=author, прямое заявление).
 */
export type OsintRelationType =
  | "OWNER"
  | "PUBLISHED_BY"
  | "MENTIONS"
  | "ABOUT"
  | "PARTNER"
  | "CLIENT"
  | "COMPETITOR"
  | "LOCATION"
  | "EMPLOYER"
  | "SPONSOR"
  | "SUPPLIER"
  | "CUSTOMER"
  | "RELATED_TO";

export type OsintBusinessEntityStatus = "candidate" | "linked" | "rejected";

export type OsintSourceHistoryKind =
  | "create"
  | "update"
  | "auto_collect"
  | "manual_edit"
  | "merge";

/** Temporal-атрибуты сущности (§18) — ровно одно открытое значение на атрибут. */
export type OsintAttributeKind =
  | "name"
  | "phone"
  | "website"
  | "address"
  | "email"
  | "city"
  | "region"
  | "country"
  | "category"
  | "description"
  | "social_links"
  | "coordinates"
  | "working_hours";

/**
 * Закрытый словарь типов Fact Stage 4 (§26.2). Public identifiers (tax/registration/
 * license) присутствуют только как типы — детерминированная экстракция их не
 * добывает из произвольного текста (§26.2): строка создаётся только если
 * структурированный источник уже несёт значение.
 */
export type OsintFactType =
  | "business_name"
  | "brand_name"
  | "legal_name"
  | "phone"
  | "email"
  | "address"
  | "city"
  | "region"
  | "country"
  | "postal_code"
  | "website"
  | "domain"
  | "telegram"
  | "vk"
  | "instagram"
  | "facebook"
  | "youtube"
  | "tiktok"
  | "other_social"
  | "category"
  | "service"
  | "product"
  | "opening_hours"
  | "registration_identifier"
  | "tax_identifier"
  | "license_identifier";

export const OSINT_FACT_TYPES: readonly OsintFactType[] = [
  "business_name",
  "brand_name",
  "legal_name",
  "phone",
  "email",
  "address",
  "city",
  "region",
  "country",
  "postal_code",
  "website",
  "domain",
  "telegram",
  "vk",
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "other_social",
  "category",
  "service",
  "product",
  "opening_hours",
  "registration_identifier",
  "tax_identifier",
  "license_identifier",
];

/**
 * Жизненный цикл Fact (§26.8):
 *  - ACTIVE    — подтверждён последним enrichment;
 *  - STALE     — исчез из источника без замены (может вернуться);
 *  - RETIRED   — вытеснен новым значением того же источника (есть change event).
 */
export type OsintFactStatus = "ACTIVE" | "STALE" | "RETIRED";

/** Переходы stored-состояния → состояние после enrichment (§26.9). */
export type OsintChangeKind =
  | "FIRST_SEEN"
  | "VALUE_CHANGED"
  | "VALUE_REAPPEARED"
  | "VALUE_DISAPPEARED"
  | "SOURCE_CHANGED";

export const OSINT_CHANGE_KINDS: readonly OsintChangeKind[] = [
  "FIRST_SEEN",
  "VALUE_CHANGED",
  "VALUE_REAPPEARED",
  "VALUE_DISAPPEARED",
  "SOURCE_CHANGED",
];

/** Очередь enrichment Stage 4 (§26.11): ограниченный retry, без бесконечных. */
export type OsintEnrichmentStatus = "queued" | "running" | "completed" | "failed";

/** Запуск паспорта исследования (§26): статус синхронизируется с run'ом. */
export type OsintResearchLaunchStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

/** numeric(4,3) читается из PostgreSQL как строка — как и money-поля проекта. */
export interface OsintTables {
  osint_discovery_runs: {
    id: string;
    business_id: string;
    status: Generated<OsintDiscoveryRunStatus>;
    profile: Generated<Record<string, unknown>>;
    budget: Generated<Record<string, unknown>>;
    providers: Generated<unknown[]>;
    queries_count: Generated<number>;
    results_count: Generated<number>;
    candidates_count: Generated<number>;
    accepted_count: Generated<number>;
    review_count: Generated<number>;
    rejected_count: Generated<number>;
    duplicates_count: Generated<number>;
    error: string | null;
    started_at: Date | null;
    finished_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    /** Текущая глубина traversal (0 = корень discovery). */
    depth: Generated<number>;
    /** Разрешённая глубина обхода графа. */
    max_depth: Generated<number>;
    /** Счётчики traversal (§25): entities, sources, mentions, budget hits. */
    stats: Generated<Record<string, unknown>>;
    /** Сущность, с которой стартовал обход. */
    root_entity_id: string | null;
    /** Детерминированные extra-запросы (фразы паспорта) — в начале списка. */
    extra_queries: Generated<unknown[]>;
  };
  osint_entities: {
    id: string;
    kind: Generated<OsintEntityKind>;
    display_name: string;
    normalized_name: string;
    identity_key: string | null;
    aliases: Generated<string[]>;
    category: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    website: string | null;
    social_links: Generated<Record<string, unknown>>;
    fingerprint: Generated<Record<string, unknown>>;
    latitude: number | null;
    longitude: number | null;
    source_kind: Generated<"discovery" | "manual">;
    merged_into_id: string | null;
    first_seen_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  osint_sources: {
    id: string;
    type: Generated<OsintSourceType>;
    provider: Generated<string>;
    url: string;
    normalized_url: string;
    name: Generated<string>;
    status: Generated<OsintSourceStatus>;
    trust_level: Generated<OsintTrustLevel>;
    origin: Generated<"discovery" | "manual">;
    auto_accepted: Generated<boolean>;
    last_collected_at: Date | null;
    last_success_at: Date | null;
    last_error_at: Date | null;
    last_error: string | null;
    next_collection_at: Date | null;
    collection_count: Generated<number>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  osint_source_candidates: {
    id: string;
    business_id: string;
    discovery_run_id: string | null;
    entity_id: string | null;
    source_id: string | null;
    url: string;
    normalized_url: string;
    type: Generated<OsintSourceType>;
    provider: Generated<string>;
    title: string | null;
    snippet: string | null;
    discovery_method: Generated<OsintDiscoveryMethod>;
    query: string | null;
    search_position: number | null;
    confidence: Generated<string>;
    match_reasons: Generated<string[]>;
    evidence: Generated<unknown[]>;
    status: Generated<OsintCandidateStatus>;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    discovered_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  osint_entity_sources: {
    entity_id: string;
    source_id: string;
    confidence: Generated<string>;
    created_at: Generated<Date>;
  };
  osint_observations: {
    id: string;
    source_id: string;
    entity_id: string | null;
    external_id: string | null;
    url: string | null;
    title: string | null;
    content: Generated<string>;
    author_name: string | null;
    published_at: Date | null;
    observed_at: Generated<Date>;
    content_hash: string;
    language: string | null;
    kind: Generated<OsintObservationKind>;
    rating: string | null;
    rating_max: string | null;
    latitude: number | null;
    longitude: number | null;
    metadata: Generated<Record<string, unknown>>;
    created_at: Generated<Date>;
  };
  osint_facts: {
    id: string;
    business_id: string;
    subject: string;
    predicate: string;
    object: string | null;
    value: unknown | null;
    value_kind: string | null;
    source_observation_id: string;
    confidence: Generated<string>;
    valid_from: Date | null;
    valid_to: Date | null;
    created_at: Generated<Date>;
  };
  osint_competitor_candidates: {
    id: string;
    business_id: string;
    entity_id: string | null;
    candidate_business_id: string | null;
    name: string;
    category: string | null;
    city: string | null;
    address: string | null;
    website: string | null;
    latitude: number | null;
    longitude: number | null;
    match_score: Generated<string>;
    match_reasons: Generated<string[]>;
    evidence: Generated<unknown[]>;
    sources: Generated<unknown[]>;
    status: Generated<OsintCompetitorStatus>;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    observed_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  osint_findings: {
    id: string;
    business_id: string;
    type: OsintFindingType;
    severity: Generated<OsintFindingSeverity>;
    title: string;
    description: Generated<string>;
    confidence: Generated<string>;
    period_from: Date | null;
    period_to: Date | null;
    computed: Generated<Record<string, unknown>>;
    explanation: Generated<string>;
    dedupe_key: string;
    status: Generated<OsintFindingStatus>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    last_seen_at: Generated<Date>;
  };
  osint_finding_evidence: {
    business_id: string;
    finding_id: string;
    evidence_kind: "observation" | "fact" | "review_cluster" | "competitor";
    target_id: string;
    created_at: Generated<Date>;
  };
  /**
   * Мост тенант → глобальная сущность (§4). Единственная таблица,
   * где tenant указывает, какая public entity относится именно к нему.
   */
  osint_business_entities: {
    business_id: string;
    entity_id: string;
    relationship: Generated<OsintRelationType>;
    confidence: Generated<string>;
    status: Generated<OsintBusinessEntityStatus>;
    evidence: Generated<unknown[]>;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Structured source memory (§1), глобально. Плоские колонки, не JSON-модель. */
  osint_source_context: {
    source_id: string;
    canonical_name: Generated<string>;
    description: Generated<string>;
    category: string | null;
    language: string | null;
    city: string | null;
    region: string | null;
    country: string | null;
    address: string | null;
    contacts: Generated<unknown[]>;
    domains: Generated<unknown[]>;
    social_links: Generated<Record<string, unknown>>;
    known_owner_entity_id: string | null;
    metadata: Generated<Record<string, unknown>>;
    first_observed_at: Generated<Date>;
    last_observed_at: Generated<Date>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** История перезаписей контекста (§19) — новый сбор никогда не затирает старый. */
  osint_source_history: {
    id: string;
    source_id: string;
    change_kind: Generated<OsintSourceHistoryKind>;
    changed_fields: Generated<unknown[]>;
    snapshot: Generated<Record<string, unknown>>;
    valid_from: Generated<Date>;
    valid_to: Date | null;
    observed_at: Generated<Date>;
    created_at: Generated<Date>;
  };
  /** Mention из наблюдения (§9) — обязан нести text_span (evidence). */
  osint_entity_mentions: {
    id: string;
    observation_id: string;
    entity_id: string;
    mention_type: Generated<OsintRelationType>;
    text_span: Generated<string>;
    context: Generated<string>;
    confidence: Generated<string>;
    created_at: Generated<Date>;
  };
  /** Связь двух сущностей (§15) — обязана иметь source_observation_id. */
  osint_entity_relations: {
    id: string;
    from_entity_id: string;
    to_entity_id: string;
    relation_type: OsintRelationType;
    confidence: Generated<string>;
    source_observation_id: string;
    evidence: Generated<Record<string, unknown>>;
    valid_from: Generated<Date>;
    valid_to: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Temporal-атрибуты (§18): одно открытое значение на атрибут. */
  osint_entity_attributes: {
    id: string;
    entity_id: string;
    attribute: OsintAttributeKind;
    value: Generated<unknown>;
    confidence: Generated<string>;
    source_observation_id: string | null;
    valid_from: Date | null;
    valid_to: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Очередь URL discovery run (§25): состояния, приоритет, дедуп. */
  osint_crawl_queue: {
    id: string;
    run_id: string;
    business_id: string;
    url: string;
    normalized_url: string;
    depth: Generated<number>;
    priority: Generated<number>;
    status: Generated<OsintCrawlQueueStatus>;
    skip_reason: string | null;
    error: string | null;
    attempts: Generated<number>;
    http_status: number | null;
    from_url: string | null;
    fetched_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Fact layer Stage 4 (§26.1): каноническое значение + raw + provenance. */
  osint_intelligence_facts: {
    id: string;
    business_id: string;
    entity_id: string | null;
    fact_type: OsintFactType;
    fact_key: string;
    value: string;
    raw_value: string;
    source_id: string;
    observation_id: string;
    status: Generated<OsintFactStatus>;
    fingerprint: string;
    first_seen_at: Generated<Date>;
    last_seen_at: Generated<Date>;
    observed_at: Generated<Date>;
    extracted_at: Generated<Date>;
    metadata: Generated<unknown>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Change events (§26.9): переходы детерминированы, дедуп по fingerprint. */
  osint_fact_changes: {
    id: string;
    business_id: string;
    entity_id: string | null;
    fact_type: OsintFactType;
    fact_key: string;
    change_kind: OsintChangeKind;
    old_value: string | null;
    new_value: string | null;
    source_id: string | null;
    observation_id: string | null;
    detected_at: Generated<Date>;
    fingerprint: string;
    metadata: Generated<unknown>;
    created_at: Generated<Date>;
  };
  /** Пересчитываемые contradictions (§26.10): стороны в jsonb, без победителя. */
  osint_intelligence_contradictions: {
    id: string;
    business_id: string;
    fact_type: OsintFactType;
    sides: unknown;
    value_count: Generated<number>;
    source_count: Generated<number>;
    status: Generated<"unresolved" | "resolved">;
    detected_at: Generated<Date>;
    updated_at: Generated<Date>;
    created_at: Generated<Date>;
  };
  /** Очередь enrichment (§26.11): один активный run на бизнес (partial UNIQUE). */
  osint_enrichment_runs: {
    id: string;
    business_id: string;
    discovery_run_id: string | null;
    status: Generated<OsintEnrichmentStatus>;
    attempts: Generated<number>;
    error: string | null;
    stats: Generated<unknown>;
    available_at: Generated<Date>;
    created_at: Generated<Date>;
    started_at: Date | null;
    finished_at: Date | null;
    updated_at: Generated<Date>;
  };
  /** Паспорт исследования: одна конфигурация на бизнес + revision. */
  osint_research_passports: {
    id: string;
    business_id: string;
    revision: Generated<number>;
    format_version: Generated<number>;
    content: Generated<unknown>;
    created_by: string | null;
    updated_by: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  /** Append-only история ревизий паспорта (UNIQUE passport_id+revision). */
  osint_research_passport_revisions: {
    id: string;
    business_id: string;
    passport_id: string;
    revision: number;
    format_version: number;
    content: unknown;
    created_by: string | null;
    created_at: Generated<Date>;
  };
  /** Запуск исследования: снимок паспорта и плана на момент запуска. */
  osint_research_launches: {
    id: string;
    business_id: string;
    passport_id: string | null;
    passport_revision: number | null;
    passport_snapshot: unknown;
    plan: unknown;
    run_id: string | null;
    status: Generated<OsintResearchLaunchStatus>;
    error: string | null;
    created_by: string | null;
    created_at: Generated<Date>;
    started_at: Date | null;
    finished_at: Date | null;
    updated_at: Generated<Date>;
  };
}
