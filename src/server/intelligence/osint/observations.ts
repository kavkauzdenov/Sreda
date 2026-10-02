import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { OsintDiscoveryMethod, OsintObservationKind } from "./schema.ts";

/**
 * Observation writer — недостающее звено Stage 2 → Stage 3 (§23.3).
 *
 * Discovery-оркестратор уже доводит материал провайдера до
 * `osint_source_candidates` (тенант) → `osint_sources` (глобал) →
 * `osint_entity_sources` (связь), но сырую запись «что провайдер реально
 * вернул по этому URL» никуда не сохранял. Без неё Stage 3 нечего
 * объяснять: `Evidence.id` — это `osint_observations.id`.
 *
 * Здесь НИЧЕГО не выдумывается: content — ровно то, что пришло от провайдера
 * (title, snippet, сам URL), без профильных значений и без обращений к сети.
 *
 * Инварианты:
 *  - §7 (tenant isolation): вставка только если тенант держит мост
 *    `osint_business_entities` на эту сущность и источник уже привязан к ней
 *    через `osint_entity_sources`. Глобальная строка никогда не становится
 *    мостом «чужой» сущности.
 *  - §8 (idempotency): `content_hash` детерминирован от content,
 *    UNIQUE (source_id, content_hash) из 069 гасит повторную обработку.
 *  - §6 (provenance): `source_id` NOT NULL + `entity_id` — цепочка
 *    observation → source → entity → мост → бизнес читается без нового формата.
 */

/** Ровно тот материал, который провайдер вернул для одного URL. */
export type ObservedMaterial = {
  url: string;
  title: string | null;
  snippet: string | null;
  provider: string;
  method: OsintDiscoveryMethod;
  /**
   * Нормализованный текст страницы (crawl-фаза, §25). Без него content —
   * title+snippet+url ровно как в Stage 2; с ним — реальный материал
   * загруженного документа.
   */
  body?: string | null;
  /** Вид наблюдения; по умолчанию search_result (Stage 2), crawl → page. */
  kind?: OsintObservationKind;
  /** Провенанс загрузки (depth, http_status, fetched_at — без тенантских id). */
  metadata?: Record<string, unknown>;
};

export type ObservationSkipReason =
  | "tenant_bridge_missing"
  | "source_not_linked_to_entity";

export type EnsureObservationResult =
  | { id: string; created: boolean; skipped: null }
  | { id: null; created: false; skipped: ObservationSkipReason };

export type EnsureObservationInput = {
  /** Тенант, для которого идёт discovery — граница изоляции (§7). */
  businessId: string;
  entityId: string;
  sourceId: string;
  observed: ObservedMaterial;
  /** Момент наблюдения; по умолчанию — текущее время запуска. */
  observedAt?: Date;
  kind?: OsintObservationKind;
};

/**
 * Content наблюдения: title, snippet/body и сам URL, разделённые переводом
 * строки.
 *
 * URL входит в content осознанно: `scoreCandidate` Stage 2 уже считает
 * «наблюдаемым материалом» ровно title + snippet + url, поэтому здесь та же
 * семантика. Это даёт Stage 3 трассируемый `website`-Claim, чей `textSpan`
 * безошибочно лежит внутри `Evidence.content`. Crawl добавляет body — тогда
 * content отражает саму страницу, а не только её выдачу в поиске.
 */
export function observationContent(observed: ObservedMaterial): string {
  const excerpt = observed.snippet?.trim() ? observed.snippet : observed.body;
  return [observed.title, excerpt, observed.url]
    .map((part) => (part ?? "").trim())
    .filter((part) => part.length > 0)
    .join("\n");
}

/** Детерминированный hash content — ключ идемпотентности (§8). */
export function observationContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Находит или создаёт наблюдение для уже созданного источника.
 *
 * Вызывается ТОЛЬКО из discovery после `ensureSource` + `attachCandidateSource`,
 * то есть когда entity уже привязана к источнику. Наблюдение без источника
 * схема и не позволяет (`source_id NOT NULL`, 069).
 */
export async function ensureObservation(
  db: Kysely<Database>,
  input: EnsureObservationInput,
): Promise<EnsureObservationResult> {
  // §7: глобальная таблица, поэтому тенант-скоуп проверяем явно — иначе
  // запись tenant A могла бы указать на entity/source tenant B.
  const bridge = await db
    .selectFrom("osint_business_entities")
    .select("entity_id")
    .where("business_id", "=", input.businessId)
    .where("entity_id", "=", input.entityId)
    .where("status", "!=", "rejected")
    .executeTakeFirst();
  if (!bridge)
    return { id: null, created: false, skipped: "tenant_bridge_missing" };

  const link = await db
    .selectFrom("osint_entity_sources")
    .select("source_id")
    .where("entity_id", "=", input.entityId)
    .where("source_id", "=", input.sourceId)
    .executeTakeFirst();
  if (!link)
    return { id: null, created: false, skipped: "source_not_linked_to_entity" };

  const content = observationContent(input.observed);
  const contentHash = observationContentHash(content);
  const id = randomUUID();

  const inserted = await db
    .insertInto("osint_observations")
    .values({
      id,
      source_id: input.sourceId,
      entity_id: input.entityId,
      external_id: null,
      url: input.observed.url,
      title: input.observed.title,
      content,
      author_name: null,
      published_at: null,
      observed_at: input.observedAt ?? new Date(),
      content_hash: contentHash,
      language: null,
      kind: input.kind ?? input.observed.kind ?? "search_result",
      rating: null,
      rating_max: null,
      latitude: null,
      longitude: null,
      // Только глобальная лексика: provider/method уже живут в
      // osint_sources.provider, а run/query/position/business остаются в
      // тенантском osint_source_candidates (правило 070 — не светить
      // discovery_run_id в публичный слой).
      metadata: {
        ...(input.observed.metadata ?? {}),
        provider: input.observed.provider,
        discovery_method: input.observed.method,
      },
      created_at: new Date(),
    })
    .onConflict((oc) => oc.columns(["source_id", "content_hash"]).doNothing())
    .executeTakeFirst();

  if (!inserted || inserted.numInsertedOrUpdatedRows === BigInt(0)) {
    // Гонка двух run'ов с одинаковым материалом: строка уже есть, берём её.
    const raced = await db
      .selectFrom("osint_observations")
      .select("id")
      .where("source_id", "=", input.sourceId)
      .where("content_hash", "=", contentHash)
      .executeTakeFirst();
    if (!raced)
      throw new Error(
        `observation insert conflicted for source ${input.sourceId} but no row exists`,
      );
    return { id: raced.id, created: false, skipped: null };
  }

  return { id, created: true, skipped: null };
}
