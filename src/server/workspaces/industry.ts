import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { audit } from "../audit/service.ts";
import {
  type IndustryId,
  type BusinessModel,
  type SetupMode,
  type CapabilityId,
  industryPreset,
  businessTypeFromModel,
  allIndustryPresets,
  INDUSTRY_CARDS,
} from "../../lib/industryPresets.ts";
import {
  resolveCapabilityDependencies,
  CAPABILITY_DEFS,
  searchSettingsIndex,
} from "../../lib/capabilities.ts";

const INDUSTRIES = new Set(INDUSTRY_CARDS.map((c) => c.id));

function parseIndustry(value: unknown): IndustryId | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string" && INDUSTRIES.has(value as IndustryId)) {
    return value as IndustryId;
  }
  throw new AppError(400, "INVALID_INDUSTRY", "Выберите направление бизнеса.");
}

function parseModel(value: unknown): BusinessModel | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    value === "services" ||
    value === "commerce" ||
    value === "hybrid"
  ) {
    return value;
  }
  throw new AppError(400, "INVALID_BUSINESS_MODEL", "Неверная модель бизнеса.");
}

function parseSetupMode(value: unknown): SetupMode {
  if (value === "advanced" || value === "guided") return value;
  if (value === undefined || value === null || value === "") return "guided";
  throw new AppError(400, "INVALID_SETUP_MODE", "Режим: guided или advanced.");
}

function parseCapabilities(raw: unknown): CapabilityId[] {
  if (!raw || typeof raw !== "object") return [];
  const o = raw as { enabled?: unknown };
  if (!Array.isArray(o.enabled)) return [];
  const allowed = new Set(CAPABILITY_DEFS.map((c) => c.id));
  return o.enabled.filter(
    (x): x is CapabilityId => typeof x === "string" && allowed.has(x as CapabilityId),
  );
}

function parseProgress(raw: unknown): Record<string, boolean> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && k.length <= 64) out[k] = v === true;
  }
  return out;
}

/** Mirrors SolutionService entitlement mapping: trial/active and not expired. */
function solutionEntitled(
  status: "active" | "trial" | "expired" | "disabled" | "paused",
  expiresAt: Date | null,
  now: number,
): boolean {
  if (expiresAt && expiresAt.getTime() <= now) return false;
  return status === "active" || status === "trial";
}

export class IndustrySetupService {
  constructor(private db: Kysely<Database>) {}

  /**
   * Setup steps that have a source of truth in live data are derived here, not
   * read from business.setup_progress, so a manual tick can never make the
   * checklist claim progress the business does not have.
   */
  private async readiness(businessId: string, hasIndustry: boolean) {
    const now = Date.now();
    const [connections, solutions, drafts] = await Promise.all([
      this.db
        .selectFrom("business_connection")
        .select(["platform", "status"])
        .where("business_id", "=", businessId)
        .execute(),
      this.db
        .selectFrom("business_solution")
        .select(["status", "expires_at"])
        .where("business_id", "=", businessId)
        .execute(),
      this.db
        .selectFrom("solution_setup_draft")
        .select("solution_code")
        .where("business_id", "=", businessId)
        .where("status", "in", ["in_progress", "reminded"])
        .executeTakeFirst(),
    ]);
    return {
      hasIndustry,
      hasActiveSolution:
        solutions.some((row) => solutionEntitled(row.status, row.expires_at, now)) ||
        Boolean(drafts),
      hasConnection: connections.some(
        (row) => row.platform === "telegram" && row.status === "connected",
      ),
    };
  }

  async get(userId: string, publicId: string) {
    const b = await requireBusiness(this.db, userId, publicId, "clients.read");
    const row = await this.db
      .selectFrom("business")
      .select([
        "industry",
        "industry_subtype",
        "business_model",
        "setup_mode",
        "business_type",
        "capabilities",
        "setup_progress",
        "onboarding_completed_at",
        "name",
      ])
      .where("id", "=", b.id)
      .executeTakeFirstOrThrow();
    const preset = industryPreset(row.industry);
    const readiness = await this.readiness(b.id, Boolean(row.industry));
    return {
      ...row,
      capabilities_enabled: parseCapabilities(row.capabilities),
      setup_progress: parseProgress(row.setup_progress),
      readiness,
      preset: preset
        ? {
            id: preset.id,
            label: preset.label,
            recommendedSolutions: preset.recommendedSolutions,
            optionalSolutions: preset.optionalSolutions,
            recommendedCapabilities: preset.recommendedCapabilities,
            terminology: preset.terminology,
            subtypes: preset.subtypes,
            questions: preset.questions,
            leadFormPreset: preset.leadFormPreset ?? null,
            bookingPreset: preset.bookingPreset ?? null,
          }
        : null,
      catalogs: {
        industries: INDUSTRY_CARDS,
        presets: allIndustryPresets().map((p) => ({
          id: p.id,
          label: p.label,
          description: p.description,
          subtypes: p.subtypes,
          defaultBusinessModel: p.defaultBusinessModel,
          recommendedSolutions: p.recommendedSolutions,
          optionalSolutions: p.optionalSolutions,
          recommendedCapabilities: p.recommendedCapabilities,
          terminology: p.terminology,
        })),
        capabilities: CAPABILITY_DEFS,
      },
    };
  }

