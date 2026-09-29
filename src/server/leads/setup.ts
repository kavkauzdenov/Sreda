import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import {
  type LeadChannel,
  type LeadSetupV2,
  clampText,
  isLeadChannel,
  newLeadSetupV2,
  DEFAULT_BUTTON_LABEL,
  DEFAULT_GREETING,
  DEFAULT_FINAL_MESSAGE,
} from "../../lib/leadSetupV2.ts";
import {
  LEAD_FIELDS,
  type LeadSetupDraft,
  parseLeadSetupDraft,
} from "../../lib/leadSetupDraft.ts";
import { syncLeadFormFields } from "./forms.ts";

type Db = Kysely<Database> | Transaction<Database>;

function fail(message = "Проверьте настройки приёма заявок.") {
  return new AppError(400, "INVALID_SETUP", message);
}

export function parseLeadSetupV2(raw: unknown): LeadSetupV2 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return newLeadSetupV2();
  const d = raw as Record<string, unknown>;

  // Legacy v1 → v2 (fields stay in lead_form_field after conversion sync).
  if (d.version === 1) {
    const v1 = parseLeadSetupDraft(JSON.stringify(d));
    return convertV1ToV2(v1);
  }

  if (d.version !== 2) return newLeadSetupV2();

  const channels = Array.isArray(d.channels)
    ? ([...new Set(d.channels.filter(isLeadChannel))] as LeadChannel[])
    : [];

  const processing =
    d.processing && typeof d.processing === "object"
      ? (d.processing as Record<string, unknown>)
      : {};
  const notifications =
    d.notifications && typeof d.notifications === "object"
      ? (d.notifications as Record<string, unknown>)
      : {};

  let sla: number | null = null;
  if (
    typeof processing.firstResponseSlaMinutes === "number" &&
    Number.isInteger(processing.firstResponseSlaMinutes) &&
    processing.firstResponseSlaMinutes > 0 &&
    processing.firstResponseSlaMinutes <= 24 * 60
  ) {
    sla = processing.firstResponseSlaMinutes;
  }

  const setupStep =
    typeof d.setupStep === "number" &&
    Number.isInteger(d.setupStep) &&
    d.setupStep >= 0 &&
    d.setupStep <= 6
      ? d.setupStep
      : 0;

  return {
    version: 2,
    buttonLabel:
      clampText(d.buttonLabel ?? d.title, 100, DEFAULT_BUTTON_LABEL) ||
      DEFAULT_BUTTON_LABEL,
    greeting:
      clampText(d.greeting, 2000, DEFAULT_GREETING) || DEFAULT_GREETING,
    finalMessage:
      clampText(d.finalMessage, 2000, DEFAULT_FINAL_MESSAGE) ||
      DEFAULT_FINAL_MESSAGE,
    channels,
    defaultStatus: "new",
    processing: {
      autoAssign: false,
      duplicateDetection: processing.duplicateDetection !== false,
      firstResponseSlaMinutes: sla,
    },
    notifications: {
      // In-app notifications are part of the core lead workflow and are always on.
      inApp: true,
      staffTelegram: notifications.staffTelegram === true,
      email: false, // only enable when email infra is confirmed elsewhere
    },
    setupStep,
    completed: d.completed === true,
  };
}

export function convertV1ToV2(v1: LeadSetupDraft): LeadSetupV2 {
  const channels = v1.channels.filter(isLeadChannel) as LeadChannel[];
  return {
    version: 2,
    buttonLabel: clampText(v1.title, 100, DEFAULT_BUTTON_LABEL) || DEFAULT_BUTTON_LABEL,
    greeting: clampText(v1.greeting, 2000, DEFAULT_GREETING) || DEFAULT_GREETING,
    finalMessage:
      clampText(v1.finalMessage, 2000, DEFAULT_FINAL_MESSAGE) ||
      DEFAULT_FINAL_MESSAGE,
    channels,
    defaultStatus: "new",
    processing: {
      autoAssign: false,
      duplicateDetection: true,
      firstResponseSlaMinutes: null,
    },
    notifications: {
      inApp: true,
      // Preserve legacy behavior: verified staff Telegram bindings used to
      // receive lead notifications before the V2 switch existed.
      staffTelegram: true,
      email: false,
    },
    setupStep: v1.step === 3 ? 6 : Math.min(v1.step, 6),
    completed: v1.step === 3 && channels.length > 0,
  };
}

