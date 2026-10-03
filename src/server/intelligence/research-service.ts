/**
 * Zero-config запуск автономного исследования (§53, §31, §51).
 *
 * Пользователь не выбирает провайдеров, источники, цели и запросы. Он
 * сообщает, какой бизнес исследовать (это уже сделано при создании
 * бизнеса) — и всё. Здесь мы строим идентичность из карточки, создаём run
 * и отдаём первый план.
 *
 * Ответ намеренно человекочитаемый: ни кодов провайдеров, ни перечисления
 * недоступных API. Что иамо недоступно — отдельным блоком с объяснением
 * и указанием, что исследование продолжается.
 */

import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { requireBusiness } from "../access/permissions.ts";
import { createDiscoveryRun, loadDiscoveryProfile } from "./osint/discovery.ts";
import { agentTick, type ResearchKnowledge } from "./osint/research/agent.ts";
import {
  buildIdentityFromSeed,
  identitySeedFromProfile,
} from "./osint/research/identity-builder.ts";
import { identityConfidence, hasStrongIdentity } from "./osint/research/identity.ts";
import { DIMENSION_LABELS } from "./osint/research/coverage.ts";
import { countBarrenActions, countPendingActions } from "./osint/research/plan-store.ts";
import { createBuiltinRegistry } from "./osint/providers/builtin.ts";
import type { OsintResearchPurpose } from "./osint/schema.ts";

export type ResearchMode = "quick" | "standard" | "deep";

/** Бюджеты режимов. Deep отличается не «качеством», а глубиной и объёмом. */
const MODE_BUDGET: Record<ResearchMode, { maxQueries: number; budget: Record<string, number> }> = {
  quick: {
    maxQueries: 12,
    budget: { maxQueries: 6, maxPages: 3, maxRequests: 12, maxDurationMs: 15_000 },
  },
  standard: {
    maxQueries: 40,
    budget: { maxQueries: 12, maxPages: 5, maxRequests: 40, maxDurationMs: 30_000 },
  },
  deep: {
    maxQueries: 120,
    budget: { maxQueries: 25, maxPages: 12, maxRequests: 90, maxDurationMs: 90_000 },
  },
};

/** Человекочитаемый план: «что мы уже знаем» и «что проверяем сейчас». */
export type ResearchPlanView = {
  mode: ResearchMode;
  identity: {
    name: string;
    city: string | null;
    /** Насколько уверенно опознан бизнес. Никогда не 100% по одному названию. */
    confidence: number;
    /** Есть ли сильный идентификатор (телефон, домен, адрес). */
    confirmed: boolean;
    found: string[];
  };
  /** Активные направления исследования — по-человечески, не enum'ы. */
  areas: { key: string; label: string; status: "working" | "done" | "blocked" }[];
  /** Что агент собирается делать дальше. */
  nextActions: { query: string; purpose: OsintResearchPurpose; reason: string }[];
  /** Чего мы пока не знаем. Пустой список вводит в заблуждение. */
  unknown: string[];
};

export type ResearchStartResult = {
  runId: string;
  status: string;
  created: boolean;
  plan: ResearchPlanView | null;
};

/**
 * Стартует исследование без единой настройки от пользователя.
 *
 * Идемпотентно по активному запуску: если исследование уже идёт, вернём его
 * же, а не создадим второе. Это тот же контракт, что у паспортного launch.
 */
export async function startAutonomousResearch(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
  input: { mode?: ResearchMode } = {},
): Promise<ResearchStartResult> {
  const member = await requireBusiness(db, userId, publicId, "intelligence.manage");
  const mode: ResearchMode = input.mode ?? "standard";
  const config = MODE_BUDGET[mode] ?? MODE_BUDGET.standard;

  const active = await db
    .selectFrom("osint_discovery_runs")
    .select(["id", "status", "phase"])
    .where("business_id", "=", member.id)
    .where("status", "in", ["queued", "running"])
    .orderBy("created_at", "desc")
    .executeTakeFirst();

  if (active) {
    const profile = await loadDiscoveryProfile(db, member.id);
    const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));
    return {
      runId: active.id,
      status: active.status,
      created: false,
      plan: {
        mode,
        ...describeIdentity(identity),
        areas: [],
        nextActions: [],
        unknown: [],
      },
    };
  }

  const profile = await loadDiscoveryProfile(db, member.id);
  const identity = buildIdentityFromSeed(identitySeedFromProfile(profile));

  const run = await createDiscoveryRun(db, {
    businessId: member.id,
    // Реестр создаётся на каждый вызов: emit-once провайдеры (own_urls)
    // должны отдать результаты именно этому run.
    registry: createBuiltinRegistry(),
    budget: config.budget,
    crawl: true,
  });

  const knowledge: ResearchKnowledge = {
    discovered: [],
    confirmed: {},
    blockers: {},
  };

  const tick = await agentTick(db, {
    runId: run.runId,
    businessId: member.id,
    seed: identitySeedFromProfile(profile),
    knowledge,
    config: { maxQueries: config.maxQueries, maxPlanningRounds: 5 },
  });

  const hypotheses = await db
    .selectFrom("osint_research_hypotheses")
    .select(["type", "status", "statement", "reason"])
    .where("run_id", "=", run.runId)
    .orderBy("priority", "desc")
    .execute();

  return {
    runId: run.runId,
    status: run.runId ? "queued" : "queued",
    created: true,
    plan: {
      mode,
      ...describeIdentity(identity),
      areas: hypotheses.slice(0, 10).map((hypothesis) => ({
        key: String(hypothesis.type),
        label: DIMENSION_LABELS[String(hypothesis.type)] ?? String(hypothesis.type),
        status: hypothesis.status === "confirmed" ? "done" : "working",
      })),
      nextActions: tick.nextAction
        ? [
            {
              query: tick.nextAction.query,
              purpose: tick.nextAction.purpose,
              reason: tick.nextAction.reason,
            },
          ]
        : [],
      unknown: tick.coverage?.unknown ?? [],
    },
  };
}

