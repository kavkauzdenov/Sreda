import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { requireBusiness } from "../access/permissions.ts";
import { loadInternalSnapshot } from "./internal-data.ts";
import { buildSignals } from "./signals.ts";
import { buildInsights } from "./insights.ts";
import { buildRecommendations } from "./recommendations.ts";
import { buildMetrics } from "./metrics.ts";
import { aggregateBusinessStatus, summaryText } from "./status.ts";
import { logIntelligenceEvent } from "./audit.ts";
import { buildDemoOverview } from "./demo-overview.ts";
import type { IntelligenceOverview } from "@/lib/intelligence-types.ts";

export class BusinessBrainService {
  constructor(private db: Kysely<Database>) {}

  async getOverview(
    userId: string,
    publicId: string,
    options?: { demo?: boolean },
  ): Promise<IntelligenceOverview> {
    const member = await requireBusiness(
      this.db,
      userId,
      publicId,
      "analytics.view",
    );
    const business = await this.db
      .selectFrom("business")
      .select(["id", "timezone"])
      .where("id", "=", member.id)
      .executeTakeFirstOrThrow();

    if (
      options?.demo &&
      process.env.INTELLIGENCE_DEMO === "1" &&
      process.env.NODE_ENV !== "production"
    ) {
      await logIntelligenceEvent(this.db, {
        businessId: business.id,
        userId,
        operation: "overview_demo",
        reason: "demo_flag",
      });
      return buildDemoOverview();
    }

    const snap = await loadInternalSnapshot(
      this.db,
      business.id,
      business.timezone || "UTC",
    );

    if (!snap.hasAnyActivity) {
      const overview: IntelligenceOverview = {
        dataMode: "insufficient",
        lastUpdated: new Date().toISOString(),
        summary: {
          status: "stable",
          text: summaryText("stable", 0, "insufficient"),
        },
        metrics: [],
        signals: [],
        insights: [],
        recommendations: [],
      };
      await logIntelligenceEvent(this.db, {
        businessId: business.id,
        userId,
        operation: "overview_insufficient",
      });
      return overview;
    }

    const signals = buildSignals(snap);
    const insights = buildInsights(signals);
    const recommendations = buildRecommendations(insights);
    const status = aggregateBusinessStatus(signals);

    const overview: IntelligenceOverview = {
      dataMode: "live",
      lastUpdated: new Date().toISOString(),
      summary: {
        status,
        text: summaryText(status, signals.length, "live"),
      },
      metrics: buildMetrics(snap),
      signals,
      insights,
      recommendations,
    };

    await logIntelligenceEvent(this.db, {
      businessId: business.id,
      userId,
      operation: "overview",
      metadata: {
        signalCount: signals.length,
        status,
      },
    });

    return overview;
  }
}
