/**
 * Все тюнинговые константы OSINT-разведки в одном месте.
 * Никаких «магических чисел» в domain-коде: каждый коэффициент объясним
 * и меняется только здесь (и покрывается тестами).
 */

/** Веса признаков принадлежности candidate конкретному бизнесу (см. docs/OSINT_ARCHITECTURE.md §12). */
export type MatchWeights = {
  /** Телефон совпал точно (нормализованные цифры равны). */
  phone: number;
  /** Регистрируемый домен совпал с website/knownDomains. */
  domain: number;
  /** Адрес (улица+дом) найден в тексте candidate. */
  address: number;
  /** Город найден в тексте candidate. */
  city: number;
  /** Сходство названия (0..1) — вклад = weight * ratio. */
  name: number;
  /** Категория/отрасль найдена в тексте candidate. */
  category: number;
  /** Известная соцссылка (vk.com/…, t.me/…) совпала с URL candidate. */
  social: number;
};

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  phone: 0.4,
  domain: 0.3,
  address: 0.15,
  city: 0.05,
  name: 0.1,
  category: 0.05,
  social: 0.1,
};

/**
 * score = matchedWeight / applicableWeight (нормализация 0..1).
 * applicable = признаки, где профиль содержит значение, а у candidate есть
 * текст/URL для проверки. Поэтому score объясним, а не «магический».
 */
export type MatchThresholds = {
  /** Нужен хотя бы один осмысленный признак. */
  candidateMinScore: number;
  /** Название считается совпавшим при nameSimilarity ≥ этого значения. */
  nameMatchMinRatio: number;
  /** Телефон + (название ≥ minNameRatio ИЛИ город) → auto-accept. */
  phoneAutoAcceptMinNameRatio: number;
  /** Максимальная длина текста candidate, участвующего в сравнении. */
  maxCompareTextLength: number;
};

export const DEFAULT_MATCH_THRESHOLDS: MatchThresholds = {
  candidateMinScore: 0.1,
  nameMatchMinRatio: 0.5,
  phoneAutoAcceptMinNameRatio: 0.7,
  maxCompareTextLength: 4000,
};

/**
 * Явные правила auto-accept (§14: слабые совпадения НЕ принимаются сами).
 * Порядок правил — приоритет; первое сработавшее решает исход.
 */
export type AutoAcceptRuleId = "domain_exact" | "phone_plus_identity";

export const AUTO_ACCEPT_RULES: readonly AutoAcceptRuleId[] = [
  "domain_exact",
  "phone_plus_identity",
];

/** Лимиты одного discovery job (§19) и traversal графа (§21-§23). */
export type DiscoveryBudget = {
  maxQueries: number;
  maxSearchResults: number;
  maxCandidates: number;
  maxPages: number;
  maxTotalBytes: number;
  maxDurationMs: number;
  /** Максимальная глубина обхода графа (0 = только корневая сущность). */
  maxDepth: number;
  /** Лимиты traversal (§23) — считаем по факту, а не по времени. */
  maxEntities: number;
  maxSources: number;
  maxObservations: number;
  maxRequests: number;
  /** Параллельные загрузки в crawl-фазе (§25). */
  maxConcurrency: number;
  /** Сколько ссылок страницы можно ставить в очередь. */
  maxLinksPerPage: number;
};

export const DEFAULT_DISCOVERY_BUDGET: DiscoveryBudget = {
  maxQueries: 12,
  maxSearchResults: 50,
  maxCandidates: 30,
  // Depth 0/1 для website discovery приходят позже (Этапы 5+).
  maxPages: 5,
  maxTotalBytes: 2_000_000,
  maxDurationMs: 30_000,
  maxDepth: 2,
  maxEntities: 50,
  maxSources: 40,
  maxObservations: 200,
  maxRequests: 40,
  maxConcurrency: 4,
  maxLinksPerPage: 50,
};

/** Жёсткие верхние границы — клиентский бюджет только сжимается (§25). */
const BUDGET_CAPS: Record<keyof DiscoveryBudget, { min: number; max: number }> = {
  maxQueries: { min: 1, max: 50 },
  maxSearchResults: { min: 1, max: 200 },
  maxCandidates: { min: 1, max: 100 },
  maxPages: { min: 1, max: 50 },
  maxTotalBytes: { min: 10_000, max: 5_000_000 },
  maxDurationMs: { min: 1_000, max: 120_000 },
  maxDepth: { min: 0, max: 5 },
  maxEntities: { min: 1, max: 200 },
  maxSources: { min: 1, max: 100 },
  maxObservations: { min: 1, max: 400 },
  maxRequests: { min: 1, max: 100 },
  maxConcurrency: { min: 1, max: 8 },
  maxLinksPerPage: { min: 1, max: 200 },
};

