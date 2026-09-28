import { audit } from "../audit/service.ts";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import {
  LEAD_FIELDS,
  type LeadSetupDraft,
} from "../../lib/leadSetupDraft.ts";
import { syncLeadFormFields } from "../leads/forms.ts";
import {
  ensureLeadSetupV2,
  parseLeadSetupV2,
  saveLeadSetupV2,
  validateLeadSetupV2,
} from "../leads/setup.ts";
import {
  getLeadReadiness,
  leadSolutionCardState,
} from "../leads/readiness.ts";
import {
  ACTIVATABLE_SOLUTIONS,
  SOLUTIONS,
  normalizeSolutionCode,
} from "./catalog.ts";
import { assertCanGrantEntitlement } from "../billing/entitlement.ts";
import type { EntitlementStatus } from "../billing/types.ts";
import { trackProductEvent } from "../analytics/product-events.ts";
import type { SolutionStatus } from "../../types/index.ts";
import { requireBusiness } from "../access/permissions.ts";
import {
  cancelSetupDraft,
  clearOpenSetupDraft,
  resolveSetupNotifications,
} from "./setup-draft.ts";

export type SolutionLifecycleStatus =
  | "not_connected"
  | "setup_in_progress"
  | "active"
  | "paused"
  | "disabled"
  | "expired"
  | "error";

export function validateSetup(raw: unknown): LeadSetupDraft {
  const d = raw as LeadSetupDraft;
  if (
    !d ||
    d.version !== 1 ||
    !Number.isInteger(d.step) ||
    d.step < 0 ||
    d.step > 3 ||
    !Array.isArray(d.channels) ||
    !Array.isArray(d.fields) ||
    d.channels.some((v) => !["telegram", "vk"].includes(v)) ||
    new Set(d.channels).size !== d.channels.length ||
    d.fields.some((v) => !LEAD_FIELDS.some((f) => f.id === v)) ||
    new Set(d.fields).size !== d.fields.length ||
    !d.fields.includes("name") ||
    (d.step > 0 && !d.channels.length)
  )
    throw new AppError(
      400,
      "INVALID_SETUP",
      "Проверьте площадки и вопросы заявки.",
    );
  const copy = (key: "title" | "greeting" | "finalMessage", max: number) => {
    const v = d[key];
    if (v !== undefined && (typeof v !== "string" || v.length > max))
      throw new AppError(400, "INVALID_SETUP", "Проверьте тексты сценария.");
    return v?.trim();
  };
  const fieldOptions: NonNullable<LeadSetupDraft["fieldOptions"]> = {};
  if (d.fieldOptions)
    for (const field of d.fields) {
      const o = d.fieldOptions[field];
      if (o) {
        if (
          typeof o.label !== "string" ||
          !o.label.trim() ||
          o.label.length > 150 ||
          typeof o.required !== "boolean"
        )
          throw new AppError(400, "INVALID_SETUP", "Проверьте вопросы.");
        fieldOptions[field] = {
          label: o.label.trim(),
          required: field === "name" || o.required,
        };
      }
    }
  return {
    ...(d.title !== undefined ? { title: copy("title", 100) } : {}),
    ...(d.greeting !== undefined ? { greeting: copy("greeting", 2000) } : {}),
    ...(d.finalMessage !== undefined
      ? { finalMessage: copy("finalMessage", 2000) }
      : {}),
    ...(d.fieldOptions ? { fieldOptions } : {}),
    version: 1,
    step: d.step,
    channels: [...d.channels],
    fields: LEAD_FIELDS.filter((f) => d.fields.includes(f.id)).map((f) => f.id),
  };
}

function mapEntitlementStatus(
  status: Database["business_solution"]["status"] | undefined,
  expiresAt: Date | null | undefined,
  now: number,
): { entitlementStatus: EntitlementStatus; entitled: boolean } {
  if (!status) return { entitlementStatus: "absent", entitled: false };
  if (status === "disabled")
    return { entitlementStatus: "disabled", entitled: false };
  if (status === "paused")
    return { entitlementStatus: "paused", entitled: false };
  if (status === "expired")
    return { entitlementStatus: "expired", entitled: false };
  if (expiresAt && expiresAt.getTime() <= now)
    return { entitlementStatus: "expired", entitled: false };
  if (status === "trial") return { entitlementStatus: "trial", entitled: true };
  if (status === "active")
    return { entitlementStatus: "active", entitled: true };
  return { entitlementStatus: "absent", entitled: false };
}

