import { createHash } from "node:crypto";
import type {
  Claim,
  ClaimKind,
  EvidenceSourceRef,
} from "@/lib/intelligence-contracts.ts";
import { EXTRACTABLE_ATTRIBUTES } from "./extraction/contract.ts";
import { extractDeterministic } from "./extraction/deterministic.ts";

/**
 * Детерминированная экстракция Claims (Stage 3 v1, §5).
 *
 * Никакого LLM: наблюдение пропускается через уже существующий
 * `extractDeterministic` Stage 2 и превращается в `Claim` с обязательной
 * Evidence-базой. Словарь предикатов — ровно `EXTRACTABLE_ATTRIBUTES`
 * (закрытый словарь Stage 1/2), ничего нового не изобретается.
 *
 * Два правила, без которых Claim не считается валидным (§6):
 *  - извлечение идёт ТОЛЬКО из текста самого наблюдения, поэтому `textSpan`
 *    всегда лежит в `Evidence.content` и трассировка честна;
 *  - id заявки детерминирован от содержимого — повторная проекция того же
 *    наблюдения даёт ровно те же Claims без дублей (§8).
 */

const CONTACT_PREDICATES = new Set([
  "phone",
  "email",
  "website",
  "social_links",
]);
const IDENTITY_PREDICATES = new Set(["name"]);

/** Остальные предикаты словаря (`address`, `city`, `category`, …) — состояние. */
export function claimKindFor(predicate: string): ClaimKind {
  if (IDENTITY_PREDICATES.has(predicate)) return "identity";
  if (CONTACT_PREDICATES.has(predicate)) return "contact";
  return "state";
}

type SerializedValue = { value: string | null; valueKind: string | null };

function serializeValue(raw: unknown): SerializedValue {
  if (raw === null || raw === undefined) return { value: null, valueKind: null };
  if (typeof raw === "string") return { value: raw, valueKind: "string" };
  if (typeof raw === "number") return { value: String(raw), valueKind: "number" };
  if (typeof raw === "boolean")
    return { value: String(raw), valueKind: "boolean" };
  try {
    return { value: JSON.stringify(raw), valueKind: "json" };
  } catch {
    return { value: null, valueKind: null };
  }
}

/**
 * Стабильный UUID заявки: SHA-256 от (business, subject, predicate,
 * observation, value) с выставленными version/variant битами. Один и тот же
 * вход всегда даёт один и тот же id — дубликаты невозможны.
 */
export function stableClaimId(input: {
  businessId: string;
  subject: string;
  predicate: string;
  observationId: string;
  value: string | null;
}): string {
  const digest = createHash("sha256")
    .update(
      [
        input.businessId,
        input.subject,
        input.predicate,
        input.observationId,
        input.value ?? "",
      ].join("\u0000"),
    )
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

export type ExtractClaimsInput = {
  businessId: string;
  observationId: string;
  /** Предмет утверждения — имя сущности либо её домен (§5). */
  subject: string;
  /** Дословный текст наблюдения — единственный источник извлечения. */
  content: string;
  /** ISO-время наблюдения: валидность и createdAt проекции. */
  observedAt: string;
};

export function extractClaims(input: ExtractClaimsInput): Claim[] {
  const extraction = extractDeterministic({ text: input.content ?? "" });
  const vocabulary = EXTRACTABLE_ATTRIBUTES as readonly string[];

  const claims: Claim[] = [];
  const seen = new Set<string>();

  for (const attribute of extraction.attributes) {
    if (!vocabulary.includes(attribute.attribute)) continue;

    const { value, valueKind } = serializeValue(attribute.value);
    if (value === null) continue;

    const id = stableClaimId({
      businessId: input.businessId,
      subject: input.subject,
      predicate: attribute.attribute,
      observationId: input.observationId,
      value,
    });
    if (seen.has(id)) continue;
    seen.add(id);

    const evidenceRef: EvidenceSourceRef = {
      observationId: input.observationId,
      textSpan: attribute.evidenceText.slice(0, 500) || null,
      evidenceKind: "text_span",
      confidence: attribute.confidence,
    };

    claims.push({
      id,
      businessId: input.businessId,
      kind: claimKindFor(attribute.attribute),
      subject: input.subject,
      predicate: attribute.attribute,
      value,
      valueKind,
      evidence: [evidenceRef],
      confidence: attribute.confidence,
      validFrom: input.observedAt,
      validTo: null,
      // Проекция не персистентна, отдельного события создания нет —
      // наследуем время наблюдения, чтобы повторный запуск был байт-в-байт
      // идентичным (§8).
      createdAt: input.observedAt,
    });
  }

  claims.sort((a, b) =>
    a.predicate === b.predicate
      ? (a.value ?? "").localeCompare(b.value ?? "")
      : a.predicate.localeCompare(b.predicate),
  );
  return claims;
}
