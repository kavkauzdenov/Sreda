import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { OsintRelationType } from "./schema.ts";

/**
 * Mentions из наблюдений (§8, §9).
 *
 * Правило OWNERSHIP VS MENTION: MENTIONS никогда не интерпретируется как
 * OWNER/PUBLISHED_BY. Обратное тоже верно — OWNER/PUBLISHED_BY требуют
 * явного evidence (sameAs, rel=author, прямое заявление).
 *
 * Каждый mention обязан нести text_span — это и есть доказательство,
 * почему система решила, что здесь речь про эту сущность (§9).
 */

/** Evidence-виды, достаточные для OWNER/PUBLISHED_BY. */
export const EXPLICIT_OWNERSHIP_EVIDENCE = ["sameAs", "rel_author", "explicit_claim"] as const;

export type ExplicitOwnershipEvidence = (typeof EXPLICIT_OWNERSHIP_EVIDENCE)[number];

export class MentionEvidenceError extends Error {
  readonly code = "mention_requires_explicit_evidence";
}

const OWNERSHIP_TYPES: readonly OsintRelationType[] = ["OWNER", "PUBLISHED_BY"];

/** Проверяет, что тип mention не выходит за рамки имеющегося evidence. */
export function assertMentionEvidence(
  mentionType: OsintRelationType,
  evidenceKind: string,
): void {
  if (!OWNERSHIP_TYPES.includes(mentionType)) return;
  if ((EXPLICIT_OWNERSHIP_EVIDENCE as readonly string[]).includes(evidenceKind)) return;
  throw new MentionEvidenceError(
    `${mentionType} requires explicit evidence, got "${evidenceKind}" — MENTIONS is not ownership`,
  );
}

export type RecordMentionInput = {
  observationId: string;
  entityId: string;
  mentionType?: OsintRelationType;
  /** Фрагмент текста-доказательство, ≤500 символов. */
  textSpan?: string;
  context?: string;
  confidence?: number;
  evidenceKind?: string;
};

export type RecordMentionResult = {
  id: string;
  created: boolean;
};

export async function recordMention(
  db: Kysely<Database>,
  input: RecordMentionInput,
): Promise<RecordMentionResult> {
  const mentionType = input.mentionType ?? "MENTIONS";
  const evidenceKind = input.evidenceKind ?? "text_span";
  assertMentionEvidence(mentionType, evidenceKind);

  const textSpan = (input.textSpan ?? "").slice(0, 500);

  const existing = await db
    .selectFrom("osint_entity_mentions")
    .select("id")
    .where("observation_id", "=", input.observationId)
    .where("entity_id", "=", input.entityId)
    .where("mention_type", "=", mentionType)
    .where("text_span", "=", textSpan)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };

  const id = randomUUID();
  try {
    await db
      .insertInto("osint_entity_mentions")
      .values({
        id,
        observation_id: input.observationId,
        entity_id: input.entityId,
        mention_type: mentionType,
        text_span: textSpan,
        context: (input.context ?? "").slice(0, 4000),
        confidence: String(input.confidence ?? 0),
        created_at: new Date(),
      })
      .execute();
  } catch (error) {
    const raced = await db
      .selectFrom("osint_entity_mentions")
      .select("id")
      .where("observation_id", "=", input.observationId)
      .where("entity_id", "=", input.entityId)
      .where("mention_type", "=", mentionType)
      .where("text_span", "=", textSpan)
      .executeTakeFirst();
    if (!raced) throw error;
    return { id: raced.id, created: false };
  }

  return { id, created: true };
}

export type MentionRow = {
  id: string;
  observation_id: string;
  mention_type: OsintRelationType;
  text_span: string;
  context: string;
  confidence: string;
  created_at: Date;
};

/** Все mention'ы сущности — глобальный evidence, общий для всех тенантов. */
export async function readMentions(
  db: Kysely<Database>,
  entityId: string,
): Promise<MentionRow[]> {
  const rows = await db
    .selectFrom("osint_entity_mentions")
    .select([
      "id",
      "observation_id",
      "mention_type",
      "text_span",
      "context",
      "confidence",
      "created_at",
    ])
    .where("entity_id", "=", entityId)
    .orderBy("created_at", "desc")
    .execute();
  return rows as unknown as MentionRow[];
}