function describeIdentity(identity: ReturnType<typeof buildIdentityFromSeed>) {
  const confidence = identityConfidence(identity);
  const found = identity.values
    .filter((v) => v.kind !== "name" || v.value === identity.normalizedName)
    .map((v) => v.display ?? v.value);
  return {
    identity: {
      name: identity.name,
      city: identity.values.find((v) => v.kind === "city")?.display ?? null,
      confidence,
      confirmed: hasStrongIdentity(identity),
      found,
    },
  };
}

/**
 * Прогресс исследования для UI: что найдено, что сейчас, что дальше и
 * какие источники недоступны — без внутренних кодов.
 */
export async function getResearchProgress(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
  runId: string,
) {
  const member = await requireBusiness(db, userId, publicId, "analytics.view");

  const run = await db
    .selectFrom("osint_discovery_runs")
    .select(["id", "status", "phase", "plan", "coverage", "knowledge", "agent_stats", "error", "created_at"])
    .where("id", "=", runId)
    // Tenant isolation: run другого бизнеса не должен быть виден.
    .where("business_id", "=", member.id)
    .executeTakeFirst();

  if (!run) return null;

  const actions = await db
    .selectFrom("osint_research_actions")
    .select(["query", "purpose", "status", "outcome", "reason", "new_sources", "new_facts"])
    .where("run_id", "=", runId)
    .where("business_id", "=", member.id)
    .orderBy("created_at", "asc")
    .limit(200)
    .execute();

  const blocked = await db
    .selectFrom("osint_source_access")
    .innerJoin("osint_sources", "osint_sources.id", "osint_source_access.source_id")
    .select(["osint_sources.name", "osint_sources.url", "osint_source_access.status", "osint_source_access.detail"])
    .where("osint_source_access.status", "<>", "accessible")
    .orderBy("osint_source_access.last_checked_at", "desc")
    .limit(20)
    .execute();

  const pending = await countPendingActions(db, runId);
  const barren = await countBarrenActions(db, runId);

  const done = actions.filter((a) => a.status === "done");
  const pendingActions = actions
    .filter((a) => a.status === "pending")
    .slice(0, 5)
    .map((a) => ({ query: a.query, purpose: a.purpose, reason: a.reason }));

  return {
    runId: run.id,
    status: run.status,
    phase: run.phase,
    stats: {
      queries: actions.length,
      completed: done.length,
      pending,
      sources: Number(run.plan && typeof run.plan === "object" ? 0 : 0),
      facts: done.reduce((sum, a) => sum + a.new_facts, 0),
      barrenActions: barren,
    },
    whatWeKnow: (run.knowledge as Record<string, unknown> | null) ?? {},
    nextActions: pendingActions,
    blockedSources: blocked.map((row) => ({
      name: row.name || row.url,
      status: row.status,
      detail: row.detail,
      nextAction: "Исследование продолжено через другие источники",
    })),
    unknown: ((run.coverage as Record<string, unknown> | null)?.unknown as string[]) ?? [],
    error: run.error,
  };
}

/**
 * Прогресс последнего исследования бизнеса.
 *
 * Нужен UI, чтобы показать состояние без того, чтобы пользователь помнил
 * идентификатор запуска. Если исследований ещё не было — null, а не ошибка:
 * до первого запуска это штатное состояние, а не сбой.
 */
export async function getLatestResearchProgress(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
) {
  const member = await requireBusiness(db, userId, publicId, "analytics.view");
  const latest = await db
    .selectFrom("osint_discovery_runs")
    .select("id")
    .where("business_id", "=", member.id)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!latest) return null;
  return getResearchProgress(db, userId, publicId, latest.id);
}