function clampInt(value: unknown, fallback: number, cap: { min: number; max: number }): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const int = Math.trunc(parsed);
  return Math.min(cap.max, Math.max(cap.min, int));
}

/**
 * Нормализует бюджет из недоверенного источника (HTTP body, jsonb run'а):
 * каждое поле — целое в пределах [min, max], неизвестное/битое — дефолт.
 * Только ужесточение: поднять лимиты выше капов нельзя.
 */
export function mergeDiscoveryBudget(raw: unknown): DiscoveryBudget {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const result = {} as DiscoveryBudget;
  for (const key of Object.keys(BUDGET_CAPS) as (keyof DiscoveryBudget)[]) {
    result[key] = clampInt(input[key], DEFAULT_DISCOVERY_BUDGET[key], BUDGET_CAPS[key]);
  }
  return result;
}

/**
 * Порядок попыток для traversal (§24). Официальный сайт надёжнее директории,
 * директория надёжнее чужого упоминания — приоритет фиксирован конфигом.
 */
export const TRAVERSAL_PRIORITY = [
  "official_website",
  "official_social",
  "maps_and_directories",
  "reviews",
  "public_mentions",
] as const;

export type TraversalPriorityTier = (typeof TRAVERSAL_PRIORITY)[number];

/** К какому tier'у отнести тип источника при обходе (§24). */
export function priorityTierFor(type: string): TraversalPriorityTier {
  switch (type) {
    case "website":
      return "official_website";
    case "social_network":
      return "official_social";
    case "maps":
    case "directory":
    case "public_registry":
      return "maps_and_directories";
    case "review_platform":
      return "reviews";
    default:
      return "public_mentions";
  }
}

/** Через сколько «зависший» run считается упавшим (аналог expireClaims). */
export const STALE_DISCOVERY_RUN_MS = 15 * 60_000;

/** Шаблоны поисковых запросов. Конфигурируемы — не зашиты в генератор. */
export type DiscoveryIntent =
  | "any"
  | "website"
  | "reviews"
  | "maps"
  | "social"
  | "identity"
  | "mentions";

export type QueryTemplate = {
  id: string;
  template: string;
  intents: DiscoveryIntent[];
};

/**
 * `{name}` обязателен, остальные плейсхолдеры подставляются только при
 * наличии значения: шаблон с отсутствующим плейсхолдером пропускается.
 */
export const DEFAULT_QUERY_TEMPLATES: readonly QueryTemplate[] = [
  { id: "name_city", template: "{name} {city}", intents: ["any"] },
  { id: "name", template: "{name}", intents: ["any"] },
  {
    id: "name_city_reviews",
    template: "{name} {city} отзывы",
    intents: ["reviews"],
  },
  { id: "name_reviews", template: "{name} отзывы", intents: ["reviews"] },
  {
    id: "name_city_official_site",
    template: "{name} {city} официальный сайт",
    intents: ["website"],
  },
  {
    id: "name_official_site",
    template: "{name} официальный сайт",
    intents: ["website"],
  },
  {
    id: "name_city_phone",
    template: "{name} {city} телефон",
    intents: ["identity"],
  },
  {
    id: "name_city_address",
    template: "{name} {city} адрес",
    intents: ["identity"],
  },
  {
    id: "name_city_2gis",
    template: "{name} {city} 2ГИС",
    intents: ["maps"],
  },
  {
    id: "name_city_yandex_maps",
    template: "{name} {city} Яндекс Карты",
    intents: ["maps"],
  },
  { id: "name_city_vk", template: "{name} {city} ВКонтакте", intents: ["social"] },
  {
    id: "name_category_city",
    template: "{name} {category} {city}",
    intents: ["any"],
  },
  { id: "phone_only", template: "{phone}", intents: ["identity"] },
  { id: "name_domain", template: "{name} {domain}", intents: ["website"] },
  {
    id: "name_region",
    template: "{name} {city} {region}",
    intents: ["any"],
  },
];

/** Максимум результатов, которые один provider может вернуть на запрос. */
export const DEFAULT_SEARCH_LIMIT = 10;
