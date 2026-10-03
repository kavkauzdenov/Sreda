/**
 * Фоновый тик автономного агента (§6, §12, §47).
 *
 * Здесь замыкается цикл исполнения. Тик делает ровно одно полезное
 * действие, поэтому не блокирует воркер и безопасен при рестарте:
 *
 *   1. достроить план, если появились новые факты или противоречия;
 *   2. взять следующее действие из очереди (compare-and-set);
 *   3. исполнить его существующим discovery-механизмом;
 *   4. записать исход в след аудита;
 *   5. оценить покрытие и решить, продолжать ли.
 *
 * Восстановление после рестарта: действие, оставшееся в `running`, берётся
 * обратно через requeueClaimedActions — иначе после падения воркера оно
 * потерялось бы навсегда.
 */

import { sql, type Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import { log } from "../../../observability/log.ts";
import { loadDiscoveryProfile } from "../discovery.ts";
import { ensureEntity } from "../candidates.ts";
import { createBuiltinRegistry } from "../providers/builtin.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { agentTick, DEFAULT_AGENT_CONFIG } from "./agent.ts";
import { runFeedback } from "./feedback-loop.ts";
import { executeResearchAction, finalizeAction } from "./executor.ts";
import { identitySeedFromProfile, buildIdentityFromSeed } from "./identity-builder.ts";
import {
  claimNextAction,
  completeRun,
  countBarrenActions,
  countPendingActions,
  saveRunPlan,
  setHypothesisStatus,
  setRunPhase,
} from "./plan-store.ts";
import { computeResearchStats, confirmedAreasFromFacts } from "./stats.ts";
import { decideStop, evaluateCoverage } from "./coverage.ts";

export type AgentTickResult = {
  /** Активных исследований было что делать. */
  ticked: boolean;
  runId: string | null;
  /**
   * Что именно произошло на этом тике.
   * `inactive` — run уже терминальный, трогать его нельзя.
   */
  did: "none" | "planned" | "feedback" | "executed" | "finished" | "error" | "inactive";
  /** Человекочитаемая причина, если тик завершил исследование. */
  stopReason: string | null;
};

/** Действия, застрявшие в running дольше порога, возвращаются в очередь. */
const CLAIM_TIMEOUT_MS = 5 * 60_000;

/**
 * Возвращает в очередь действия, оставшиеся в `running`.
 *
 * Это и есть восстановление после рестарта воркера. Claim идёт через
 * сравнение по времени: если действие было забрано, но не завершено, его
 * возвращать безопасно — результат всё равно не записан.
 */
export async function requeueClaimedActions(
  db: Kysely<Database>,
  runId: string,
  olderThanMs = CLAIM_TIMEOUT_MS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const result = await sql<{ n: string }>`
    with requeued as (
      update osint_research_actions
      set status = 'pending', updated_at = now()
      where run_id = ${runId}
        and status = 'running'
        and updated_at < ${cutoff}
      returning id
    )
    select count(*)::text as n from requeued
  `.execute(db);
  return Number(result.rows[0]?.n ?? 0);
}

/** Активные исследования: есть что исполнять. */
async function activeRuns(db: Kysely<Database>) {
  return db
    .selectFrom("osint_discovery_runs")
    .select(["id", "business_id", "profile", "budget"])
    .where("status", "in", ["queued", "running"])
    .orderBy("created_at", "asc")
    .limit(3)
    .execute();
}

/**
 * Один тик агента по конкретному run.
 *
 * Делает одно действие за раз: это ограничивает blast radius и делает
 * поведение предсказуемым при рестарте — незавершённое действие просто
 * будет взято снова.
 */
export async function tickResearchRun(
  db: Kysely<Database>,
  run: { id: string; business_id: string },
  options: { registry?: ProviderRegistry; signal?: AbortSignal } = {},
): Promise<AgentTickResult> {
  const base: AgentTickResult = { ticked: false, runId: run.id, did: "none", stopReason: null };

  try {
    // Терминальный run больше не активен. Без этой проверки вызов тика по
    // завершённому исследованию снова поставил бы гипотезы и исполнил
    // действие — то есть «оживил» бы то, что уже закончено.
    const state = await db
      .selectFrom("osint_discovery_runs")
      .select("status")
      .where("id", "=", run.id)
      .executeTakeFirst();
    if (!state || !["queued", "running"].includes(state.status)) {
      return { ...base, did: "inactive", stopReason: "исследование уже завершено" };
    }

    await requeueClaimedActions(db, run.id);

    const profile = await loadDiscoveryProfile(db, run.business_id);
    const seed = identitySeedFromProfile(profile);
    const identity = buildIdentityFromSeed(seed);
    const maxQueries = Math.max(4, Math.min(40, Number((run as { budget?: Record<string, unknown> }).budget?.maxQueries ?? 12) * 3));

    // 1. Обратная связь: новые факты и противоречия порождают гипотезы.
    const feedback = await runFeedback(db, {
      runId: run.id,
      businessId: run.business_id,
      identity,
      maxQueries,
    });

    // 2. Если очередь пуста — достраиваем план из текущего знания.
    // Планировщик ОБЯЗАН видеть, что уже найдено, иначе он бесконечно
    // планирует одно и то же. Поэтому знание берётся из БД.
    let pending = await countPendingActions(db, run.id);
    if (pending === 0) {
      await setRunPhase(db, run.id, "planning");
      const current = await computeResearchStats(db, run.business_id);
      const confirmed = confirmedAreasFromFacts(current.confirmedAreas);
      await agentTick(db, {
        runId: run.id,
        businessId: run.business_id,
        seed,
        knowledge: {
          discovered: [],
          confirmed: Object.fromEntries([...confirmed].map((area) => [area, true])),
          blockers: {},
        },
        config: { ...DEFAULT_AGENT_CONFIG, maxQueries },
      });
      // Состояние очереди читаем из БД, а не берём из отчётного значения
      // планировщика. Планировщик возвращает СВОИ НАМЕРЕНИЯ; если все
      // запросы уже известны (dedupe отсёк их), в базе ноль строк — а по
      // намерению ненулевое число. Поверив намерению, агент зависал бы в
      // цикле планирования и никогда не завершил бы исследование.
      pending = await countPendingActions(db, run.id);
    }

    if (pending === 0) {
      // 3. Очередь пуста и строить нечего — оцениваем и завершаем.
      const finish = await finishRun(db, run.id, run.business_id, identity);
      return { ...base, ticked: true, did: "finished", stopReason: finish };
    }

    // 4. Исполняем ровно одно действие.
    const action = await claimNextAction(db, run.id);
    // Взять нечего, хотя счётчик показывает незавершённые действия, значит
    // они все в running. Возвращать их немедленно нельзя: их может держать
    // другой живой воркер, и мы бы получили двойное исполнение. Их вернёт
    // requeueClaimedActions по таймауту — это и есть штатное восстановление.
    if (!action) return { ...base, ticked: true, did: "planned" };

    await setRunPhase(db, run.id, "searching");
    const registry = options.registry ?? createBuiltinRegistry();
    const entityId = await ensureEntity(db, {
      businessId: run.business_id,
      profile,
    });

    // Снимок ДО исполнения: new_facts должен быть приростом за это
    // действие, а не накопленной суммой по всему бизнесу.
    const before = await computeResearchStats(db, run.business_id);

    const result = await executeResearchAction(
      db,
      {
        id: action.id,
        run_id: action.run_id,
        business_id: action.business_id,
        purpose: action.purpose,
        query: action.query,
        target_url: action.target_url,
      },
      {
        profile,
        registry,
        entityId,
        maxResults: 10,
        signal: options.signal,
      },
    );

    // 5. Пустой результат закрывает гипотезу: вопрос проверен, ответа нет.
    // Это принципиально отличается от «провал»: гипотеза не должна висеть
    // и мешать планировщику возвращаться к ней.
    if (action.hypothesis_id && (result.outcome === "empty" || result.outcome === "duplicate")) {
      await setHypothesisStatus(db, action.hypothesis_id, "exhausted");
    }

    const after = await computeResearchStats(db, run.business_id);
    await finalizeAction(db, action.id, result, {
      newFacts: Math.max(0, after.facts - before.facts),
    });

    await saveRunPlan(db, {
      runId: run.id,
      agentStats: {
        last_fact_feedback_at: new Date().toISOString(),
        facts_seen: feedback.hypothesesFromFacts,
        contradictions_seen: feedback.hypothesesFromContradictions,
        last_outcome: result.outcome,
      },
    });

    return {
      ...base,
      ticked: true,
      did: "executed",
      stopReason: null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    log("error", "OSINT_AGENT_TICK_FAILED", {
      run_id: run.id,
      error: message.slice(0, 300),
    });
    return { ...base, ticked: false, did: "error", stopReason: null };
  }
}

/**
 * Завершение исследования.
 *
 * Покрытие считается по ПОДТВЕРЖДЁННЫМ фактам, а не по успешности
 * действий: направление без находок остаётся неизвестным.
 */
async function finishRun(
  db: Kysely<Database>,
  runId: string,
  businessId: string,
  identity: ReturnType<typeof buildIdentityFromSeed>,
): Promise<string> {
  const [stats, pending, barren] = await Promise.all([
    computeResearchStats(db, businessId),
    countPendingActions(db, runId),
    countBarrenActions(db, runId),
  ]);

  const confirmedAreas = confirmedAreasFromFacts(stats.confirmedAreas);
  const blockers: Record<string, string[]> = {};
  const blockedSources = await sql<{ name: string; detail: string }>`
    select s.name as name, sa.detail as detail
    from osint_source_access sa
    join osint_sources s on s.id = sa.source_id
    join osint_entity_sources es on es.source_id = s.id
    join osint_business_entities be on be.entity_id = es.entity_id
    where be.business_id = ${businessId}
      and be.status <> 'rejected'
      and sa.status <> 'accessible'
    group by s.name, sa.detail
    limit 20
  `.execute(db);
  for (const row of blockedSources.rows) {
    const key = row.name || "Источник";
    blockers[key] = [...(blockers[key] ?? []), row.detail || "Источник недоступен"];
  }

  const coverage = evaluateCoverage({
    confirmed: Object.fromEntries([...confirmedAreas].map((area) => [area, true])),
    blockers: {},
    barrenActions: barren,
    exhausted: pending === 0,
    budgetExhausted: false,
  });

  const stop = decideStop({
    budgetExhausted: false,
    pendingActions: pending,
    barrenActions: barren,
    coverage,
  });

  await saveRunPlan(db, {
    runId,
    coverage: coverage as unknown as Record<string, unknown>,
    knowledge: {
      confirmed: [...confirmedAreas],
      facts: stats.facts,
      contradictions: stats.contradictions,
    },
    agentStats: {
      stop_reason: stop,
      identity_confidence: identity.values.length,
      stats,
    },
  });

  await setRunPhase(db, runId, "saturating");

  // Терминальный статус. Без него run остаётся активным навсегда и воркер
  // продолжает тикать по уже завершённому исследованию.
  await completeRun(db, runId, {
    confirmedAreas: confirmedAreas.size,
    facts: stats.facts,
    stopReason: stop,
  });

  return stop ?? "no_useful_actions";
}

/**
 * Тик по всем активным исследованиям. Вызывается из background-worker.
 */
export async function tickResearchAgent(
  db: Kysely<Database>,
  options: { registry?: ProviderRegistry; signal?: AbortSignal } = {},
): Promise<AgentTickResult[]> {
  const runs = await activeRuns(db);
  const out: AgentTickResult[] = [];
  for (const run of runs) {
    if (options.signal?.aborted) break;
    out.push(await tickResearchRun(db, run, options));
  }
  return out;
}
