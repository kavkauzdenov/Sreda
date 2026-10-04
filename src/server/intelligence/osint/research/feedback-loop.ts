/**
 * Замыкание цикла: исполненное действие → знание → новые гипотезы → следующее
 * действие (§7, §8, §21).
 *
 * Это то, что отличает агента от списка запросов. После исполнения действия
 * система смотрит, ЧТО именно сохранилось, и решает, что проверять дальше.
 * Без этого шага агент выдаёт первую волну и останавливается.
 *
 * Порядок важен: факты сначала должны существовать в БД, и только потом
 * становиться основанием следующей гипотезы. Гипотеза, ссылающаяся на
 * несуществующий факт, была бы предположением, выдаваемым за знание.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import {
  hypothesesFromFact,
  hypothesesFromEntity,
  type ObservedFact,
} from "./feedback.ts";
import {
  hypothesisFromContradiction,
  parseSides,
  type ContradictionSide,
} from "./contradiction-feedback.ts";
import { persistActions, persistHypotheses } from "./plan-store.ts";
import type { Hypothesis } from "./hypothesis.ts";
import { queriesForHypothesis } from "./query-generator.ts";
import type { BusinessIdentity } from "./identity.ts";

/** Итог одного цикла обратной связи. */
export type FeedbackResult = {
  /** Гипотез, порождённых фактами. */
  hypothesesFromFacts: number;
  /** Гипотез, порождённых противоречиями. */
  hypothesesFromContradictions: number;
  /** Гипотез, порождённых новыми сущностями. */
  hypothesesFromEntities: number;
  /** Гипотез реально записано в БД (уникальных). */
  hypothesesStored: number;
  /** Действий поставлено в очередь. */
  actionsQueued: number;
  /** Направления, где теперь есть подтверждённые факты. */
  confirmedAreas: string[];
};

/**
 * Читает факты, найденные после последней обработки.
 *
 * Отсекаем по времени последнего прохода, чтобы не перечитывать всю историю
 * на каждом тике. Время берём из max(last_seen_at) — оно двигается вместе с
 * фактом, а не с его повторным извлечением из того же источника.
 */
export async function collectNewFacts(
  db: Kysely<Database>,
  businessId: string,
  since: Date | null,
): Promise<ObservedFact[]> {
  const query = db
    .selectFrom("osint_intelligence_facts")
    .innerJoin("osint_sources", "osint_sources.id", "osint_intelligence_facts.source_id")
    .select([
      "osint_intelligence_facts.id",
      "osint_intelligence_facts.fact_type",
      "osint_intelligence_facts.fact_key",
      "osint_intelligence_facts.value",
      "osint_intelligence_facts.source_id",
      "osint_intelligence_facts.observation_id",
      "osint_intelligence_facts.last_seen_at",
      "osint_sources.trust_level as source_trust",
    ])
    .where("osint_intelligence_facts.business_id", "=", businessId)
    .orderBy("osint_intelligence_facts.last_seen_at", "desc")
    .limit(50);

  const rows = since
    ? await query.where("osint_intelligence_facts.last_seen_at", ">", since).execute()
    : await query.execute();

  return rows.map((row) => ({
    id: row.id,
    factType: String(row.fact_type),
    factKey: String(row.fact_key),
    value: String(row.value),
    sourceId: row.source_id,
    observationId: row.observation_id,
    sourceTrust: row.source_trust,
    observedAt: row.last_seen_at.toISOString(),
  }));
}

/** Момент последней обработки фактов — хранится в agent_stats. */
export async function lastFeedbackAt(
  db: Kysely<Database>,
  runId: string,
): Promise<Date | null> {
  const row = await db
    .selectFrom("osint_discovery_runs")
    .select("agent_stats")
    .where("id", "=", runId)
    .executeTakeFirst();
  const stats = (row?.agent_stats ?? null) as { last_fact_feedback_at?: string } | null;
  if (!stats?.last_fact_feedback_at) return null;
  const parsed = new Date(stats.last_fact_feedback_at);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Незакрытые противоречия бизнеса. */
export async function openContradictions(db: Kysely<Database>, businessId: string) {
  const rows = await db
    .selectFrom("osint_intelligence_contradictions")
    .select(["id", "fact_type", "sides", "value_count", "source_count", "updated_at"])
    .where("osint_intelligence_contradictions.business_id", "=", businessId)
    .where("osint_intelligence_contradictions.status", "=", "unresolved")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    factType: String(row.fact_type),
    sides: parseJsonbSides(row.sides),
    valueCount: row.value_count,
    sourceCount: row.source_count,
  }));
}

/** jsonb приходит недоверенным: разбираем через общий безопасный парсер. */
function parseJsonbSides(raw: unknown): ContradictionSide[] {
  return parseSides(raw);
}