export function validateLeadSetupV2(raw: unknown): LeadSetupV2 {
  const setup = parseLeadSetupV2(raw);
  if (!setup.buttonLabel || setup.buttonLabel.length > 100) throw fail("Укажите название кнопки.");
  if (!setup.greeting || setup.greeting.length > 2000)
    throw fail("Проверьте приветствие.");
  if (!setup.finalMessage || setup.finalMessage.length > 2000)
    throw fail("Проверьте финальное сообщение.");
  if (setup.channels.some((c) => !isLeadChannel(c)))
    throw fail("Доступны только Telegram и VK.");
  if (new Set(setup.channels).size !== setup.channels.length)
    throw fail("Каналы не должны повторяться.");
  if (setup.completed && setup.channels.length === 0)
    throw fail("Выберите хотя бы один канал перед запуском.");
  return setup;
}

/**
 * Load setup as V2. Does not write — use ensureLeadSetupV2 to persist conversion.
 */
export async function loadLeadSetupV2(
  db: Db,
  businessId: string,
): Promise<{ setup: LeadSetupV2; revision: number; converted: boolean; raw: unknown }> {
  const row = await db
    .selectFrom("lead_setup")
    .selectAll()
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!row) {
    return { setup: newLeadSetupV2(), revision: 0, converted: false, raw: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.draft);
  } catch {
    return {
      setup: newLeadSetupV2(),
      revision: row.revision,
      converted: false,
      raw: null,
    };
  }
  const wasV1 =
    parsed &&
    typeof parsed === "object" &&
    (parsed as { version?: unknown }).version === 1;
  const setup = parseLeadSetupV2(parsed);
  return {
    setup,
    revision: row.revision,
    converted: Boolean(wasV1),
    raw: parsed,
  };
}

/**
 * Ensure draft is V2 on disk. Syncs legacy fields into lead_form_field once if empty.
 * Idempotent — safe to call on every read path that needs a durable V2 draft.
 */
export async function ensureLeadSetupV2(
  db: Db,
  businessId: string,
): Promise<{ setup: LeadSetupV2; revision: number }> {
  const initial = await loadLeadSetupV2(db, businessId);
  if (!initial.converted || !initial.raw) {
    return { setup: initial.setup, revision: initial.revision };
  }

  // Conversion is a write operation even when triggered by a read path.
  // Serialize it with every settings mutation through the business row lock.
  if (!db.isTransaction) {
    return (db as Kysely<Database>).transaction().execute((tx) =>
      ensureLeadSetupV2(tx, businessId),
    );
  }

  await db
    .selectFrom("business")
    .select("id")
    .where("id", "=", businessId)
    .forUpdate()
    .executeTakeFirstOrThrow();

  // Another transaction may have completed the conversion while we waited.
  const loaded = await loadLeadSetupV2(db, businessId);
  if (!loaded.converted || !loaded.raw) {
    return { setup: loaded.setup, revision: loaded.revision };
  }

  const active = await db
    .selectFrom("lead_form_field")
    .select("id")
    .where("business_id", "=", businessId)
    .where("active", "=", true)
    .execute();

  // Never let metadata conversion overwrite an already configured V2/custom form.
  // Legacy v1 fields are projected only when the business has no active fields yet.
  if (!active.length) {
    try {
      const v1 = parseLeadSetupDraft(JSON.stringify(loaded.raw));
      if (!v1.fields.includes("name")) v1.fields = ["name", ...v1.fields];
      await syncLeadFormFields(db, businessId, v1);
    } catch {
      // Keep metadata conversion; readiness will surface an invalid/empty form.
    }
  }

  await ensureNameField(db, businessId);
  await normalizeLeadFieldPositions(db, businessId);

  const nextRevision = loaded.revision + 1;
  const draftJson = JSON.stringify(loaded.setup);
  const changed = await db
    .updateTable("lead_setup")
    .set({
      draft: draftJson,
      revision: nextRevision,
      updated_at: new Date(),
    })
    .where("business_id", "=", businessId)
    .where("revision", "=", loaded.revision)
    .executeTakeFirst();

  // Defensive fallback: if a dialect reports no update after the lock,
  // return the durable current version rather than inventing a revision.
  if (!changed || Number(changed.numUpdatedRows) !== 1) {
    const current = await loadLeadSetupV2(db, businessId);
    return { setup: current.setup, revision: current.revision };
  }

  return { setup: loaded.setup, revision: nextRevision };
}