/** Map canonical lifecycle → legacy SolutionStatus for UI backward compat. */
function legacyStatusFromLifecycle(
  lifecycle: SolutionLifecycleStatus,
): SolutionStatus {
  switch (lifecycle) {
    case "not_connected":
    case "disabled":
    case "expired":
      return "available";
    case "setup_in_progress":
      return "setup_required";
    case "active":
      return "active";
    case "paused":
    case "error":
      return "paused";
    default:
      return "available";
  }
}

export { cancelSetupDraft, resolveSetupNotifications } from "./setup-draft.ts";

export class SolutionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly telegramEnabled = false,
    private readonly vkEnabled = false,
    private readonly metaEnabled = false,
  ) {}
  async business(userId: string, publicId: string, write = false) {
    if (write) {
      const b = await requireBusiness(
        this.db,
        userId,
        publicId,
        "solutions.manage",
      );
      return b.id;
    }
    const row = await this.db
      .selectFrom("business")
      .innerJoin("business_member as m", "m.business_id", "business.id")
      .select(["business.id", "m.role"])
      .where("business.public_id", "=", publicId)
      .where("business.archived_at", "is", null)
      .where("m.user_id", "=", userId)
      .where("m.status", "=", "active")
      .executeTakeFirst();
    if (!row)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
    return row.id;
  }
  async get(userId: string, publicId: string) {
    const id = await this.business(userId, publicId);
    const { setup, revision } = await ensureLeadSetupV2(this.db, id);
    return {
      draft: setup,
      revision,
      version: 2 as const,
    };
  }
  async save(userId: string, publicId: string, body: Record<string, unknown>) {
    if (!Number.isInteger(body.revision) || Number(body.revision) < 0)
      throw new AppError(400, "INVALID_REVISION", "Обновите настройку.");

    const rawDraft = body.draft;
    const isV2 =
      rawDraft &&
      typeof rawDraft === "object" &&
      (rawDraft as { version?: unknown }).version === 2;

    // Legacy v1 posts: convert then save as V2 (fields synced once if empty).
    if (!isV2) {
      const draft = validateSetup(rawDraft);
      const v2 = parseLeadSetupV2({
        ...draft,
        version: 1,
      });
      // Preserve the legacy V1 contract: step 3 means configuration is saved.
      // Customer availability is still gated by connection/runtime readiness.
      if (draft.step === 3) {
        v2.completed = true;
        v2.setupStep = 6;
      } else {
        v2.setupStep = Math.min(draft.step, 6);
        v2.completed = false;
      }

      const saved = await saveLeadSetupV2(this.db, userId, publicId, {
        draft: v2,
        revision: Number(body.revision),
        convertLegacyFields: true,
      });

      if (body.syncFields !== false) {
        await this.db.transaction().execute(async (tx) => {
          const id = await new SolutionService(tx).business(
            userId,
            publicId,
            true,
          );
          await syncLeadFormFields(tx, id, draft);
        });
      }

      if (draft.step === 3) {
        await this.activateLeadsEntitlement(userId, publicId);
      }

      await this.db.transaction().execute(async (tx) => {
        const id = await new SolutionService(tx).business(userId, publicId, true);
        await audit(tx, id, userId, "settings_changed", id, {
          solution: "leads",
          revision: saved.revision,
        });
        const svc = new SolutionService(tx);
        if (draft.step < 3)
          await svc.touchSetupDraft(id, "leads", { step: draft.step });
        else await svc.completeSetupDraft(id, "leads");
      });
      return { draft: saved.draft, revision: saved.revision, version: 2 as const };
    }

    const setup = validateLeadSetupV2(rawDraft);

    // Never persist completed=true before launch prerequisites are valid.
    // Readiness is evaluated against the candidate setup, not the previous draft.
    if (setup.completed) {
      const id = await this.business(userId, publicId, true);
      const readiness = await getLeadReadiness(this.db, id, setup);
      if (!readiness.ready) {
        throw new AppError(
          400,
          "NOT_READY",
          readiness.checks.find((check) => !check.ok)?.message ||
            "Завершите настройку перед запуском.",
        );
      }
      await assertCanGrantEntitlement({
        db: this.db,
        businessId: id,
        solutionCode: "leads",
      });
    }

    const saved = await saveLeadSetupV2(this.db, userId, publicId, {
      draft: setup,
      revision: Number(body.revision),
    });

    if (setup.completed) {
      await this.activateLeadsEntitlement(userId, publicId);
    }

    await this.db.transaction().execute(async (tx) => {
      const id = await new SolutionService(tx).business(userId, publicId, true);
      await audit(tx, id, userId, "settings_changed", id, {
        solution: "leads",
        revision: saved.revision,
      });
      const svc = new SolutionService(tx);
      if (!setup.completed)
        await svc.touchSetupDraft(id, "leads", { step: setup.setupStep });
      else await svc.completeSetupDraft(id, "leads");
    });

    return { draft: saved.draft, revision: saved.revision, version: 2 as const };
  }

  private async activateLeadsEntitlement(userId: string, publicId: string) {
    await this.db.transaction().execute(async (tx) => {
      const id = await new SolutionService(tx).business(userId, publicId, true);
      await assertCanGrantEntitlement({
        db: tx,
        businessId: id,
        solutionCode: "leads",
      });
      await tx
        .insertInto("business_solution")
        .values({
          business_id: id,
          solution_code: "leads",
          status: "active",
          starts_at: new Date(),
          expires_at: null,
        })
        .onConflict((oc) =>
          oc.columns(["business_id", "solution_code"]).doUpdateSet({
            status: "active",
            expires_at: null,
            disabled_at: null,
            paused_at: null,
            updated_at: new Date(),
          }),
        )
        .execute();
      await audit(tx, id, userId, "settings_changed", id, {
        solution: "leads",
        event: "launched",
      });
      await trackProductEvent(tx, {
        businessId: id,
        userId,
        event: "leads_launched",
        meta: {},
      });
    });
  }
  async activate(
    userId: string,
    publicId: string,
    raw: Record<string, unknown>,
  ) {
    const code = normalizeSolutionCode(String(raw.code));
    if (!(ACTIVATABLE_SOLUTIONS as readonly string[]).includes(code))
      throw new AppError(400, "INVALID_SOLUTION", "Выберите решение.");
    const statusFromRaw =
      raw.status === "paused" ||
      raw.status === "active" ||
      raw.status === "disabled"
        ? (raw.status as "paused" | "active" | "disabled")
        : null;
    if (statusFromRaw == null && typeof raw.enabled !== "boolean")
      throw new AppError(400, "INVALID_SOLUTION", "Выберите решение.");
    const status =
      statusFromRaw ?? (raw.enabled ? "active" : "disabled");
    const enabling = status === "active";
    const result = await this.db.transaction().execute(async (tx) => {
      const id = await new SolutionService(tx).business(userId, publicId, true);
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .execute();
      await new SolutionService(tx).business(userId, publicId, true);
      const previous = await tx
        .selectFrom("business_solution")
        .select(["status", "settings_reset_at"])
        .where("business_id", "=", id)
        .where("solution_code", "=", code)
        .executeTakeFirst();
      const previousStatus = previous?.status;
      if (enabling) {
        await assertCanGrantEntitlement({
          db: tx,
          businessId: id,
          solutionCode: code,
        });
      }
      const now = new Date();
      const patch: {
        status: typeof status;
        expires_at: null;
        updated_at: Date;
        disabled_at: Date | null;
        paused_at: Date | null;
        settings_reset_at?: Date | null;
      } = {
        status,
        expires_at: null,
        updated_at: now,
        disabled_at: status === "disabled" ? now : null,
        paused_at: status === "paused" ? now : null,
      };
      // Clear settings_reset_at on reenable only (not while resetting).
      if (enabling && previousStatus === "disabled") {
        patch.settings_reset_at = null;
      }
      await tx
        .insertInto("business_solution")
        .values({
          business_id: id,
          solution_code: code,
          status,
          starts_at: now,
          expires_at: null,
          disabled_at: patch.disabled_at,
          paused_at: patch.paused_at,
          settings_reset_at: patch.settings_reset_at ?? null,
        })
        .onConflict((oc) =>
          oc.columns(["business_id", "solution_code"]).doUpdateSet(patch),
        )
        .execute();

      if (status === "disabled") {
        await resolveSetupNotifications(tx, id, code);
        await audit(tx, id, userId, "solution.disabled", id, {
          solution: code,
          previousStatus: previousStatus ?? null,
        });
      } else if (status === "paused") {
        await audit(tx, id, userId, "solution.paused", id, {
          solution: code,
          previousStatus: previousStatus ?? null,
        });
      } else if (status === "active") {
        if (previousStatus === "paused") {
          await audit(tx, id, userId, "solution.resumed", id, {
            solution: code,
          });
        } else if (previousStatus === "disabled") {
          await audit(tx, id, userId, "solution.reenabled", id, {
            solution: code,
          });
        } else {
          await audit(tx, id, userId, "settings_changed", id, {
            solution: code,
            status,
          });
        }
      } else {
        await audit(tx, id, userId, "settings_changed", id, {
          solution: code,
          status,
        });
      }

      return {
        ok: true as const,
        enabled: enabling,
        code,
        businessId: id,
        status,
        previousStatus: previousStatus ?? null,
      };
    });
    if (result.enabled && result.previousStatus !== "paused" && result.previousStatus !== "disabled") {
      await trackProductEvent(this.db, {
        event: "solution_activated",
        businessId: result.businessId,
        userId,
        meta: { solution: result.code },
      });
    }
    return { ok: true, status: result.status };
  }
  async cancelSetup(userId: string, publicId: string, code: string) {
    const solutionCode = normalizeSolutionCode(code);
    if (!(ACTIVATABLE_SOLUTIONS as readonly string[]).includes(solutionCode))
      throw new AppError(400, "INVALID_SOLUTION", "Выберите решение.");
    return this.db.transaction().execute(async (tx) => {
      const id = await new SolutionService(tx).business(userId, publicId, true);
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .execute();
      await new SolutionService(tx).business(userId, publicId, true);
      const result = await cancelSetupDraft(tx, id, solutionCode, {
        mode: "user_cancel",
      });
      if (!result.ok) {
        // No open draft — still disable as user cancel intent.
        const now = new Date();
        await tx
          .insertInto("business_solution")
          .values({
            business_id: id,
            solution_code: solutionCode,
            status: "disabled",
            starts_at: now,
            expires_at: null,
            disabled_at: now,
            paused_at: null,
          })
          .onConflict((oc) =>
            oc.columns(["business_id", "solution_code"]).doUpdateSet({
              status: "disabled",
              disabled_at: now,
              paused_at: null,
              updated_at: now,
            }),
          )
          .execute();
        await resolveSetupNotifications(tx, id, solutionCode);
      }
      await audit(tx, id, userId, "solution.setup_cancelled", id, {
        solution: solutionCode,
      });
      return { ok: true as const, status: "disabled" as const };
    });
  }
  async resetSettings(userId: string, publicId: string, code: string) {
    const solutionCode = normalizeSolutionCode(code);
    if (!(ACTIVATABLE_SOLUTIONS as readonly string[]).includes(solutionCode))
      throw new AppError(400, "INVALID_SOLUTION", "Выберите решение.");
    return this.db.transaction().execute(async (tx) => {
      const id = await new SolutionService(tx).business(userId, publicId, true);
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", id)
        .forUpdate()
        .execute();
      await new SolutionService(tx).business(userId, publicId, true);
      const now = new Date();

      await clearOpenSetupDraft(tx, id, solutionCode);

      if (solutionCode === "booking") {
        await resetBookingConfig(tx, id);
      } else if (solutionCode === "leads") {
        const { newLeadSetupV2 } = await import("../../lib/leadSetupV2.ts");
        const draft = newLeadSetupV2();
        const current = await tx
          .selectFrom("lead_setup")
          .select("revision")
          .where("business_id", "=", id)
          .executeTakeFirst();
        const revision = (current?.revision ?? 0) + 1;
        await tx
          .insertInto("lead_setup")
          .values({
            business_id: id,
            draft: JSON.stringify(draft),
            revision,
            updated_at: now,
          })
          .onConflict((oc) =>
            oc.column("business_id").doUpdateSet({
              draft: JSON.stringify(draft),
              revision,
              updated_at: now,
            }),
          )
          .execute();
        // Soft-deactivate form fields; keep rows for history.
        await tx
          .updateTable("lead_form_field")
          .set({ active: false, updated_at: now })
          .where("business_id", "=", id)
          .where("active", "=", true)
          .execute();
      } else if (
        solutionCode === "orders" ||
        solutionCode === "autopost" ||
        solutionCode === "admin_messages"
      ) {
        // Catalog/history retained; only clear optional solution_config + flag.
        await tx
          .deleteFrom("solution_config")
          .where("business_id", "=", id)
          .where("solution_code", "=", solutionCode)
          .execute();
      }

      await tx
        .updateTable("business_solution")
        .set({ settings_reset_at: now, updated_at: now })
        .where("business_id", "=", id)
        .where("solution_code", "=", solutionCode)
        .execute();

      await audit(tx, id, userId, "solution.settings_reset", id, {
        solution: solutionCode,
        note:
          solutionCode === "orders"
            ? "catalog_retained"
            : solutionCode === "booking"
              ? "services_deactivated"
              : undefined,
      });
      return { ok: true as const };
    });
  }
  async touchSetupDraft(
    businessId: string,
    code: string,
    draftPatch: Record<string, unknown> = {},
  ) {
    const solutionCode = normalizeSolutionCode(code);
    const now = new Date();
    const current = await this.db
      .selectFrom("solution_setup_draft")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("solution_code", "=", solutionCode)
      .executeTakeFirst();
    const prevDraft =
      current?.draft && typeof current.draft === "object"
        ? (current.draft as Record<string, unknown>)
        : {};
    const draft = { ...prevDraft, ...draftPatch };
    const previous = await this.db
      .selectFrom("business_solution")
      .select(["status"])
      .where("business_id", "=", businessId)
      .where("solution_code", "=", solutionCode)
      .executeTakeFirst();
    await this.db
      .insertInto("solution_setup_draft")
      .values({
        business_id: businessId,
        solution_code: solutionCode,
        status: "in_progress",
        draft,
        previous_solution_status: previous?.status ?? null,
        previous_config: null,
        started_at: now,
        last_activity_at: now,
        reminder_sent_at: null,
        cancel_after: null,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "solution_code"]).doUpdateSet({
          status: "in_progress",
          draft,
          last_activity_at: now,
          reminder_sent_at: null,
          cancel_after: null,
          updated_at: now,
        }),
      )
      .execute();
    return { ok: true as const };
  }
  async completeSetupDraft(businessId: string, code: string) {
    const solutionCode = normalizeSolutionCode(code);
    const now = new Date();
    await this.db
      .updateTable("solution_setup_draft")
      .set({
        status: "completed",
        updated_at: now,
        cancel_after: null,
      })
      .where("business_id", "=", businessId)
      .where("solution_code", "=", solutionCode)
      .where("status", "in", ["in_progress", "reminded"])
      .execute();
    await resolveSetupNotifications(this.db, businessId, solutionCode);
    return { ok: true as const };
  }
  async cancelSetupDraft(
    businessId: string,
    code: string,
    options?: { mode: "user_cancel" | "auto_expire" },
  ) {
    return cancelSetupDraft(this.db, businessId, code, options);
  }
  async getSetupDraft(userId: string, publicId: string, code: string) {
    const id = await this.business(userId, publicId);
    const solutionCode = normalizeSolutionCode(code);
    const row = await this.db
      .selectFrom("solution_setup_draft")
      .selectAll()
      .where("business_id", "=", id)
      .where("solution_code", "=", solutionCode)
      .executeTakeFirst();
    if (!row) return null;
    const draft =
      row.draft && typeof row.draft === "object"
        ? (row.draft as Record<string, unknown>)
        : {};
    return {
      businessId: id,
      code: solutionCode,
      status: row.status,
      draft,
      step: typeof draft.step === "number" ? draft.step : 1,
      started_at: row.started_at,
      last_activity_at: row.last_activity_at,
      reminder_sent_at: row.reminder_sent_at,
    };
  }
  async list(userId: string, publicId: string) {
    const id = await this.business(userId, publicId);
    const setup = await this.get(userId, publicId);
    const leadReadiness = await getLeadReadiness(this.db, id);
    const enabledSolutions = await this.db
      .selectFrom("business_solution")
      .select(["solution_code", "status", "expires_at"])
      .where("business_id", "=", id)
      .execute();
    const setupDrafts = await this.db
      .selectFrom("solution_setup_draft")
      .select(["solution_code", "status", "draft"])
      .where("business_id", "=", id)
      .where("status", "in", ["in_progress", "reminded"])
      .execute();
    const draftByCode = new Map(
      setupDrafts.map((d) => {
        const draft =
          d.draft && typeof d.draft === "object"
            ? (d.draft as Record<string, unknown>)
            : {};
        return [
          normalizeSolutionCode(d.solution_code),
          {
            status: d.status as "in_progress" | "reminded",
            step: typeof draft.step === "number" ? draft.step : 1,
          },
        ] as const;
      }),
    );
    const now = Date.now();
    const solutionState = new Map(
      enabledSolutions.map((item) => {
        const mapped = mapEntitlementStatus(
          item.status,
          item.expires_at,
          now,
        );
        return [
          normalizeSolutionCode(item.solution_code),
          {
            entitled: mapped.entitled,
            entitlementStatus: mapped.entitlementStatus,
            status: item.status,
          },
        ] as const;
      }),
    );
    const connections = await this.db
      .selectFrom("business_connection")
      .select(["id", "platform"])
      .where("business_id", "=", id)
      .where("status", "=", "connected")
      .execute();
    const beats = await this.db
      .selectFrom("worker_heartbeat")
      .selectAll()
      .execute();
    const alive = (name: string) =>
      beats.some((b) => b.name === name && +b.seen_at > now - 60000);
    const states = new Map<string, { ready: boolean; error: boolean }>();
    for (const connection of connections) {
      let runtime: { status: string } | undefined;
      let workerName: "telegram" | "vk" | "meta_delivery";
      let channelEnabled: boolean;

      if (connection.platform === "telegram") {
        runtime = await this.db
          .selectFrom("telegram_runtime")
          .select("status")
          .where("connection_id", "=", connection.id)
          .executeTakeFirst();
        workerName = "telegram";
        channelEnabled = this.telegramEnabled;
      } else if (connection.platform === "vk") {
        runtime = await this.db
          .selectFrom("vk_runtime")
          .select("status")
          .where("connection_id", "=", connection.id)
          .executeTakeFirst();
        workerName = "vk";
        channelEnabled = this.vkEnabled;
      } else {
        runtime = await this.db
          .selectFrom("meta_runtime")
          .select("status")
          .where("connection_id", "=", connection.id)
          .executeTakeFirst();
        workerName = "meta_delivery";
        channelEnabled = this.metaEnabled;
      }

      states.set(connection.platform, {
        ready:
          runtime?.status === "ready" &&
          alive(workerName) &&
          channelEnabled,
        error:
          runtime?.status === "error" ||
          (runtime?.status === "ready" && (!alive(workerName) || !channelEnabled)),
      });
    }
    const [productCount, serviceCount, targetCount, orderFulfillment] =
      await Promise.all([
      this.db
        .selectFrom("product")
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("business_id", "=", id)
        .where("active", "=", true)
        .executeTakeFirst()
        .then((row) => Number(row?.n ?? 0)),
      this.db
        .selectFrom("booking_service")
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("business_id", "=", id)
        .where("active", "=", true)
        .executeTakeFirst()
        .then((row) => Number(row?.n ?? 0)),
      this.db
        .selectFrom("post_target")
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("business_id", "=", id)
        .executeTakeFirst()
        .then((row) => Number(row?.n ?? 0)),
      this.db
        .selectFrom("order_settings")
        .select(["pickup_enabled", "delivery_enabled"])
        .where("business_id", "=", id)
        .executeTakeFirst(),
    ]);
    const connectedChannels = [...states.keys()];
    return SOLUTIONS.filter((solution) =>
      (ACTIVATABLE_SOLUTIONS as readonly string[]).includes(solution.code),
    ).map((solution) => {
      const state = solutionState.get(solution.code);
      const entitled = !!state?.entitled;
      const entitlementStatus: EntitlementStatus =
        state?.entitlementStatus ?? "absent";
      const openDraft = draftByCode.get(solution.code);
      const channels =
        solution.code === "leads"
          ? setup.draft.channels
          : connectedChannels;
      const ready =
        channels.length > 0 && channels.every((c) => states.get(c)?.ready);
      const scheduler =
        solution.code === "autopost"
          ? alive("autopost")
          : solution.code === "booking"
            ? alive("booking_reminders")
            : true;

      let readinessIncomplete = false;
      let channelError = false;
      let note = "Подключите решение, чтобы настроить его функции.";
      let cardState:
        | ReturnType<typeof leadSolutionCardState>
        | undefined;

      if (entitled) {
        if (solution.code === "leads") {
          cardState = leadSolutionCardState(leadReadiness, entitled);
          const channelFail = leadReadiness.checks.find(
            (c) =>
              !c.ok &&
              (c.code === "CHANNEL_TELEGRAM" || c.code === "CHANNEL_VK"),
          );
          const channelMissing =
            channelFail &&
            /Подключите/.test(channelFail.message || "");
          const channelBroken =
            channelFail && !channelMissing;
          if (!leadReadiness.setup.completed) {
            readinessIncomplete = true;
            note =
              leadReadiness.checks.find((c) => !c.ok)?.message ||
              cardState.label;
          } else if (channelMissing) {
            // Selected channel not connected yet — keep setup-in-progress UX.
            readinessIncomplete = true;
            note = channelFail?.message || "Подключите выбранные каналы.";
          } else if (channelBroken) {
            channelError = true;
            note = channelFail?.message || "Требует внимания";
          } else if (!leadReadiness.ready) {
            readinessIncomplete = true;
            note =
              leadReadiness.checks.find((c) => !c.ok)?.message ||
              cardState.label;
          } else if (ready) {
            note = "Каналы приёма заявок и обработчики отвечают.";
          } else if (channels.some((c) => states.get(c)?.error)) {
            channelError = true;
            note =
              "Обработчик сообщений не отвечает или канал приостановлен.";
          } else {
            readinessIncomplete = true;
            note = "Запустите выбранные каналы в разделе «Подключения».";
          }
        } else if (solution.code === "orders" && productCount === 0) {
          readinessIncomplete = true;
          note = "Добавьте первый товар в каталог.";
        } else if (
          solution.code === "orders" &&
          orderFulfillment &&
          !orderFulfillment.pickup_enabled &&
          !orderFulfillment.delivery_enabled
        ) {
          readinessIncomplete = true;
          note = "Включите доставку или самовывоз в настройках заказов.";
        } else if (solution.code === "booking" && serviceCount === 0) {
          readinessIncomplete = true;
          note = "Создайте услугу и настройте расписание.";
        } else if (solution.code === "autopost" && targetCount === 0) {
          readinessIncomplete = true;
          note = "Подключите площадку Telegram или VK для публикаций.";
        } else if (
          solution.code === "admin_messages" &&
          connectedChannels.length === 0
        ) {
          readinessIncomplete = true;
          note = "Подключите Telegram или VK, чтобы принимать сообщения.";
        } else if (ready && scheduler) {
          note = "Подключения и обработчики отвечают.";
        } else {
          channelError = true;
          note =
            "Проверьте запуск каналов и состояние обработчиков на сервере.";
        }
      }

      // Canonical lifecycle priority (SoT).
      let lifecycleStatus: SolutionLifecycleStatus;
      if (entitlementStatus === "disabled") {
        lifecycleStatus = "disabled";
        note = "Отключено. Подключить снова.";
      } else if (entitlementStatus === "expired") {
        lifecycleStatus = "expired";
        note = "Срок истёк. Подключите решение снова.";
      } else if (entitlementStatus === "paused") {
        lifecycleStatus = "paused";
        note = "Приостановлено. Можно возобновить или отключить.";
      } else if (!entitled) {
        lifecycleStatus = "not_connected";
        if (solution.code === "leads") {
          cardState = leadSolutionCardState(leadReadiness, false);
          note = setup.revision
            ? cardState.label === "Не настроено"
              ? "Подключите решение, чтобы продолжить настройку."
              : cardState.label
            : "Выберите площадки и вопросы.";
        } else if (solution.code === "moderation") {
          note = "Решение пока не подключено к продукту.";
        } else {
          note = "Подключите решение, чтобы пройти настройку.";
        }
      } else if (openDraft || readinessIncomplete) {
        lifecycleStatus = "setup_in_progress";
        if (openDraft && !readinessIncomplete) {
          note = "Продолжите настройку решения.";
        }
      } else if (channelError) {
        lifecycleStatus = "error";
      } else {
        lifecycleStatus = "active";
      }

      const status = legacyStatusFromLifecycle(lifecycleStatus);

      return {
        id: publicId + ":" + solution.code,
        businessId: publicId,
        solutionId: solution.id,
        status,
        lifecycleStatus,
        note,
        entitlementStatus,
        ...(cardState
          ? {
              cardState: cardState.state,
              cardLabel: cardState.label,
              cardActionLabel: cardState.actionLabel,
              cardHref: cardState.href,
              cardDetail: "detail" in cardState ? cardState.detail : undefined,
            }
          : {}),
        ...(openDraft
          ? { setupDraft: { status: openDraft.status, step: openDraft.step } }
          : {}),
      };
    });
  }
}

