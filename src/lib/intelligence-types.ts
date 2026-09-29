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
