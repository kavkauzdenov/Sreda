import type { Generated } from "kysely";

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
    confidence: string;
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
    value: unknown;
    confidence: Generated<string>;
    source_observation_id: string | null;
    valid_from: Generated<Date>;
    valid_to: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
}
