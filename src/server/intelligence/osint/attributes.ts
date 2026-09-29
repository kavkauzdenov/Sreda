import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { OsintAttributeKind } from "./schema.ts";

/**
 * Temporal model атрибутов сущности (§18).
 *
 * Инвариант схемы: partial UNIQUE (entity_id, attribute) WHERE valid_to IS NULL
 * — ровно одно открытое значение на атрибут. Новое значение не перезаписывает
 * старое, а закрывает его: «телефон A действовал до 15.08, с 16.08 — B».
 */

export type SetAttributeInput = {
  entityId: string;
  attribute: OsintAttributeKind;
  value: unknown;
  confidence?: number;
  sourceObservationId?: string | null;
  validFrom?: Date;
};

export type SetAttributeResult = {
  id: string;
  changed: boolean;
  closedPreviousId: string | null;
};

const sameValue = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Драйвер отдаёт примитивы в jsonb как есть, поэтому строка "73852551010"
 * уехала бы в базу числом и сломала сравнение. Строки кодируем явно —
 * объекты и массивы сериализует сам драйвер.
 */
function encodeJsonb(value: unknown): unknown {
  return typeof value === "string" ? JSON.stringify(value) : value;
}

export async function setAttribute(
  db: Kysely<Database>,
  input: SetAttributeInput,
): Promise<SetAttributeResult> {
  const validFrom = input.validFrom ?? new Date();
  const confidence = input.confidence ?? 1;

  const open = await db
    .selectFrom("osint_entity_attributes")
    .select(["id", "value", "confidence", "source_observation_id"])
    .where("entity_id", "=", input.entityId)
    .where("attribute", "=", input.attribute)
    .where("valid_to", "is", null)
    .executeTakeFirst();

  if (open) {
    if (sameValue(open.value, input.value)) {
      const current = Number(open.confidence);
      if (confidence > current) {
        await db
          .updateTable("osint_entity_attributes")
          .set({ confidence: String(confidence), updated_at: new Date() })
          .where("id", "=", open.id)
          .execute();
      }
      return { id: open.id, changed: false, closedPreviousId: null };
    }

    await db
      .updateTable("osint_entity_attributes")
      .set({ valid_to: validFrom, updated_at: new Date() })
      .where("id", "=", open.id)
      .execute();

    const id = randomUUID();
    await insertAttribute(db, { ...input, id, validFrom, confidence });
    return { id, changed: true, closedPreviousId: open.id };
  }

  const id = randomUUID();
  await insertAttribute(db, { ...input, id, validFrom, confidence });
  return { id, changed: true, closedPreviousId: null };
}

async function insertAttribute(
  db: Kysely<Database>,
  input: SetAttributeInput & { id: string; validFrom: Date; confidence: number },
): Promise<void> {
  await db
    .insertInto("osint_entity_attributes")
    .values({
      id: input.id,
      entity_id: input.entityId,
      attribute: input.attribute,
      value: encodeJsonb(input.value),
      confidence: String(input.confidence),
      source_observation_id: input.sourceObservationId ?? null,
      valid_from: input.validFrom,
      valid_to: null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
}

export type AttributeRow = {
  id: string;
  entity_id: string;
  attribute: OsintAttributeKind;
  value: unknown;
  confidence: string;
  source_observation_id: string | null;
  valid_from: Date;
  valid_to: Date | null;
};

/**
 * Значения атрибутов на дату `asOf`. Без asOf — только открытые.
 * Тестовый сценарий §18: «телефон на июнь 2026» вернёт старый номер,
 * хотя сейчас в графе уже новый.
 */
export async function readAttributes(
  db: Kysely<Database>,
  entityId: string,
  options: { asOf?: Date } = {},
): Promise<AttributeRow[]> {
  let query = db
    .selectFrom("osint_entity_attributes")
    .selectAll()
    .where("entity_id", "=", entityId);

  if (options.asOf) {
    const asOf = options.asOf;
    query = query
      .where("valid_from", "<=", asOf)
      .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]));
  } else {
    query = query.where("valid_to", "is", null);
  }

  const rows = await query.execute();
  return rows as unknown as AttributeRow[];
}

/** История изменений одного атрибута, новые первыми. */
export async function readAttributeHistory(
  db: Kysely<Database>,
  entityId: string,
  attribute: OsintAttributeKind,
): Promise<AttributeRow[]> {
  const rows = await db
    .selectFrom("osint_entity_attributes")
    .selectAll()
    .where("entity_id", "=", entityId)
    .where("attribute", "=", attribute)
    .orderBy("valid_from", "desc")
    .execute();
  return rows as unknown as AttributeRow[];
}
