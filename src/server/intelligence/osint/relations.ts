import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { OsintRelationType } from "./schema.ts";
import { assertMentionEvidence, MentionEvidenceError } from "./mentions.ts";

/**
 * Relations между сущностями (§15).
 *
 * Ограничения схемы:
 *   - source_observation_id NOT NULL — relation без evidence не существует;
 *   - from <> to — самосвязи запрещены;
 *   - UNIQUE (from, to, type, observation) — одно доказательство не плодит
 *     дубликаты.
 *
 * Правило §6: MENTIONS никогда не становится OWNER — тип фиксируется так,
 * как его дал evidence.
 */

export class RelationEvidenceError extends Error {
  readonly code = "relation_requires_observation";
}

export type UpsertRelationInput = {
  fromEntityId: string;
  toEntityId: string;
  relationType: OsintRelationType;
  sourceObservationId: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
  validFrom?: Date;
  evidenceKind?: string;
};

export type UpsertRelationResult = {
  id: string;
  created: boolean;
  confidence: number;
};

export async function upsertRelation(
  db: Kysely<Database>,
  input: UpsertRelationInput,
): Promise<UpsertRelationResult> {
  if (!input.sourceObservationId)
    throw new RelationEvidenceError("relation requires source_observation_id");
  if (input.fromEntityId === input.toEntityId)
    throw new RelationEvidenceError("self relation is not allowed");

  assertMentionEvidence(input.relationType, input.evidenceKind ?? "observation");

  const existing = await db
    .selectFrom("osint_entity_relations")
    .select(["id", "confidence"])
    .where("from_entity_id", "=", input.fromEntityId)
    .where("to_entity_id", "=", input.toEntityId)
    .where("relation_type", "=", input.relationType)
    .where("source_observation_id", "=", input.sourceObservationId)
    .executeTakeFirst();

  const next = input.confidence ?? 0;

  if (existing) {
    const current = Number(existing.confidence);
    const confidence = Math.max(current, next);
    if (confidence !== current) {
      await db
        .updateTable("osint_entity_relations")
        .set({ confidence: String(confidence), updated_at: new Date() })
        .where("id", "=", existing.id)
        .execute();
    }
    return { id: existing.id, created: false, confidence };
  }

  const id = randomUUID();
  try {
    await db
      .insertInto("osint_entity_relations")
      .values({
        id,
        from_entity_id: input.fromEntityId,
        to_entity_id: input.toEntityId,
        relation_type: input.relationType,
        confidence: String(next),
        source_observation_id: input.sourceObservationId,
        evidence: input.evidence ?? {},
        valid_from: input.validFrom ?? new Date(),
        valid_to: null,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  } catch (error) {
    const raced = await db
      .selectFrom("osint_entity_relations")
      .select("id")
      .where("from_entity_id", "=", input.fromEntityId)
      .where("to_entity_id", "=", input.toEntityId)
      .where("relation_type", "=", input.relationType)
      .where("source_observation_id", "=", input.sourceObservationId)
      .executeTakeFirst();
    if (!raced) throw error;
    return { id: raced.id, created: false, confidence: next };
  }

  return { id, created: true, confidence: next };
}

/** Закрывает открытую связь (например, когда партнёрство подтверждено устаревшим). */
export async function closeRelation(
  db: Kysely<Database>,
  relationId: string,
  validTo: Date = new Date(),
): Promise<void> {
  await db
    .updateTable("osint_entity_relations")
    .set({ valid_to: validTo, updated_at: new Date() })
    .where("id", "=", relationId)
    .where("valid_to", "is", null)
    .execute();
}

export type RelationRow = {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation_type: OsintRelationType;
  confidence: string;
  source_observation_id: string;
  evidence: Record<string, unknown>;
  valid_from: Date;
  valid_to: Date | null;
};

/** Открытые связи сущности в обоих направлениях. */
export async function readRelations(
  db: Kysely<Database>,
  entityId: string,
  options: { asOf?: Date } = {},
): Promise<RelationRow[]> {
  const asOf = options.asOf ?? new Date();
  const rows = await db
    .selectFrom("osint_entity_relations")
    .select([
      "id",
      "from_entity_id",
      "to_entity_id",
      "relation_type",
      "confidence",
      "source_observation_id",
      "evidence",
      "valid_from",
      "valid_to",
    ])
    .where((eb) =>
      eb.or([eb("from_entity_id", "=", entityId), eb("to_entity_id", "=", entityId)]),
    )
    .where("valid_from", "<=", asOf)
    .where((eb) => eb.or([eb("valid_to", "is", null), eb("valid_to", ">", asOf)]))
    .orderBy("confidence", "desc")
    .execute();
  return rows as unknown as RelationRow[];
}

export { MentionEvidenceError };
