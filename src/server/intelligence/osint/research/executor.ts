/**
 * Исполнение исследовательского действия (§6).
 *
 * Ключевое требование Stage 5: действие из очереди должно РЕАЛЬНО
 * исполняться, а не только планироваться. Здесь очередь research actions
 * связывается с существующим discovery-механизмом.
 *
 * Это НЕ второй краулер. Используются ровно те же примитивы, что и в
 * discovery: тот же реестр провайдеров, тот же классификатор, тот же
 * persistCandidate / ensureSource / ensureObservation, та же SSRF-защищённая
 * загрузка страницы. Новым здесь только цикл «одно действие = один запрос»
 * и запись исхода в след аудита.
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";
import type { DiscoveryIntent } from "../config.ts";
import type { DiscoveryProfile } from "../profile.ts";
import type { GeneratedQuery } from "../queries.ts";
import { classifyResult } from "../classifier.ts";
import {
  attachCandidateSource,
  ensureSource,
  persistCandidate,
} from "../candidates.ts";
import { ensureObservation } from "../observations.ts";
import { enqueueEnrichment } from "../enrichment.ts";
import { log } from "../../../observability/log.ts";
import { recordSourceAccess, completeAction } from "./plan-store.ts";
import {
  ACCESS_STATUS_BY_REASON,
  classifyBlockedReason,
  decideFallback,
} from "./fallback.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type {
  OsintResearchOutcome,
  OsintSourceAccessStatus,
} from "../schema.ts";

/**
 * Исход исполнения действия.
 *
 * Семантика честная: `no_results` — это успешное выполнение без находки, а
 * не провал. Различать их важно, иначе планировщик решит, что ветка не
 * работает, хотя на самом деле вопрос закрыт.
 */
export type ActionExecutionOutcome = OsintResearchOutcome;

export type ActionExecutionResult = {
  actionId: string;
  outcome: ActionExecutionOutcome;
  status: "done" | "failed" | "skipped";
  /** Нужно ли повторить действие позже. */
  retry: boolean;
  results: number;
  newSources: number;
  /** Человекочитаемое объяснение для UI и audit. */
  reason: string;
  /** Технические коды — только в логи. */
  codes: string[];
};

/** Назначение действия → интент провайдера. */
const PURPOSE_INTENT: Record<string, DiscoveryIntent> = {
  identity: "any",
  contact: "identity",
  website: "website",
  social: "social",
  reviews: "reviews",
  maps: "maps",
  legal: "any",
  news: "mentions",
  products: "any",
  services: "any",
  prices: "any",
  vacancies: "any",
  locations: "identity",
  competitors: "any",
  mentions: "any",
  reputation: "reviews",
  changes: "mentions",
  verification: "identity",
};

/**
 * Выполняет одно исследовательское действие.
 *
 * Идемпотентность обеспечивается тем, что действие уже было claim'нуто
 * (статус running) вызывающим кодом через compare-and-set: два воркера не
 * могут получить одно и то же действие. Повторное исполнение уже завершённого
 * действия невозможно, потому что claim берёт только `pending`.
 */