/** Сущности бизнеса, которых раньше не видели (кандидаты и подтверждённые). */
export async function businessEntities(
  db: Kysely<Database>,
  businessId: string,
) {
  const rows = await db
    .selectFrom("osint_business_entities")
    .innerJoin("osint_entities", "osint_entities.id", "osint_business_entities.entity_id")
    .select([
      "osint_entities.id",
      "osint_entities.normalized_name",
      "osint_entities.kind",
      "osint_entities.phone",
      "osint_entities.website",
      "osint_entities.address",
      "osint_business_entities.status",
    ])
    .where("osint_business_entities.business_id", "=", businessId)
    .where("osint_business_entities.status", "<>", "rejected")
    .limit(50)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    normalizedName: String(row.normalized_name),
    kind: String(row.kind),
    phone: row.phone,
    website: row.website,
    address: row.address,
    status: row.status,
  }));
}

/**
 * Полный проход обратной связи.
 *
 * Шаги:
 *   1. прочитать факты, найденные после прошлого прохода;
 *   2. построить из них гипотезы;
 *   3. прочитать открытые противоречия и построить гипотезы о причине;
 *   4. учесть новые сущности;
 *   5. записать гипотезы и поставить их запросы в очередь действий.
 *
 * Идемпотентность: dedupe-ключи гипотез и действий уникальны на run, поэтому
 * повторный проход по тем же фактам ничего не создаёт.
 */
export async function runFeedback(
  db: Kysely<Database>,
  input: {
    runId: string;
    businessId: string;
    identity: BusinessIdentity;
    maxQueries: number;
    since?: Date | null;
  },
): Promise<FeedbackResult> {
  // Отсечка читается ДО сбора фактов: факты нужно собрать относительно
  // последнего прохода, иначе повторный вызов перечитывает всю историю.
  const since = input.since ?? (await lastFeedbackAt(db, input.runId));
  const [facts, contradictions, entities] = await Promise.all([
    collectNewFacts(db, input.businessId, since),
    openContradictions(db, input.businessId),
    businessEntities(db, input.businessId),
  ]);

  const fromFacts: Hypothesis[] = facts.flatMap((fact) => hypothesesFromFact(fact));
  const fromContradictions: Hypothesis[] = contradictions.flatMap((row) =>
    hypothesisFromContradiction({
      id: row.id,
      fact_type: row.factType,
      sides: row.sides,
      value_count: row.valueCount,
      source_count: row.sourceCount,
    }),
  );
  const fromEntities: Hypothesis[] = entities.flatMap((entity) =>
    hypothesesFromEntity(entity),
  );

  // Дедуплицируем между источниками: один факт и одна сущность могли породить
  // одну и ту же гипотезу (например, про телефон).
  const unique = dedupeHypotheses([
    ...fromFacts,
    ...fromContradictions,
    ...fromEntities,
  ]);

  const hypotheses = unique.sort((a, b) => b.priority - a.priority);

  const insertedHypotheses = await persistHypotheses(db, {
    runId: input.runId,
    businessId: input.businessId,
    hypotheses,
  });

  // Запросы строим только из гипотез, которые действительно встали в БД:
  // иначе мы бы планировали работу по гипотезам, которых не существует.
  const stored = await db
    .selectFrom("osint_research_hypotheses")
    .select(["id", "dedupe_key", "type", "statement", "reason", "priority", "confidence", "subject_key", "subject_value"])
    .where("run_id", "=", input.runId)
    .where("status", "in", ["open", "testing"])
    .orderBy("priority", "desc")
    .limit(input.maxQueries * 2)
    .execute();

  const actions = stored.flatMap((row) => {
    const draft: Hypothesis = {
      type: row.type as Hypothesis["type"],
      statement: row.statement,
      reason: row.reason,
      purpose: "identity",
      priority: row.priority,
      confidence: Number(row.confidence),
      subjectKey: row.subject_key,
      subjectValue: row.subject_value,
      dedupeKey: row.dedupe_key,
    };
    return queriesForHypothesis(input.identity, draft).map((query) => ({
      query,
      // priority в osint_research_actions — ЦЕЛОЕ (CHECK -1000..1000).
      // Дробное значение здесь давало "invalid input syntax for type integer"
      // и роняло весь тик агента. Гипотеза уже хранится с целым priority,
      // поэтому масштабировать его не нужно.
      priority: row.priority,
      reason: row.reason,
      hypothesisId: row.id,
    }));
  });

  const queued = await persistActions(db, {
    runId: input.runId,
    businessId: input.businessId,
    actions: actions.slice(0, input.maxQueries),
  });

  const confirmedAreas = [
    ...new Set(
      facts
        .filter((fact) => fact.sourceTrust === "official" || fact.sourceTrust === "public_directory")
        .map((fact) => fact.factType),
    ),
  ];

  return {
    hypothesesFromFacts: fromFacts.length,
    hypothesesFromContradictions: fromContradictions.length,
    hypothesesFromEntities: fromEntities.length,
    hypothesesStored: insertedHypotheses,
    actionsQueued: queued,
    confirmedAreas,
  };
}

function dedupeHypotheses(hypotheses: Hypothesis[]): Hypothesis[] {
  const seen = new Set<string>();
  const out: Hypothesis[] = [];
  for (const hypothesis of hypotheses) {
    if (seen.has(hypothesis.dedupeKey)) continue;
    seen.add(hypothesis.dedupeKey);
    out.push(hypothesis);
  }
  return out;
}