/** Shared booking config reset — deactivates catalog, keeps bookings/clients. */
export async function resetBookingConfig(
  tx: Kysely<Database>,
  businessId: string,
) {
  const now = new Date();
  await tx
    .updateTable("booking_service")
    .set({ active: false, updated_at: now })
    .where("business_id", "=", businessId)
    .execute();
  await tx
    .updateTable("booking_specialist")
    .set({ active: false, updated_at: now })
    .where("business_id", "=", businessId)
    .execute();
  await tx
    .deleteFrom("booking_schedule")
    .where("business_id", "=", businessId)
    .execute();
  await tx
    .deleteFrom("booking_schedule_exception")
    .where("business_id", "=", businessId)
    .execute();
  await tx
    .updateTable("booking_manual_slot")
    .set({ active: false })
    .where("business_id", "=", businessId)
    .execute();
  const defaults = {
    business_id: businessId,
    minimum_booking_notice: 120,
    maximum_booking_horizon: 60,
    slot_interval: 15,
    choose_specialist: true,
    schedule_mode: "automatic" as const,
    client_reminders_enabled: true,
    client_reminder_offsets: JSON.stringify([1440, 120]),
    client_reminder_template: "",
    staff_reminder_offsets: JSON.stringify([1440, 30]),
    allow_customer_cancel: true,
    cancel_before_minutes: 0,
    allow_reschedule: true,
    reschedule_before_minutes: 0,
  };
  await tx
    .insertInto("booking_settings")
    .values(defaults)
    .onConflict((oc) => oc.column("business_id").doUpdateSet(defaults))
    .execute();
  await clearOpenSetupDraft(tx, businessId, "booking");
}