export async function executeResearchAction(
  db: Kysely<Database>,
  action: {
    id: string;
    run_id: string;
    business_id: string;
    purpose: string;
    query: string;
    target_url: string | null;
  },
  context: {
    profile: DiscoveryProfile;
    registry: ProviderRegistry;
    entityId: string;
    maxResults: number;
    signal?: AbortSignal;
  },
): Promise<ActionExecutionResult> {
  const codes: string[] = [];
  const finish = (
    outcome: ActionExecutionOutcome,
    status: "done" | "failed" | "skipped",
    retry: boolean,
    reason: string,
    counts: { results?: number; newSources?: number } = {},
  ): ActionExecutionResult => ({
    actionId: action.id,
    outcome,
    status,
    retry,
    results: counts.results ?? 0,
    newSources: counts.newSources ?? 0,
    reason,
    codes,
  });

  // Пустой запрос — не наша ошибка, но и не результат. Помечаем как
  // выполненное: гипотеза закрыта как «нечего проверять».
  const queryText = action.query.trim();
  if (!queryText) {
    return finish("empty", "done", false, "Запрос пуст — нечего проверять");
  }

  if (context.signal?.aborted) {
    return finish("error", "failed", true, "Исполнение прервано, действие вернётся в очередь");
  }

  const intent = PURPOSE_INTENT[action.purpose] ?? "any";
  const providers = context.registry.select(null, [intent]);
  if (providers.length === 0) {
    // Нет доступного маршрута для этого направления. Это НЕ ошибка
    // исследования: направление остаётся непроверенным, а ветка закроется
    // по насыщению. Повторять бессмысленно — провайдеры не появятся сами.
    codes.push("no_providers_available");
    return finish(
      "blocked",
      "skipped",
      false,
      "Для этого направления нет доступного способа поиска",
    );
  }

  const query: GeneratedQuery = {
    templateId: "research_action",
    intent,
    text: queryText,
  };

  let results = 0;
  let newSources = 0;
  let duplicates = 0;
  let providerErrors = 0;

  for (const provider of providers) {
    if (context.signal?.aborted) break;
    let output;
    try {
      output = await provider.search({
        query,
        profile: context.profile,
        limit: Math.max(1, Math.min(10, context.maxResults)),
        signal: context.signal,
      });
    } catch (error) {
      // Сбой провайдера. Считаем, но НЕ роняем действие: остальные
      // провайдеры могли ответить, и это нормальный fallback.
      providerErrors += 1;
      codes.push(`provider:${provider.descriptor.id}:${error instanceof Error ? error.message.slice(0, 120) : "unknown"}`);
      continue;
    }

    results += output.results.length;

    for (const result of output.results) {
      const classified = classifyResult({
        url: result.url,
        provider: provider.descriptor.id,
        title: result.title ?? null,
        snippet: result.snippet ?? null,
        query: queryText,
        position: result.position ?? null,
        method: "search",
        intent,
        knownDomains: context.profile.knownDomains,
        knownSocialLinks: context.profile.knownSocialLinks,
      });
      if (!classified.ok) continue;

      const persisted = await persistCandidate(db, {
        businessId: action.business_id,
        runId: action.run_id,
        entityId: context.entityId,
        classified: classified.candidate,
        profile: context.profile,
        provider: provider.descriptor.id,
        query: queryText,
        position: result.position ?? null,
      });
      if (persisted.status !== "accepted") continue;
      if (persisted.duplicate) duplicates += 1;

      const sourceId = await ensureSource(db, {
        entityId: context.entityId,
        classified: classified.candidate,
        provider: provider.descriptor.id,
        autoAccepted: true,
        confidence: persisted.score,
      });
      await attachCandidateSource(db, {
        candidateId: persisted.id,
        sourceId,
        entityId: context.entityId,
      });
      await ensureObservation(db, {
        businessId: action.business_id,
        entityId: context.entityId,
        sourceId,
        observed: {
          title: classified.candidate.title,
          snippet: classified.candidate.snippet,
          url: classified.candidate.normalizedUrl,
          provider: provider.descriptor.id,
          method: "search",
          kind: "search_result",
        },
      });

      // persistCandidate уже знает, был ли кандидат новым: повторный URL
      // помечается duplicate. Иначе ветка выглядела бы продуктивной впустую.
      if (persisted.isNew) newSources += 1;
    }

    // Провайдер ответил — фиксируем доступность «зелёной» не нужно:
    // доступность пишется по факту загрузки источника, а не поиска.
  }

  // ── Enrichment ─────────────────────────────────────────────────────────
  // Наблюдения сами по себе не являются фактами: факты выделяет Stage 4.
  // Без постановки в очередь enrichment наблюдения этого действия так и
  // остались бы сырыми данными — feedback loop не получил бы ничего и
  // цикл фактически не был бы замкнут.
  if (newSources > 0) {
    try {
      await enqueueEnrichment(db, {
        businessId: action.business_id,
        discoveryRunId: action.run_id,
      });
    } catch (error) {
      // Отказ постановки не должен отменять уже сохранённые наблюдения,
      // но обязан быть виден: иначе потеря знания выглядит как «нового
      // ничего не найдено».
      log("error", "OSINT_AGENT_ENRICHMENT_ENQUEUE_FAILED", {
        action_id: action.id,
        run_id: action.run_id,
        error:
          error instanceof Error
            ? `${error.name}: ${error.message}`.replace(/\s+/g, " ").slice(0, 300)
            : String(error).slice(0, 300),
      });
    }
  }

  // ── Исход ──────────────────────────────────────────────────────────────
  if (results === 0) {
    if (providerErrors > 0) {
      // Все провайдеры упали. Это временная или постоянная ошибка —
      // решает классификация, а не наш оптимизм.
      const decision = decideFallback("transport_error");
      return finish(
        "error",
        "failed",
        decision.retrySource,
        "Поиск завершился ошибкой провайдера",
        { results: 0, newSources: 0 },
      );
    }
    return finish(
      "empty",
      "done",
      false,
      "Запрос выполнен, подходящих источников не найдено",
      { results: 0, newSources: 0 },
    );
  }

  if (newSources === 0) {
    return finish(
      "duplicate",
      "done",
      false,
      duplicates > 0
        ? "Выдача совпала с уже известными источниками — новое знание не получено"
        : "Новых источников нет",
      { results, newSources: 0 },
    );
  }

  return finish("productive", "done", false, "Найдены новые источники", {
    results,
    newSources,
  });
}

