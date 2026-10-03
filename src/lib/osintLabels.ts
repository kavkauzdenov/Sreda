/**
 * Human-readable OSINT labels (client side).
 *
 * The domain layer deliberately returns stable technical codes — `vk`,
 * `osint_vk_token_missing`, `official_api`, `no_page_provider_available` and so
 * on. Those codes are the contract for tests, logs and admin diagnostics, so they
 * must NOT be rewritten at the source (see `providers/vk.ts`, `providers/registry.ts`,
 * `osint/discovery.ts`). This module is the single place where a code is translated
 * for a customer, following the existing `src/lib/labels.ts` + `leadStatus.ts`
 * convention.
 *
 * Rules encoded here:
 *  - a user never sees an enum value, an adapter id or a policy name;
 *  - a not-configured integration is described as "not configured", never as an error;
 *  - a failure is never disguised as success — the status stays truthful, only the
 *    wording becomes human;
 *  - an unmapped code degrades to a neutral phrase instead of leaking the raw value.
 *
 * Diagnostics keep the raw code: `providerDiagnostic()` is for admin surfaces and
 * `osintRunErrorDetail()` for structured logs, never for the customer view.
 */

export const OSINT_PROVIDER_LABELS: Record<string, string> = {
  own_urls: "Ваши сайты",
  vk: "ВКонтакте",
  web_page: "Страницы сайтов",
};

export function osintProviderLabel(id: string, fallback?: string | null): string {
  return OSINT_PROVIDER_LABELS[id] ?? fallback?.trim() ?? "Источник";
}

/** `policy` explains *how* we read a source — an implementation detail, never shown. */
export function osintProviderRoleLabel(role: "search" | "crawl"): string {
  return role === "search" ? "поиск" : "обход страниц";
}

export type OsintSourceState = "ready" | "not_configured" | "error" | "paused" | "disabled";

export type OsintSourcePresentation = {
  state: OsintSourceState;
  /** Short status, e.g. «Готов к работе». */
  label: string;
  /** One-line explanation shown under the label. Empty when there is nothing to add. */
  detail: string;
};

/**
 * Translate a provider availability into customer-facing copy.
 *
 * `reason` is the raw technical code from the domain layer. Known codes get a
 * precise, honest explanation; unknown codes get a neutral "not configured" so a
 * new internal code can never surface in the UI.
 */
export function osintProviderState(input: {
  available: boolean;
  reason?: string | null;
  policy?: string | null;
}): OsintSourcePresentation {
  if (input.available) {
    return {
      state: "ready",
      label: "Готов к работе",
      detail:
        input.policy === "official_api"
          ? "Ищет упоминания через официальный API."
          : input.policy === "public_web"
            ? "Читает открытые страницы сайта."
            : "Использует данные, которые вы указали сами.",
    };
  }
  const reason = input.reason ?? "";
  if (reason === "osint_vk_token_missing" || reason === "provider_not_configured") {
    return {
      state: "not_configured",
      label: "Интеграция не настроена",
      detail: "Поиск в этой социальной сети не запущен — остальные источники работают.",
    };
  }
  if (reason === "no_page_provider_available") {
    return {
      state: "not_configured",
      label: "Источник недоступен",
      detail: "Для этого запуска нет подходящего источника данных.",
    };
  }
  return {
    state: "not_configured",
    label: "Источник недоступен",
    detail: "Источник не используется в этом запуске.",
  };
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  website: "Сайт",
  search: "Поисковая выдача",
  maps: "Карты",
  review_platform: "Отзывы",
  social_network: "Социальная сеть",
  directory: "Каталог",
  news: "Новости",
  public_registry: "Открытый реестр",
  other: "Другое",
};

export function osintSourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? "Источник";
}

const TRUST_LABELS: Record<string, string> = {
  official: "Официальный",
  public_directory: "Открытый каталог",
  review_platform: "Площадка отзывов",
  search_result: "Найдено в поиске",
  third_party: "Сторонний",
};

export function osintTrustLabel(level: string): string {
  return TRUST_LABELS[level] ?? "Сторонний";
}

const SOURCE_STATUS_LABELS: Record<string, string> = {
  active: "Работает",
  paused: "Приостановлен",
  error: "Ошибка сбора",
  disabled: "Отключён",
};

