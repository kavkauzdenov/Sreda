/**
 * Персистенция исследовательского плана: гипотезы и действия (§7, §8, §21).
 *
 * Слой намеренно тонкий: он умеет записать план, взять следующее действие и
 * зафиксировать исход. Вся логика «что делать» живёт в чистых доменных
 * модулях, здесь только SQL и идемпотентность.
 *
 * Идемпотентность держится на БД, а не на коде: у действий UNIQUE(run_id,
 * dedupe_key), у гипотез — то же. Перезапуск воркера не плодит дубли, а
 * повторное планирование того же исследования не создаёт новых строк.
 */

import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import type {
  OsintHypothesisStatus,
  OsintResearchActionStatus,
  OsintResearchOutcome,
  OsintResearchPhase,
  OsintResearchPurpose,
  OsintSourceAccessStatus,
} from "../schema.ts";
import type { Hypothesis } from "./hypothesis.ts";
import type { SearchQuery } from "./query-generator.ts";

/* ------------------------------------------------------------------ */
/* Гипотезы                                                             */
/* ------------------------------------------------------------------ */

/**
 * Сохраняет гипотезы исследования. Повторы по dedupe_key пропускаются,
 * поэтому вызывать это безопасно на каждой итерации планирования.
 */
/**
 * Приводит приоритет к виду, который принимает PostgreSQL.
 *
 * osint_research_actions.priority и osint_research_hypotheses.priority —
 * целые с CHECK (-1000..1000). Внутри планировщик считает приоритет с
 * дробями (затухание, веса признаков), и это правильно: точность нужна для
 * сортировки кандидатов. Но в базу дробь писать нельзя — PostgreSQL отвечает
 * "invalid input syntax for type integer" и роняет весь тик агента.
 *
 * Поэтому округление и ограничение диапазона живут ЗДЕСЬ, на границе записи:
 * любой вызывающий код может считать как угодно и не сможет сломать запись.
 */
function toDbPriority(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1000, Math.max(-1000, Math.round(value)));
}

/** Доверие — numeric(4,3) с CHECK (0..1). */
function toDbConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

