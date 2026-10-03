/**
 * Таксономия недоступности источника и стратегия обхода (§11, §12, §38).
 *
 * Главное правило: блокировка источника — это НЕ провал исследования.
 * 2ГИС заблокировал робота — это состояние одного источника, а не «Research
 * failed». Из него следует ровно одно действие: сменить маршрут.
 *
 * Чего здесь нет и не будет: обхода CAPTCHA, подмены отпечатков, прокси для
 * обхода защиты, неуважения к robots.txt и rate limits. При появлении
 * CAPTCHA это нормальный исход попытки — мы просто идём другой веткой.
 */

import type { OsintSourceAccessStatus } from "../schema.ts";

export type BlockedReason =
  | "http_403"
  | "http_404"
  | "http_429"
  | "http_5xx"
  | "robots_disallowed"
  | "captcha"
  | "requires_auth"
  | "timeout"
  | "dns_failed"
  | "private_address"
  | "redirect_limit"
  | "unsupported_content_type"
  | "transport_error";

/** Человекочитаемое объяснение. Технические коды остаются в логах. */
const REASON_LABELS: Record<BlockedReason, string> = {
  http_403: "Источник запретил автоматический сбор",
  http_404: "Страница больше не существует",
  http_429: "Источник временно ограничил частоту запросов",
  http_5xx: "Источник временно недоступен",
  robots_disallowed: "Источник запретил сбор этих страниц",
  captcha: "Источник требует проверки человеком",
  requires_auth: "Источник доступен только после входа",
  timeout: "Источник не ответил вовремя",
  dns_failed: "Не удалось определить адрес источника",
  private_address: "Адрес источника указывает во внутреннюю сеть",
  redirect_limit: "Источник ведёт в бесконечное перенаправление",
  unsupported_content_type: "Источник вернул неподдерживаемый формат",
  transport_error: "Соединение с источником не удалось",
};

/**
 * Статус источника в таксономии osint_source_access.
 *
 * Разделяем «нас ждут» (captcha/403) и «нас не ждут, но вернёмся»
 * (rate_limited/timeout) — от этого зависит, пробовать ли ветку снова.
 */
export const ACCESS_STATUS_BY_REASON: Record<
  BlockedReason,
  OsintSourceAccessStatus
> = {
  http_403: "blocked",
  http_404: "not_found",
  http_429: "rate_limited",
  http_5xx: "transport_error",
  robots_disallowed: "robots_disallowed",
  captcha: "blocked",
  requires_auth: "requires_auth",
  timeout: "timeout",
  dns_failed: "transport_error",
  // Приватный адрес — это не блокировка сайта, а отказ нашей SSRF-защиты.
  // Отмечаем как transport_error, но НЕ пытаемся обойти.
  private_address: "transport_error",
  redirect_limit: "transport_error",
  unsupported_content_type: "unsupported_content",
  transport_error: "transport_error",
};

/**
 * Повторная попытка оправдана только для временных исходов. Для captcha,
 * 403 и требования авторизации повтор НЕ имеет смысла: состояние не изменится
 * само, а бюджет исследования уйдёт впустую.
 */
const RETRYABLE: ReadonlySet<BlockedReason> = new Set([
  "http_429",
  "http_5xx",
  "timeout",
  "dns_failed",
  "transport_error",
]);

export function isRetryableReason(reason: BlockedReason): boolean {
  return RETRYABLE.has(reason);
}

/** Человекочитаемое объяснение без технических кодов. */
export function blockedReasonLabel(reason: BlockedReason): string {
  return REASON_LABELS[reason];
}

/**
 * Классифицирует исход попытки. Принимает то, что реально вернул fetcher,
 * и сводит к нашей таксономии — раньше всё схлопывалось в `http_error`,
 * из-за чего агент не мог отличить «смени маршрут» от «повтори позже».
 */
export function classifyBlockedReason(input: {
  /** Статус HTTP, если ответ был. */
  httpStatus?: number | null;
  /** Причина от safe-fetch, если до ответа не дошли. */
  fetchReason?: string | null;
  /** Признак защитного барьера в теле ответа. */
  challengeDetected?: boolean;
}): BlockedReason | null {
  if (input.challengeDetected) return "captcha";
  const status = input.httpStatus ?? null;
  if (status === 403) return "http_403";
  if (status === 404) return "http_404";
  if (status === 429) return "http_429";
  if (status !== null && status >= 500) return "http_5xx";
  const reason = (input.fetchReason ?? "").trim();
  if (reason === "robots_disallowed") return "robots_disallowed";
  if (reason === "timeout" || reason === "aborted") return "timeout";
  if (reason === "dns_failed") return "dns_failed";
  if (reason === "private_address") return "private_address";
  if (reason === "redirect_limit") return "redirect_limit";
  if (reason === "unsupported_content_type") return "unsupported_content_type";
  if (reason === "http_error") return "http_5xx";
  if (reason === "transport_error") return "transport_error";
  if (reason) return "transport_error";
  return null;
}

/* ------------------------------------------------------------------ */
/* Стратегия обхода (§11)                                              */
/* ------------------------------------------------------------------ */

export type FallbackDecision = {
  /** Повторять ли этот источник позже. */
  retrySource: boolean;
  /** Нужно ли менять направление поиска. */
  changeStrategy: boolean;
  /** Чем заменить: иной класс запроса, иной идентификатор, иной источник. */
  alternative: "other_source" | "other_identifier" | "other_purpose" | "none";
  /** Пояснение для пользователя и для audit. */
  reason: string;
};

/**
 * Решает, что делать после неудачной попытки.
 *
 * Инвариант: ни одна комбинация не приводит к остановке всего исследования.
 * Единственный исход, при котором исследование падает, — исчерпание бюджета,
 * и это решение принимает планировщик, а не обработчик ошибки источника.
 */
export function decideFallback(reason: BlockedReason): FallbackDecision {
  switch (reason) {
    case "robots_disallowed":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_source",
        reason: "Источник запретил сбор — ищем тот же факт в другом месте",
      };
    case "captcha":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_source",
        reason:
          "Источник требует проверки человеком — ищем тот же факт через другой источник",
      };
    case "http_403":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_source",
        reason: "Источник закрыт для автоматического сбора — ищем в другом месте",
      };
    case "requires_auth":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_identifier",
        reason:
          "Источник доступен только после входа — пробуем опознать бизнес по другому идентификатору",
      };
    case "http_429":
    case "http_5xx":
    case "timeout":
    case "dns_failed":
    case "transport_error":
      return {
        retrySource: true,
        changeStrategy: true,
        alternative: "other_source",
        reason: "Источник временно недоступен — пробуем другой, вернёмся позже",
      };
    case "http_404":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_purpose",
        reason: "Страница не существует — уточняем запрос",
      };
    case "private_address":
    case "redirect_limit":
    case "unsupported_content_type":
      return {
        retrySource: false,
        changeStrategy: true,
        alternative: "other_source",
        reason: "Источник недоступен для безопасного сбора — ищем другой",
      };
  }
}