export function osintSourceStatusLabel(status: string): string {
  return SOURCE_STATUS_LABELS[status] ?? "Неизвестное состояние";
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  OWNER: "Владелец",
  PUBLISHED_BY: "Публиковал",
  MENTIONS: "Упоминает",
  ABOUT: "Сведён с",
  PARTNER: "Партнёр",
  CLIENT: "Клиент",
  COMPETITOR: "Конкурент",
  LOCATION: "Локация",
  EMPLOYER: "Работодатель",
  SPONSOR: "Спонсор",
  SUPPLIER: "Поставщик",
  CUSTOMER: "Поставщик",
  RELATED_TO: "Связан с",
};

export function osintRelationshipLabel(relationship: string): string {
  return RELATIONSHIP_LABELS[relationship] ?? "Связан с";
}

const BRIDGE_STATUS_LABELS: Record<string, string> = {
  candidate: "кандидат",
  linked: "подтверждено",
  rejected: "отклонено",
};

export function osintBridgeStatusLabel(status: string): string {
  return BRIDGE_STATUS_LABELS[status] ?? "на проверке";
}

/**
 * Summarise a discovery run for the customer.
 *
 * `osint_discovery_runs.error` is a `;`-joined list of internal codes
 * (`no_providers_available`, `duration_budget_exhausted`,
 * `provider:vk:vk_api_error:…`, `crawl:<url>:private_address`, …). We map the
 * ones with a stable user meaning and fall back to a neutral phrase, never echoing
 * the raw string.
 */
export function osintRunErrorSummary(error: string | null | undefined): string {
  if (!error) return "";
  const parts = error
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";

  const notes: string[] = [];
  const has = (code: string) => parts.some((part) => part === code || part.startsWith(code));
  const providerErrors = parts.filter((part) => part.startsWith("provider:"));

  if (has("no_providers_available")) {
    notes.push("не нашлось источников для поиска");
  } else if (has("no_page_provider_available")) {
    notes.push("не удалось прочитать страницы сайта");
  } else if (has("no_queries_generated")) {
    notes.push("не удалось составить поисковые запросы");
  }
  if (providerErrors.length > 0) {
    notes.push("один из источников ответил ошибкой — остальные отработали");
  }
  if (has("duration_budget_exhausted")) {
    notes.push("сбор остановлен по времени");
  }
  if (has("results_budget_exhausted")) {
    notes.push("сбор остановлен по лимиту результатов");
  }
  if (has("aborted_by_caller")) {
    notes.push("сбор прерван");
  }
  if (has("stale_run_expired")) {
    notes.push("сбор завершился по истечении срока");
  }
  const blocked = parts.filter(
    (part) => part.includes("robots_disallowed") || part.includes("private_address"),
  );
  if (blocked.length > 0 && notes.length === 0) {
    notes.push("часть страниц пропущена: сайт запрещает автоматический сбор или недоступен из сети");
  }

  if (notes.length === 0) {
    return "Сбор завершился с ограничениями — часть источников не ответила.";
  }
  const unique = [...new Set(notes)];
  const head = "Сбор завершился с ограничениями";
  return unique.length === 1 ? `${head}: ${unique[0]}.` : `${head}: ${unique.slice(0, 3).join("; ")}.`;
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: "В очереди",
  running: "Выполняется",
  completed: "Готово",
  partial: "Частично",
  failed: "Ошибка",
};

export function osintRunStatusLabel(status: string): string {
  return RUN_STATUS_LABELS[status] ?? "Неизвестное состояние";
}

/**
 * Diagnostics-only view of a provider failure.
 *
 * Returns the raw code so an administrator can pinpoint the failing layer. Never
 * render this in a customer-facing surface, and never log the provider token or
 * any secret alongside it.
 */
export function providerDiagnostic(
  providerId: string,
  reason: string | null | undefined,
): { provider: string; code: string | null; human: string } {
  return {
    provider: OSINT_PROVIDER_LABELS[providerId] ?? providerId,
    code: reason ?? null,
    human: osintProviderState({ available: false, reason }).label,
  };
}

/**
 * Structured-log detail for a discovery run: the raw code list plus the human
 * summary, so logs keep precision while the UI stays readable.
 */
export function osintRunErrorDetail(error: string | null | undefined): {
  codes: string[];
  human: string;
} {
  const codes = (error ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  return { codes, human: osintRunErrorSummary(error) };
}