export async function persistHypotheses(
  db: Kysely<Database>,
  input: { runId: string; businessId: string; hypotheses: Hypothesis[] },
): Promise<number> {
  if (input.hypotheses.length === 0) return 0;
  const now = new Date();
  const rows = input.hypotheses.map((hypothesis) => ({
    id: randomUUID(),
    run_id: input.runId,
    business_id: input.businessId,
    parent_hypothesis_id: null,
    type: hypothesis.type,
    statement: hypothesis.statement,
    reason: hypothesis.reason,
    priority: toDbPriority(hypothesis.priority),
    confidence: toDbConfidence(hypothesis.confidence),
    status: "open" as OsintHypothesisStatus,
    source_entity_id: null,
    subject_key: hypothesis.subjectKey,
    subject_value: hypothesis.subjectValue.slice(0, 500),
    actions_used: 0,
    dedupe_key: hypothesis.dedupeKey,
    resolved_at: null,
    created_at: now,
    updated_at: now,
  }));

  const result = await db
    .insertInto("osint_research_hypotheses")
    .values(rows)
    .onConflict((oc) => oc.columns(["run_id", "dedupe_key"]).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

/** Dedup-ключи уже известных гипотез — чтобы не предлагать их повторно. */
export async function knownHypothesisKeys(
  db: Kysely<Database>,
  runId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("osint_research_hypotheses")
    .select("dedupe_key")
    .where("run_id", "=", runId)
    .execute();
  return new Set(rows.map((row) => row.dedupe_key));
}

export async function setHypothesisStatus(
  db: Kysely<Database>,
  hypothesisId: string,
  status: OsintHypothesisStatus,
): Promise<void> {
  await db
    .updateTable("osint_research_hypotheses")
    .set({
      status,
      resolved_at: ["confirmed", "refuted", "exhausted"].includes(status)
        ? new Date()
        : null,
      updated_at: new Date(),
    })
    .where("id", "=", hypothesisId)
    .execute();
}

/** Гипотезы, которые ещё стоит проверять, в порядке убывания приоритета. */
export async function pendingHypotheses(
  db: Kysely<Database>,
  runId: string,
  limit = 10,
) {
  return db
    .selectFrom("osint_research_hypotheses")
    .selectAll()
    .where("run_id", "=", runId)
    .where("status", "in", ["open", "testing"])
    .orderBy("priority", "desc")
    .orderBy("created_at", "asc")
    .limit(limit)
    .execute();
}

/* ------------------------------------------------------------------ */
/* Действия                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ставит действия в очередь. Ключ уникален на (run_id, dedupe_key), поэтому
 * повторное планирование не размножает работу.
 */
export async function persistActions(
  db: Kysely<Database>,
  input: {
    runId: string;
    businessId: string;
    actions: {
      query: SearchQuery;
      priority: number;
      reason?: string;
      parentActionId?: string | null;
      hypothesisId?: string | null;
      targetUrl?: string | null;
    }[];
  },
): Promise<number> {
  if (input.actions.length === 0) return 0;
  const now = new Date();
  const rows = input.actions.map((entry) => ({
    id: randomUUID(),
    run_id: input.runId,
    business_id: input.businessId,
    parent_action_id: entry.parentActionId ?? null,
    hypothesis_id: entry.hypothesisId ?? null,
    kind: "search" as const,
    purpose: entry.query.purpose,
    query: entry.query.query.slice(0, 500),
    target_url: entry.targetUrl ?? null,
    reason: (entry.reason ?? entry.query.derivedFrom).slice(0, 500),
    priority: toDbPriority(entry.priority),
    status: "pending" as OsintResearchActionStatus,
    outcome: "pending" as OsintResearchOutcome,
    results_count: 0,
    new_sources: 0,
    new_facts: 0,
    new_entities: 0,
    error: null,
    dedupe_key: entry.query.dedupeKey,
    executed_at: null,
    created_at: now,
    updated_at: now,
  }));

  const result = await db
    .insertInto("osint_research_actions")
    .values(rows)
    .onConflict((oc) => oc.columns(["run_id", "dedupe_key"]).doNothing())
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

export async function knownActionKeys(
  db: Kysely<Database>,
  runId: string,
): Promise<Set<string>> {
  const rows = await db
    .selectFrom("osint_research_actions")
    .select("dedupe_key")
    .where("run_id", "=", runId)
    .execute();
  return new Set(rows.map((row) => row.dedupe_key));
}

/**
 * Берёт следующее действие — «next best action» становится порядком строк.
 *
 * Claim через compare-and-set по status: два конкурента получат разные
 * действия, и оба конфликта не приведут к двойному исполнению.
 */
export async function claimNextAction(db: Kysely<Database>, runId: string) {
  const candidates = await db
    .selectFrom("osint_research_actions")
    .selectAll()
    .where("run_id", "=", runId)
    .where("status", "=", "pending")
    .orderBy("priority", "desc")
    .orderBy("created_at", "asc")
    .limit(5)
    .execute();

  for (const candidate of candidates) {
    const claimed = await db
      .updateTable("osint_research_actions")
      .set({ status: "running" as OsintResearchActionStatus, updated_at: new Date() })
      .where("id", "=", candidate.id)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows ?? 0) === 1) {
      return { ...candidate, status: "running" as OsintResearchActionStatus };
    }
  }
  return null;
}

/** Фиксирует исход действия — это и есть след для аудита. */
export async function completeAction(
  db: Kysely<Database>,
  input: {
    actionId: string;
    status: Exclude<OsintResearchActionStatus, "pending" | "running">;
    outcome: OsintResearchOutcome;
    results?: number;
    newSources?: number;
    newFacts?: number;
    newEntities?: number;
    error?: string | null;
  },
): Promise<void> {
  await db
    .updateTable("osint_research_actions")
    .set({
      status: input.status,
      outcome: input.outcome,
      results_count: input.results ?? 0,
      new_sources: input.newSources ?? 0,
      new_facts: input.newFacts ?? 0,
      new_entities: input.newEntities ?? 0,
      error: input.error ? input.error.slice(0, 500) : null,
      executed_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", input.actionId)
    .execute();
}

export async function countPendingActions(
  db: Kysely<Database>,
  runId: string,
): Promise<number> {
  const row = await db
    .selectFrom("osint_research_actions")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("run_id", "=", runId)
    .where("status", "in", ["pending", "running"])
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Последние исходы по назначению — вход для novelty/duplication. */
export async function recentOutcomesByPurpose(
  db: Kysely<Database>,
  runId: string,
  limit = 10,
): Promise<Map<OsintResearchPurpose, OsintResearchOutcome[]>> {
  const rows = await db
    .selectFrom("osint_research_actions")
    .select(["purpose", "outcome", "executed_at"])
    .where("run_id", "=", runId)
    .where("status", "in", ["done", "failed", "skipped", "exhausted"])
    .orderBy("executed_at", "desc")
    .limit(limit)
    .execute();

  const out = new Map<OsintResearchPurpose, OsintResearchOutcome[]>();
  for (const row of rows) {
    const list = out.get(row.purpose) ?? [];
    list.push(row.outcome);
    out.set(row.purpose, list);
  }
  return out;
}

/** Сколько последних действий не дали нового знания — сигнал насыщения. */
export async function countBarrenActions(
  db: Kysely<Database>,
  runId: string,
): Promise<number> {
  const rows = await db
    .selectFrom("osint_research_actions")
    .select("outcome")
    .where("run_id", "=", runId)
    .where("status", "in", ["done", "failed", "skipped", "exhausted"])
    .orderBy("executed_at", "desc")
    .limit(12)
    .execute();
  let barren = 0;
  for (const row of rows) {
    if (["productive"].includes(row.outcome)) break;
    barren += 1;
  }
  return barren;
}

/* ------------------------------------------------------------------ */
/* Доступность источника (§38)                                          */
/* ------------------------------------------------------------------ */

/**
 * Записывает состояние источника.
 *
 * Счётчик consecutive_count растёт монотонно и обнуляется на успехе — это
 * детектор «источник устойчиво недоступен», на котором строится насыщение.
 * Таблица глобальная: блокировка сайта одинакова для всех тенантов.
 */
export async function recordSourceAccess(
  db: Kysely<Database>,
  input: {
    sourceId: string;
    status: OsintSourceAccessStatus;
    detail?: string;
    httpStatus?: number | null;
    statusCode?: string | null;
  },
): Promise<void> {
  const now = new Date();
  const ok = input.status === "accessible";

  await db
    .insertInto("osint_source_access")
    .values({
      source_id: input.sourceId,
      status: input.status,
      http_status: input.httpStatus ?? null,
      detail: (input.detail ?? "").slice(0, 500),
      consecutive_count: ok ? 0 : 1,
      last_status_code: input.statusCode ?? null,
      last_checked_at: now,
      last_success_at: ok ? now : null,
      first_blocked_at: ok ? null : now,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) =>
      oc.columns(["source_id"]).doUpdateSet({
        status: input.status,
        http_status: input.httpStatus ?? null,
        detail: (input.detail ?? "").slice(0, 500),
        // Ссылки квалифицированы именем таблицы: в DO UPDATE видны и целевая
        // таблица, и псевдотаблица excluded, поэтому `consecutive_count`
        // без префикса даёт "column reference is ambiguous" (SQLSTATE 42702).
        consecutive_count: ok
          ? 0
          : sql`osint_source_access.consecutive_count + 1`,
        last_status_code: input.statusCode ?? null,
        last_checked_at: now,
        last_success_at: ok ? now : sql`osint_source_access.last_success_at`,
        // Дата ПЕРВОЙ блокировки не затирается последующим успехом: она нужна,
        // чтобы понимать историю недоступности источника. Обнуление здесь
        // стирало бы её при каждой удачной проверке.
        first_blocked_at: sql`osint_source_access.first_blocked_at`,
        updated_at: now,
      }),
    )
    .execute();
}

/* ------------------------------------------------------------------ */
/* Фаза и агрегаты run'а                                                */
/* ------------------------------------------------------------------ */

export async function setRunPhase(
  db: Kysely<Database>,
  runId: string,
  phase: OsintResearchPhase,
): Promise<void> {
  await db
    .updateTable("osint_discovery_runs")
    .set({ phase, updated_at: new Date() })
    .where("id", "=", runId)
    .execute();
}

/**
 * Переводит исследование в терминальный статус.
 *
 * Без этого run навсегда остаётся в (queued, running), а тики воркера
 * продолжают его поднимать: исследование, у которого очередь пуста, было бы
 * «завершено» в UI, но никогда не завершилось бы по-настоящему.
 *
 * Статус выбирается по тому, что реально найдено, а не по факту остановки:
 *   - confirmed — есть подтверждённые находки, исследование своё дело сделало;
 *   - partial   — ветки исчерпаны или заблокированы, но что-то найдено;
 *   - completed — находок нет вовсе: технически успешно, содержательно пусто.
 */
export async function completeRun(
  db: Kysely<Database>,
  runId: string,
  input: {
    confirmedAreas: number;
    facts: number;
    stopReason: string | null;
  },
): Promise<"completed" | "partial"> {
  const status: "completed" | "partial" =
    input.confirmedAreas > 0 || input.facts > 0 ? "completed" : "partial";
  await db
    .updateTable("osint_discovery_runs")
    .set({
      status,
      finished_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", runId)
    // Защита от повторной записи: терминальный статус не переигрывается.
    .where("status", "in", ["queued", "running"])
    .execute();
  return status;
}

export async function saveRunPlan(
  db: Kysely<Database>,
  input: {
    runId: string;
    /** Частичное обновление: отсутствующие секции не трогаются. */
    plan?: Record<string, unknown>;
    coverage?: Record<string, unknown>;
    knowledge?: Record<string, unknown>;
    agentStats?: Record<string, unknown>;
  },
): Promise<void> {
  const set: Record<string, unknown> = { updated_at: new Date() };
  if (input.plan) set.plan = input.plan;
  if (input.coverage) set.coverage = input.coverage;
  if (input.knowledge) set.knowledge = input.knowledge;
  if (input.agentStats) set.agent_stats = input.agentStats;
  if (Object.keys(set).length === 1) return;
  await db
    .updateTable("osint_discovery_runs")
    .set(set as never)
    .where("id", "=", input.runId)
    .execute();
}
