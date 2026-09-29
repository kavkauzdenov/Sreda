import { z } from "zod";
import type { OsintRelationType } from "../schema.ts";

/**
 * Контракт AI-экстракции (§11).
 *
 * Структурный ответ модели НИКОГДА не принимается «как есть»: он проходит
 * zod-валидацию. Модель не источник истины — она только извлекает кандидатов
 * из уже собранного текста; итоговые решения принимает deterministic-слой
 * и entity resolution.
 */

const RELATION_TYPES = [
  "OWNER",
  "PUBLISHED_BY",
  "MENTIONS",
  "ABOUT",
  "PARTNER",
  "CLIENT",
  "COMPETITOR",
  "LOCATION",
  "EMPLOYER",
  "SPONSOR",
  "SUPPLIER",
  "CUSTOMER",
  "RELATED_TO",
] as const;

export const EXTRACTABLE_ATTRIBUTES = [
  "name",
  "phone",
  "website",
  "address",
  "email",
  "city",
  "region",
  "country",
  "category",
  "description",
  "social_links",
  "coordinates",
  "working_hours",
] as const;

/** Evidence-виды, достаточные для OWNER/PUBLISHED_BY (§6). */
const OWNERSHIP_EVIDENCE = ["sameAs", "rel_author", "explicit_claim"] as const;

export const ExtractedEntitySchema = z
  .object({
    name: z.string().min(1).max(300),
    kind: z.enum(["business", "location", "organization"]).default("business"),
    mentionType: z.enum(RELATION_TYPES).default("MENTIONS"),
    evidenceKind: z
      .enum(["text_span", ...OWNERSHIP_EVIDENCE])
      .default("text_span"),
    /** Фрагмент текста, на котором основана гипотеза (§9). */
    evidenceText: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1),
  })
  .refine(
    (value) =>
      (value.mentionType !== "OWNER" && value.mentionType !== "PUBLISHED_BY") ||
      (OWNERSHIP_EVIDENCE as readonly string[]).includes(value.evidenceKind),
    {
      message:
        "OWNER/PUBLISHED_BY требует explicit evidence (sameAs, rel_author, explicit_claim)",
      path: ["mentionType"],
    },
  );

export const ExtractedAttributeSchema = z.object({
  attribute: z.enum(EXTRACTABLE_ATTRIBUTES),
  value: z.union([z.string().max(2000), z.number(), z.array(z.unknown()), z.record(z.string(), z.unknown())]),
  evidenceText: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export const ExtractionResultSchema = z.object({
  entities: z.array(ExtractedEntitySchema).max(50).default([]),
  attributes: z.array(ExtractedAttributeSchema).max(100).default([]),
});

export type ExtractedEntity = z.infer<typeof ExtractedEntitySchema>;
export type ExtractedAttribute = z.infer<typeof ExtractedAttributeSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export type ParseExtractionResult =
  | { ok: true; data: ExtractionResult }
  | { ok: false; issues: string[] };

/** Единственная точка приёма AI-ответа. Плохая схема → rejected, не crash. */
export function parseExtraction(input: unknown): ParseExtractionResult {
  const parsed = ExtractionResultSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
}

/** Гарантированно валидный пустой результат — для заглушек и fallback. */
export function emptyExtraction(): ExtractionResult {
  return { entities: [], attributes: [] };
}

export type { OsintRelationType };
