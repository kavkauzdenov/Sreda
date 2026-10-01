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