/**
 * Классифицирует исход загрузки страницы и записывает доступность источника.
 *
 * Вынесено отдельно, потому что crawl-фаза отвечает за ДРУГОЕ: она обходит
 * уже найденные URL, а здесь мы фиксируем, что конкретный источник
 * недоступен, чтобы не упираться в него снова.
 */
export async function noteSourceFetchOutcome(
  db: Kysely<Database>,
  input: {
    sourceId: string;
    httpStatus?: number | null;
    fetchReason?: string | null;
    challengeDetected?: boolean;
  },
): Promise<{ status: OsintSourceAccessStatus; outcome: OsintResearchOutcome }> {
  const reason = classifyBlockedReason({
    httpStatus: input.httpStatus ?? null,
    fetchReason: input.fetchReason ?? null,
    challengeDetected: input.challengeDetected ?? false,
  });
  if (!reason) {
    await recordSourceAccess(db, {
      sourceId: input.sourceId,
      status: "accessible",
      httpStatus: input.httpStatus ?? null,
    });
    return { status: "accessible", outcome: "productive" };
  }
  const decision = decideFallback(reason);
  await recordSourceAccess(db, {
    sourceId: input.sourceId,
    status: accessStatusFor(reason),
    detail: decision.reason,
    httpStatus: input.httpStatus ?? null,
    statusCode: reason,
  });
  return { status: accessStatusFor(reason), outcome: decision.retrySource ? "error" : "blocked" };
}

/** Статус доступности берётся из той же таксономии, что и fallback-решение. */
function accessStatusFor(reason: string): OsintSourceAccessStatus {
  return (
    ACCESS_STATUS_BY_REASON[reason as keyof typeof ACCESS_STATUS_BY_REASON] ??
    "transport_error"
  );
}

/** Завершает действие, записывая след для аудита. */
export async function finalizeAction(
  db: Kysely<Database>,
  actionId: string,
  result: ActionExecutionResult,
  counts: { newFacts?: number; newEntities?: number } = {},
): Promise<void> {
  await completeAction(db, {
    actionId,
    status: result.status,
    outcome: result.outcome,
    results: result.results,
    newSources: result.newSources,
    newFacts: counts.newFacts ?? 0,
    newEntities: counts.newEntities ?? 0,
    error: result.codes.length > 0 ? result.codes.join("; ").slice(0, 500) : null,
  });
}
