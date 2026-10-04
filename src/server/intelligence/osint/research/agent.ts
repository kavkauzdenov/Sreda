/**
 * Автономный research agent (§21, §72).
 *
 * Цикл:
 *   идентичность → гипотезы → запросы → действия → (исполняются воркером)
 *   → исходы → новое знание → новые гипотезы → следующее действие → …
 *   → стоп по бюджету, насыщению или отсутствию полезных действий.
 *
 * Модуль решает ТОЛЬКО «что делать дальше». Он не ходит в сеть: выдаёт
 * следующее действие, которое исполняет существующий discovery-механизм.
 * Это сознательное разделение: планирование детерминировано и тестируемо,
 * а сеть остаётся там, где уже есть SSRF-защита.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import type { OsintResearchPurpose } from "../schema.ts";
import { buildIdentityFromSeed, type IdentitySeed } from "./identity-builder.ts";
import {
  identityConfidence,
  hasStrongIdentity,
  type BusinessIdentity,
  type IdentityKind,
} from "./identity.ts";
import {
  buildInitialHypotheses,
  decayPriority,
  type Hypothesis,
} from "./hypothesis.ts";
import { planQueries, type SearchQuery } from "./query-generator.ts";
import {
  decideStop,
  duplicationFor,
  evaluateCoverage,
  noveltyFor,
  relevanceFor,
  scoreAction,
  STOP_REASON_LABELS,
  type CoverageReport,
  type StopReason,
} from "./coverage.ts";
import {
  peekNextAction,
  countBarrenActions,
  countPendingActions,
  knownActionKeys,
  knownHypothesisKeys,
  persistActions,
  persistHypotheses,
  recentOutcomesByPurpose,
  saveRunPlan,
  setRunPhase,
} from "./plan-store.ts";

export type ResearchAgentConfig = {
  /** Потолок запросов на всё исследование, а не на один проход. */
  maxQueries: number;
  /** Максимум итераций планирования за один вызов. */
  maxPlanningRounds: number;
};

export const DEFAULT_AGENT_CONFIG: ResearchAgentConfig = {
  maxQueries: 40,
  maxPlanningRounds: 5,
};

/** Знание, найденное в ходе исследования и питающее бэкендинг планировщика. */
export type ResearchKnowledge = {
  /** Домены/телефоны/адреса, найденные в источниках — новые идентичности. */
  discovered: { kind: IdentityKind; value: string; display?: string; sourceId?: string }[];
  /** Какие направления исследования подтверждены фактами. */
  confirmed: Partial<Record<string, boolean>>;
  /** Направления, которые мы не смогли закрыть, и почему. */
  blockers: Partial<Record<string, string[]>>;
};

export const EMPTY_KNOWLEDGE: ResearchKnowledge = {
  discovered: [],
  confirmed: {},
  blockers: {},
};

/**
 * Планировщик: превращает текущее знание в следующие действия.
 *
 * Чистая функция относительно БД — всё, что ей нужно, передаётся входом.
 * Так цикл можно тестировать без базы и без сети.
 */
export function planNextActions(input: {
  identity: BusinessIdentity;
  knowledge: ResearchKnowledge;
  exhaustedHypotheses: ReadonlySet<string>;
  exhaustedQueries: ReadonlySet<string>;
  recentOutcomes: Map<OsintResearchPurpose, string[]>;
  maxQueries: number;
}): { actions: { query: SearchQuery; priority: number }[]; hypotheses: Hypothesis[] } {
  const hypotheses = buildInitialHypotheses({
    identity: input.identity,
    exhausted: input.exhaustedHypotheses,
    discovered: input.knowledge.discovered,
  });

  const queries = planQueries(
    input.identity,
    hypotheses,
    input.maxQueries,
    input.exhaustedQueries,
  );

  // Пересчитываем приоритет с учётом того, что мы уже знаем. Это и есть
  // «план меняется по мере открытий»: после нахождения телефона поиск
  // контактов сам собой уходит вниз.
  const confirmedMap = input.knowledge.confirmed as Record<OsintResearchPurpose, boolean>;
  const actions = queries.map((query) => {
    const outcomes = (input.recentOutcomes.get(query.purpose) ?? []) as never;
    const scored = scoreAction({
      purpose: query.purpose,
      identityRelevance: relevanceFor(
        input.identity,
        query.purpose,
        confirmedMap as Record<OsintResearchPurpose, boolean>,
      ),
      expectedInformationGain: 1 - duplicationFor(outcomes),
      sourceReliability: 0.6,
      novelty: noveltyFor(outcomes),
      cost: 1,
      duplication: duplicationFor(outcomes),
    });
    // Учитываем, сколько раз гипотеза уже проверяли.
    const hypothesis = hypotheses.find((h) => h.dedupeKey === query.hypothesisKey);
    const decayed = hypothesis
      ? decayPriority(scored.priority, Math.max(0, (input.recentOutcomes.get(query.purpose) ?? []).length))
      : scored.priority;
    return {
      query,
      priority: Math.round((query.priority * 0.3 + decayed * 0.7) * 100) / 100,
    };
  });

  return {
    actions: actions.sort((a, b) => b.priority - a.priority).slice(0, input.maxQueries),
    hypotheses,
  };
}