/**
 * Persist V2 setup. When converting from v1, sync legacy fields into lead_form_field
 * only if no active fields exist yet (idempotent).
 */
export async function saveLeadSetupV2(
  db: Kysely<Database>,
  userId: string,
  publicBusinessId: string,
  body: { draft: unknown; revision?: number; convertLegacyFields?: boolean },
) {
  const setup = validateLeadSetupV2(body.draft);
  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicBusinessId, "solutions.manage");
    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", b.id)
      .forUpdate()
      .execute();

    const current = await tx
      .selectFrom("lead_setup")
      .selectAll()
      .where("business_id", "=", b.id)
      .executeTakeFirst();

    if (
      current &&
      body.revision !== undefined &&
      body.revision !== current.revision
    ) {
      throw new AppError(
        409,
        "SETUP_CONFLICT",
        "Настройки уже изменены. Обновите страницу.",
      );
    }

    // One-time v1 field projection if requested and table empty.
    if (body.convertLegacyFields !== false) {
      const raw = body.draft;
      if (
        raw &&
        typeof raw === "object" &&
        (raw as { version?: unknown }).version === 1
      ) {
        const active = await tx
          .selectFrom("lead_form_field")
          .select("id")
          .where("business_id", "=", b.id)
          .where("active", "=", true)
          .execute();
        if (!active.length) {
          const v1 = parseLeadSetupDraft(JSON.stringify(raw));
          // Ensure name is present
          if (!v1.fields.includes("name")) v1.fields = ["name", ...v1.fields];
          await syncLeadFormFields(tx, b.id, v1);
        }
      }
    }

    // Ensure system name field always exists when completing setup.
    if (setup.completed || setup.setupStep >= 1) {
      await ensureNameField(tx, b.id);
      await normalizeLeadFieldPositions(tx, b.id);
    }

    const draftJson = JSON.stringify(setup);
    const nextRevision = (current?.revision ?? 0) + 1;
    if (current) {
      await tx
        .updateTable("lead_setup")
        .set({
          draft: draftJson,
          revision: nextRevision,
          updated_at: new Date(),
        })
        .where("business_id", "=", b.id)
        .execute();
    } else {
      await tx
        .insertInto("lead_setup")
        .values({
          business_id: b.id,
          draft: draftJson,
          revision: 1,
          updated_at: new Date(),
        })
        .execute();
    }

    return {
      draft: setup,
      revision: current ? nextRevision : 1,
    };
  });
}

async function ensureNameField(tx: Db, businessId: string) {
  const { randomUUID } = await import("node:crypto");
  const existing = await tx
    .selectFrom("lead_form_field")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("field_key", "=", "name")
    .executeTakeFirst();
  if (existing) {
    if (!existing.active || !existing.required || existing.field_type !== "name") {
      await tx
        .updateTable("lead_form_field")
        .set({
          active: true,
          required: true,
          field_type: "name",
          label: existing.label?.trim() || "Имя",
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .execute();
    }
    return;
  }
  const nameMeta = LEAD_FIELDS.find((f) => f.id === "name")!;
  await tx
    .insertInto("lead_form_field")
    .values({
      id: randomUUID(),
      business_id: businessId,
      field_key: "name",
      label: nameMeta.label,
      field_type: "name",
      required: true,
      placeholder: nameMeta.example,
      options: JSON.stringify([]),
      position: 0,
      active: true,
      updated_at: new Date(),
    })
    .execute();
}

async function normalizeLeadFieldPositions(tx: Db, businessId: string) {
  const rows = await tx
    .selectFrom("lead_form_field")
    .select(["id", "field_key", "position", "created_at"])
    .where("business_id", "=", businessId)
    .where("active", "=", true)
    .orderBy("position")
    .orderBy("created_at")
    .execute();
  const name = rows.find((row) => row.field_key === "name");
  if (!name) return;
  const ordered = [name, ...rows.filter((row) => row.id !== name.id)];
  const now = new Date();
  for (const [position, row] of ordered.entries()) {
    if (row.position === position) continue;
    await tx
      .updateTable("lead_form_field")
      .set({ position, updated_at: now })
      .where("business_id", "=", businessId)
      .where("id", "=", row.id)
      .execute();
  }
}
