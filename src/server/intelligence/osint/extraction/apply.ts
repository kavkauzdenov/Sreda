import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import { normalizeText, tokenize } from "../text.ts";
import { setAttribute } from "../attributes.ts";
import {
  recordMention,
  assertMentionEvidence,
  MentionEvidenceError,
} from "../mentions.ts";
import type { OsintAttributeKind } from "../schema.ts";
import type { ExtractionResult } from "./contract.ts";

/**
 * Применение extraction к графу (§9, §11, §18).
 *
 * Правила (§12): имя никогда не является достаточным основанием, чтобы
 * считать два упоминания одним объектом. Поэтому здесь:
 *   - атрибуты применяются к уже известной целевой сущности (§18);
 *   - mention с совпадающим именем цепляется к ней (§9);
 *   - любое другое имя уходит в `unresolved` и разрешается только
 *     накоплением evidence на этапе entity resolution (§12-§14).
 *
 * Ни одного INSERT в osint_entities по одному имени здесь нет.
 */

export type ApplyExtractionInput = {
  businessId: string;
  observationId: string;
  /** Сущность, которой принадлежит наблюдение. */
  targetEntityId: string;
  extraction: ExtractionResult;
  /** Атрибуты целевой сущности (обычно из deterministic extraction). */
  targetAttributes?: ExtractionResult["attributes"];
};

export type ApplyExtractionResult = {
  mentionsCreated: number;
  attributesSet: number;
  /** Упоминания, которые нельзя привязать без entity resolution. */
  unresolved: number;
  skipped: string[];
};

export async function applyExtraction(
  db: Kysely<Database>,
  input: ApplyExtractionInput,
): Promise<ApplyExtractionResult> {
  const result: ApplyExtractionResult = {
    mentionsCreated: 0,
    attributesSet: 0,
    unresolved: 0,
    skipped: [],
  };

  const target = await db
    .selectFrom("osint_entities")
    .select(["id", "normalized_name"])
    .where("id", "=", input.targetEntityId)
    .executeTakeFirst();
  if (!target) {
    result.skipped.push("target_entity_missing");
    return result;
  }

  // 1. Temporal-атрибуты целевой сущности (§18).
  for (const attribute of input.targetAttributes ?? []) {
    try {
      await setAttribute(db, {
        entityId: input.targetEntityId,
        attribute: attribute.attribute as OsintAttributeKind,
        value: attribute.value,
        confidence: attribute.confidence,
        sourceObservationId: input.observationId,
      });
      result.attributesSet += 1;
    } catch (error) {
      result.skipped.push(
        `attribute_${attribute.attribute}: ${(error as Error).message}`,
      );
    }
  }

  // 2. Mention'ы (§9): evidence обязателен, ownership — только явный (§6).
  for (const entity of input.extraction.entities) {
    try {
      assertMentionEvidence(entity.mentionType, entity.evidenceKind);
    } catch (error) {
      if (error instanceof MentionEvidenceError) {
        result.skipped.push(`mention_guard: ${error.message}`);
        continue;
      }
      throw error;
    }

    const normalized =
      normalizeText(entity.name) || tokenize(entity.name).join(" ");
    if (normalized !== target.normalized_name) {
      result.unresolved += 1;
      continue;
    }

    const mention = await recordMention(db, {
      observationId: input.observationId,
      entityId: input.targetEntityId,
      mentionType: entity.mentionType,
      textSpan: entity.evidenceText,
      context: entity.name,
      confidence: entity.confidence,
      evidenceKind: entity.evidenceKind,
    });
    if (mention.created) result.mentionsCreated += 1;
  }

  return result;
}
