import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { OsintSourceHistoryKind } from "./schema.ts";

/**
 * Structured source memory (§1).
 *
 * Правила:
 *   1. Плоские колонки для скалярных полей (canonical_name, description,
 *      category, language, location) — JSON-модель в одну колонку запрещён.
 *      jsonb только для действительно списочных/свободных полей.
 *   2. Новый сбор НИКОГДА не затирает старый молча: изменённые поля
 *      фиксируются в osint_source_history (§19) со снапшотом.
 *   3. Вся таблица глобальна — ни business_id, ни discovery_run_id.
 */

export type SourceContextPatch = {
  canonical_name?: string;
  description?: string;
  category?: string | null;
  language?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  address?: string | null;
  contacts?: unknown[];
  domains?: unknown[];
  social_links?: Record<string, unknown>;
  known_owner_entity_id?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpsertSourceContextInput = {
  sourceId: string;
  patch: SourceContextPatch;
  changeKind?: OsintSourceHistoryKind;
  observedAt?: Date;
};

const CONTEXT_FIELDS = [
  "canonical_name",
  "description",
  "category",
  "language",
  "city",
  "region",
  "country",
  "address",
  "contacts",
  "domains",
  "social_links",
  "known_owner_entity_id",
  "metadata",
] as const;

type ContextField = (typeof CONTEXT_FIELDS)[number];

const serialize = (value: unknown): string => JSON.stringify(value ?? null);

/** Приводит nullable-поля к форме, сравнимой между select и patch. */
function normalizeExisting(field: ContextField, raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (
    field === "contacts" ||
    field === "domains" ||
    field === "social_links" ||
    field === "metadata"
  ) {
    return typeof raw === "string" ? raw : JSON.stringify(raw);
  }
  return raw;
}

function normalizePatch(field: ContextField, value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (
    field === "contacts" ||
    field === "domains" ||
    field === "social_links" ||
    field === "metadata"
  ) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Создаёт или обновляет контекст источника. Возвращает имена реально
 * изменившихся полей — их же пишем в историю.
 */
export async function upsertSourceContext(
  db: Kysely<Database>,
  input: UpsertSourceContextInput,
): Promise<{ changedFields: string[]; created: boolean }> {
  const now = new Date();
  const observedAt = input.observedAt ?? now;

  const existing = await db
    .selectFrom("osint_source_context")
    .selectAll()
    .where("source_id", "=", input.sourceId)
    .executeTakeFirst();

  if (!existing) {
    const values: Record<string, unknown> = {
      source_id: input.sourceId,
      canonical_name: input.patch.canonical_name ?? "",
      description: input.patch.description ?? "",
      category: input.patch.category ?? null,
      language: input.patch.language ?? null,
      city: input.patch.city ?? null,
      region: input.patch.region ?? null,
      country: input.patch.country ?? null,
      address: input.patch.address ?? null,
      contacts: input.patch.contacts ?? [],
      domains: input.patch.domains ?? [],
      social_links: input.patch.social_links ?? {},
      known_owner_entity_id: input.patch.known_owner_entity_id ?? null,
      metadata: input.patch.metadata ?? {},
      first_observed_at: observedAt,
      last_observed_at: observedAt,
      created_at: now,
      updated_at: now,
    };
    await db
      .insertInto("osint_source_context")
      .values(values as never)
      .execute();

    await writeSourceHistory(db, {
      sourceId: input.sourceId,
      changeKind: input.changeKind ?? "create",
      changedFields: CONTEXT_FIELDS.filter(
        (field) => input.patch[field] !== undefined,
      ),
      snapshot: values as Record<string, unknown>,
      observedAt,
      validFrom: observedAt,
    });

    return {
      changedFields: CONTEXT_FIELDS.filter(
        (field) => input.patch[field] !== undefined,
      ),
      created: true,
    };
  }

  const changedFields: string[] = [];
  const updates: Record<string, unknown> = { updated_at: now };
  const snapshot: Record<string, unknown> = {};

  for (const field of CONTEXT_FIELDS) {
    const next = normalizePatch(field, input.patch[field]);
    if (next === undefined) continue;
    const prev = normalizeExisting(field, existing[field]);
    if (serialize(next) === serialize(prev)) continue;
    changedFields.push(field);
    updates[field] = next === null ? null : (input.patch[field] as never);
    snapshot[field] = { from: prev, to: next };
  }

  if (!changedFields.length) {
    await db
      .updateTable("osint_source_context")
      .set({ last_observed_at: observedAt, updated_at: now })
      .where("source_id", "=", input.sourceId)
      .execute();
    return { changedFields: [], created: false };
  }

  // Перезапись без потери истории: старое значение уезжает в source_history.
  await closeOpenSourceHistory(db, input.sourceId, observedAt);

  await db
    .updateTable("osint_source_context")
    .set(updates as never)
    .where("source_id", "=", input.sourceId)
    .execute();

  await db
    .updateTable("osint_source_context")
    .set({ last_observed_at: observedAt })
    .where("source_id", "=", input.sourceId)
    .execute();

  await writeSourceHistory(db, {
    sourceId: input.sourceId,
    changeKind: input.changeKind ?? "update",
    changedFields,
    snapshot,
    observedAt,
    validFrom: observedAt,
  });

  return { changedFields, created: false };
}

/** Закрывает открытый интервал истории источника на момент наблюдения. */
async function closeOpenSourceHistory(
  db: Kysely<Database>,
  sourceId: string,
  observedAt: Date,
): Promise<void> {
  await db
    .updateTable("osint_source_history")
    .set({ valid_to: observedAt })
    .where("source_id", "=", sourceId)
    .where("valid_to", "is", null)
    .execute();
}

async function writeSourceHistory(
  db: Kysely<Database>,
  input: {
    sourceId: string;
    changeKind: OsintSourceHistoryKind;
    changedFields: string[];
    snapshot: Record<string, unknown>;
    observedAt: Date;
    validFrom: Date;
  },
): Promise<void> {
  await db
    .insertInto("osint_source_history")
    .values({
      id: randomUUID(),
      source_id: input.sourceId,
      change_kind: input.changeKind,
      changed_fields: input.changedFields,
      snapshot: input.snapshot,
      valid_from: input.validFrom,
      valid_to: null,
      observed_at: input.observedAt,
      created_at: new Date(),
    })
    .execute();
}

export type SourceHistoryRow = {
  change_kind: OsintSourceHistoryKind;
  changed_fields: unknown[];
  snapshot: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
};

/** История контекста источника, новые записи первыми. */
export async function readSourceHistory(
  db: Kysely<Database>,
  sourceId: string,
): Promise<SourceHistoryRow[]> {
  const rows = await db
    .selectFrom("osint_source_history")
    .select([
      "change_kind",
      "changed_fields",
      "snapshot",
      "valid_from",
      "valid_to",
    ])
    .where("source_id", "=", sourceId)
    .orderBy("valid_from", "desc")
    .execute();
  return rows as unknown as SourceHistoryRow[];
}