/**
 * Один такт агента: спланировать, записать и вернуть следующее действие.
 *
 * Идемпотентно: повторный вызов на том же run не создаст ни гипотез, ни
 * действий заново — dedupe_key отсекает всё уже известное.
 */
export async function agentTick(
  db: Kysely<Database>,
  input: {
    runId: string;
    businessId: string;
    seed: IdentitySeed;
    knowledge?: ResearchKnowledge;
    config?: ResearchAgentConfig;
  },
): Promise<{
  plannedActions: number;
  nextAction: { id: string; query: string; purpose: OsintResearchPurpose; reason: string } | null;
  coverage: CoverageReport | null;
  stop: StopReason;
}> {
  const config = input.config ?? DEFAULT_AGENT_CONFIG;
  const knowledge = input.knowledge ?? EMPTY_KNOWLEDGE;
  const identity = buildIdentityFromSeed(input.seed);

  const exhaustedHypotheses = await knownHypothesisKeys(db, input.runId);
  const exhaustedQueries = await knownActionKeys(db, input.runId);
  const recentOutcomes = await recentOutcomesByPurpose(db, input.runId);

  const remainingQueries = Math.max(
    0,
    config.maxQueries - exhaustedQueries.size,
  );

  if (remainingQueries === 0) {
    const coverage = await buildCoverage(db, input.runId, knowledge);
    await saveRunPlan(db, {
      runId: input.runId,
      coverage: coverage as unknown as Record<string, unknown>,
      agentStats: { stopped_because: "budget_exhausted" },
    });
    return { plannedActions: 0, nextAction: null, coverage, stop: "budget_exhausted" };
  }

  await setRunPhase(db, input.runId, "planning");

  const { actions, hypotheses } = planNextActions({
    identity,
    knowledge,
    exhaustedHypotheses,
    exhaustedQueries,
    recentOutcomes: recentOutcomes as unknown as Map<OsintResearchPurpose, string[]>,
    maxQueries: remainingQueries,
  });

  await persistHypotheses(db, {
    runId: input.runId,
    businessId: input.businessId,
    hypotheses,
  });

  const planned = await persistActions(db, {
    runId: input.runId,
    businessId: input.businessId,
    actions,
  });

  const pending = await countPendingActions(db, input.runId);
  const barren = await countBarrenActions(db, input.runId);
  const coverage = await buildCoverage(db, input.runId, knowledge);

  const stop = decideStop({
    budgetExhausted: remainingQueries === 0,
    pendingActions: pending,
    barrenActions: barren,
    coverage,
  });

  await setRunPhase(db, input.runId, stop ? "saturating" : "searching");
  await saveRunPlan(db, {
    runId: input.runId,
    plan: {
      identity_confidence: identityConfidence(identity),
      identity_confirmed: hasStrongIdentity(identity),
      hypotheses: hypotheses.length,
      queries_planned: actions.length,
      stopped_because: stop ? STOP_REASON_LABELS[stop] : null,
    },
    coverage: coverage as unknown as Record<string, unknown>,
    knowledge: {
      discovered: knowledge.discovered.length,
      confirmed: Object.entries(knowledge.confirmed)
        .filter(([, value]) => value)
        .map(([key]) => key),
    },
    agentStats: {
      actions_planned: planned,
      actions_pending: pending,
      barren_actions: barren,
    },
  });

  // Подглядываем, а НЕ забираем: захват здесь оставлял бы действие в running
  // без исполнителя — воркер его больше не видел, и исследование зависало.
  const next = await peekNextAction(db, input.runId);

  return {
    plannedActions: planned,
    nextAction: next
      ? {
          id: next.id,
          query: next.query,
          purpose: next.purpose,
          reason: next.reason,
        }
      : null,
    coverage,
    stop,
  };
}

/** Собирает отчёт о покрытии из подтверждённых направлений и блокеров. */
async function buildCoverage(
  db: Kysely<Database>,
  runId: string,
  knowledge: ResearchKnowledge,
): Promise<CoverageReport> {
  const barren = await countBarrenActions(db, runId);
  return evaluateCoverage({
    confirmed: knowledge.confirmed,
    blockers: knowledge.blockers,
    barrenActions: barren,
    exhausted: false,
    budgetExhausted: false,
  });
}
