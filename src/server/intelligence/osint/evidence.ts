import type { Evidence } from "@/lib/intelligence-contracts.ts";
import { AppError } from "../../http/errors.ts";

/**
 * Evidence adapter (Stage 3 v1).
 *
 * Читаемая проекция существующего `osint_observations` на контракт `Evidence`
 * из `src/lib/intelligence-contracts.ts`. Ничего не хранится и не копируется:
 * `Evidence.id` — это `osint_observations.id`, `Evidence.sourceId` — это
 * `osint_observations.source_id` (NOT NULL, 069). Контракт запрещает
 * держать `osint_sources.id` внутри `EvidenceSourceRef` — он всегда
 * выводится отсюда, из наблюдения.
 */

export type ObservationRow = {
  id: string;
  source_id: string;
  entity_id: string | null;
  content: string;
  content_hash: string;
  observed_at: Date | string;
  created_at: Date | string;
  kind: string;
};

/**
 * Виды наблюдения, для которых детерминированная экстракция работает по тексту.
 * Подмножество CHECK 069 (`page|review|search_result|post|listing`): любой
 * будущий вид схемы, не перечисленный здесь, обрабатывается контролируемо,
 * а не «тихо» пустым результатом.
 */
export const CLAIM_SUPPORTED_OBSERVATION_KINDS = [
  "page",
  "review",
  "post",
  "listing",
  "search_result",
] as const;

export type ClaimSupportedObservationKind =
  (typeof CLAIM_SUPPORTED_OBSERVATION_KINDS)[number];

export function isClaimSupportedObservationKind(
  kind: string,
): kind is ClaimSupportedObservationKind {
  return (CLAIM_SUPPORTED_OBSERVATION_KINDS as readonly string[]).includes(
    kind,
  );
}

/**
 * Контролируемый отказ для вида наблюдения, который Stage 3 v1 не умеет
 * читать. Не `TypeError` и не 503 — отдельный `AppError` (§12).
 */
export function assertClaimSupportedKind(kind: string): void {
  if (isClaimSupportedObservationKind(kind)) return;
  throw new AppError(
    422,
    "UNSUPPORTED_OBSERVATION_KIND",
    `Вид наблюдения "${kind}" не поддерживается Stage 3.`,
  );
}

function toIso(value: Date | string): string | null {
  const parsed = new Date(value);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return null;
  return parsed.toISOString();
}

/**
 * Нормализует наблюдение в `Evidence`. Если провенанс собрать нельзя
 * (битые даты/хэш), наблюдение не даёт права на Claim (§6) — падаем
 * контролируемым `AppError`, а не внутренней ошибкой 503.
 */
export function toEvidence(row: ObservationRow): Evidence {
  const observedAt = toIso(row.observed_at);
  const contentHash = (row.content_hash ?? "").trim();
  if (!observedAt || contentHash.length === 0) {
    throw new AppError(
      422,
      "MALFORMED_OBSERVATION",
      "Наблюдение повреждено: не удалось собрать провенанс.",
    );
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    content: row.content ?? "",
    contentHash,
    observedAt,
    entityId: row.entity_id,
  };
}