  async save(userId: string, publicId: string, input: Record<string, unknown>) {
    const industry =
      "industry" in input ? parseIndustry(input.industry) : undefined;
    const subtype =
      "industry_subtype" in input
        ? String(input.industry_subtype ?? "").trim().slice(0, 64) || null
        : undefined;
    const model =
      "business_model" in input ? parseModel(input.business_model) : undefined;
    const setupMode =
      "setup_mode" in input ? parseSetupMode(input.setup_mode) : undefined;

    let capabilitiesPatch: { enabled: CapabilityId[] } | undefined;
    if ("capabilities_enabled" in input) {
      if (!Array.isArray(input.capabilities_enabled)) {
        throw new AppError(400, "INVALID_CAPABILITIES", "Список возможностей.");
      }
      let enabled = parseCapabilities({
        enabled: input.capabilities_enabled,
      });
      const reasons: string[] = [];
      for (const id of [...enabled]) {
        const r = resolveCapabilityDependencies(enabled, id);
        enabled = r.next;
        reasons.push(...r.reasons);
      }
      capabilitiesPatch = { enabled };
      void reasons;
    }

    let progressPatch: Record<string, boolean> | undefined;
    if ("setup_progress" in input) {
      progressPatch = parseProgress(input.setup_progress);
    }

    const complete =
      input.complete_onboarding === true || input.complete_onboarding === "true";

    await this.db.transaction().execute(async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "settings.manage");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      const current = await tx
        .selectFrom("business")
        .select([
          "industry",
          "industry_subtype",
          "business_model",
          "setup_mode",
          "business_type",
          "capabilities",
          "setup_progress",
        ])
        .where("id", "=", b.id)
        .executeTakeFirstOrThrow();

      const nextIndustry =
        industry !== undefined ? industry : (current.industry as IndustryId | null);
      const preset = industryPreset(nextIndustry);
      const nextModel =
        model !== undefined
          ? model
          : ((current.business_model as BusinessModel | null) ??
            preset?.defaultBusinessModel ??
            null);
      const patch: Record<string, unknown> = {};
      if (industry !== undefined) patch.industry = industry;
      if (subtype !== undefined) patch.industry_subtype = subtype;
      if (model !== undefined) patch.business_model = model;
      else if (industry !== undefined && preset)
        patch.business_model = preset.defaultBusinessModel;
      if (setupMode !== undefined) patch.setup_mode = setupMode;
      if (capabilitiesPatch) {
        patch.capabilities = JSON.stringify(capabilitiesPatch);
      } else if (
        industry !== undefined &&
        preset &&
        !parseCapabilities(current.capabilities).length
      ) {
        patch.capabilities = JSON.stringify({
          enabled: preset.recommendedCapabilities,
        });
      }
      if (progressPatch) {
        patch.setup_progress = JSON.stringify({
          ...parseProgress(current.setup_progress),
          ...progressPatch,
        });
      }
      if (complete) patch.onboarding_completed_at = new Date();

      // Keep legacy business_type in sync for soft catalog hints (never locks).
      if (nextModel) {
        patch.business_type = businessTypeFromModel(nextModel);
      } else if (industry === null && setupMode === "advanced") {
        /* advanced without industry — leave business_type */
      }

      if (Object.keys(patch).length) {
        await tx
          .updateTable("business")
          .set(patch as never)
          .where("id", "=", b.id)
          .execute();
      }
      await audit(tx, b.id, userId, "settings_changed", b.id, {
        industry_setup: true,
        fields: Object.keys(patch),
      });
    });
    return this.get(userId, publicId);
  }

  search(query: string) {
    return searchSettingsIndex(query).map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      section: c.section,
      path: `Расширенная настройка → ${c.section} → ${c.label}`,
    }));
  }
}
