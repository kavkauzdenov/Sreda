/**
 * Паспорт OSINT-исследования (research brief, §2 задачи Stage 4).
 *
 * Детерминированная конфигурация запуска: идентификация бизнеса, цели,
 * ограничения, seed-URL и свободный текст. Никакого LLM — цели жёстко
 * сопоставлены с типами источников, интентами запросов и извлекаемыми
 * типами фактов, а уровень поддержки вычисляется из РЕАЛЬНОГО реестра
 * провайдеров этого окружения. Модуль не трогает БД и сеть: только
 * валидация, санитизация и построение плана.
 */
import { AppError } from "../../http/errors.ts";
import type { DiscoveryBudget, DiscoveryIntent } from "./config.ts";
import {
  DEFAULT_DISCOVERY_BUDGET,
  DEFAULT_QUERY_TEMPLATES,
  mergeDiscoveryBudget,
} from "./config.ts";
import type { DiscoveryProfile } from "./profile.ts";
import { buildDiscoveryQueries, type GeneratedQuery } from "./queries.ts";
import type { ProviderRegistry } from "./providers/registry.ts";
import type { OsintSourceType } from "./schema.ts";
import { isUrlExcluded, normalizeUrl, registrableDomain } from "./url.ts";

export const PASSPORT_FORMAT_VERSION = 1;

/** Жёсткие лимиты полей — безопасные длины из спецификации §2.4. */
export const PASSPORT_LIMITS = {
  displayName: 200,
  legalName: 200,
  alias: 120,
  aliases: 20,
  category: 120,
  geo: 120,
  address: 300,
  urls: 30,
  domains: 20,
  phones: 20,
  emails: 20,
  note: 1000,
  phrase: 120,
  phrases: 20,
} as const;

export type PassportUrlRole =
  | "official"
  | "confirmed"
  | "candidate"
  | "excluded";

export type PassportUrl = { url: string; role: PassportUrlRole };

export const GOAL_IDS = [
  "reviews",
  "services_goods",
  "prices",
  "contacts",
  "website_changes",
  "news_mentions",
  "social_activity",
  "competitors",
  "new_sources",
  "custom_task",
] as const;
export type GoalId = (typeof GOAL_IDS)[number];

export type PassportIdentification = {
  displayName: string;
  legalName: string | null;
  aliases: string[];
  category: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  address: string | null;
  urls: PassportUrl[];
  domains: string[];
  phones: string[];
  emails: string[];
  notes: string | null;
};

export type PassportGoals = {
  selected: GoalId[];
  importantNotes: string | null;
  excludeNotes: string | null;
  geoLimits: string | null;
  searchPhrases: string[];
};

export type PassportContent = {
  formatVersion: typeof PASSPORT_FORMAT_VERSION;
  identification: PassportIdentification;
  goals: PassportGoals;
};

/** Статическая часть каталога целей — подписи и ожидаемые результаты. */
export type GoalDescriptor = {
  id: GoalId;
  label: string;
  description: string;
  outcome: string;
  sourceTypes: OsintSourceType[];
  intents: DiscoveryIntent[];
  /** Факты, которые реально извлекает v1 ради этой цели. */
  extracts: string[];
};

export const GOAL_CATALOG: readonly GoalDescriptor[] = [
  {
    id: "reviews",
    label: "Отзывы, оценки и жалобы",
    description: "Найти страницы с отзывами и публичные упоминания о бизнесе.",
    outcome: "Источники-площадки с отзывами, упоминания, факты из текстов.",
    sourceTypes: ["review_platform", "directory", "other"],
    intents: ["reviews"],
    extracts: [],
  },
  {
    id: "services_goods",
    label: "Услуги и товары",
    description: "Какие услуги и товары бизнес предлагает.",
    outcome: "Факты о перечне услуг и товаров.",
    sourceTypes: ["website"],
    intents: ["website"],
    extracts: [],
  },
  {
    id: "prices",
    label: "Цены и условия",
    description: "Цены, тарифы и условия работы.",
    outcome: "Факты о ценах и условиях.",
    sourceTypes: ["website", "directory"],
    intents: ["website"],
    extracts: [],
  },
  {
    id: "contacts",
    label: "Контакты, адреса и часы работы",
    description: "Телефоны, почта, адреса и география бизнеса.",
    outcome: "Факты phone/email/address/city с провенансом.",
    sourceTypes: ["website", "social_network", "directory"],
    intents: ["identity", "any"],
    extracts: ["phone", "email", "address", "city", "region", "country"],
  },
  {
    id: "website_changes",
    label: "Изменения сайта и публичных страниц",
    description: "Следить за изменениями на известных страницах бизнеса.",
    outcome: "История изменений фактов (VALUE_CHANGED / DISAPPEARED).",
    sourceTypes: ["website", "social_network"],
    intents: ["website", "any"],
    extracts: ["website", "domain"],
  },
  {
    id: "news_mentions",
    label: "Новости и публичные упоминания",
    description: "Новости и статьи, где упоминается бизнес.",
    outcome: "Новостные источники и упоминания.",
    sourceTypes: ["news", "other"],
    intents: ["mentions"],
    extracts: [],
  },
  {
    id: "social_activity",
    label: "Публичная активность в соцсетях",
    description: "Официальные публичные сообщества и страницы.",
    outcome: "Социальные источники и факты о аккаунтах.",
    sourceTypes: ["social_network"],
    intents: ["social"],
    extracts: ["telegram", "vk", "instagram", "facebook", "youtube", "other_social"],
  },
  {
    id: "competitors",
    label: "Конкуренты и локальный рынок",
    description: "Похожие бизнесы в том же городе и нише.",
    outcome: "Источники конкурентов, отдельные сущности.",
    sourceTypes: ["directory", "maps", "search"],
    intents: ["maps", "any"],
    extracts: [],
  },
  {
    id: "new_sources",
    label: "Новые источники, каталоги и площадки",
    description: "Где ещё упоминается бизнес: каталоги и площадки.",
    outcome: "Новые кандидаты источников из обхода и ссылок.",
    sourceTypes: ["directory", "maps", "other"],
    intents: ["any"],
    extracts: [],
  },
  {
    id: "custom_task",
    label: "Исследовательская задача свободной формы",
    description: "Своей формулировкой уточнить, что именно искать.",
    outcome: "Фразы превращаются в поисковые запросы, текст хранится как задача.",
    sourceTypes: ["other"],
    intents: ["any"],
    extracts: [],
  },
];

export type GoalSupportLevel = "supported" | "partial" | "unsupported";

export type GoalRuntime = {
  id: GoalId;
  label: string;
  description: string;
  outcome: string;
  sourceTypes: OsintSourceType[];
  level: GoalSupportLevel;
  /** Причина неполной поддержки либо причина недоступности. */
  reason: string | null;
};

export type ResearchCapabilities = {
  search: { id: string; label: string; available: boolean; reason: string | null; policy: string }[];
  crawl: { id: string; label: string; available: boolean; reason: string | null }[];
  /** Есть ли подключённый поисковый индекс (policy "search_api"). */
  hasSearchApi: boolean;
  /** Есть ли доступный провайдер, обслуживающий интент social. */
  socialSearch: boolean;
  canCrawl: boolean;
};

/**
 * Уровни поддержки целей вычисляются из реестра: добавился search_api
 * провайдер — цели «подсветились» сами, без правки каталога.
 */
export function researchCapabilities(registry: ProviderRegistry): ResearchCapabilities {
  const infos = registry.descriptorInfo();
  const search = infos
    .filter((info) => info.descriptor.policy !== "public_web")
    .map((info) => ({
      id: info.descriptor.id,
      label: info.descriptor.label,
      available: info.availability.available && info.descriptor.policy !== "disabled",
      reason: info.availability.available
        ? info.descriptor.policy === "disabled"
          ? "провайдер отключён"
          : null
        : info.availability.reason ?? null,
      policy: info.descriptor.policy,
    }));
  const crawl = infos
    .filter((info) => info.descriptor.policy === "public_web")
    .map((info) => ({
      id: info.descriptor.id,
      label: info.descriptor.label,
      available: info.availability.available && info.descriptor.policy !== "disabled",
      reason: info.availability.available ? null : info.availability.reason ?? null,
    }));
  const availableSearch = infos.filter(
    (info) =>
      info.availability.available &&
      info.descriptor.policy !== "disabled" &&
      info.descriptor.policy !== "public_web",
  );
  return {
    search,
    crawl,
    hasSearchApi: availableSearch.some((info) => info.descriptor.policy === "search_api"),
    socialSearch: availableSearch.some((info) => info.descriptor.intents.includes("social")),
    canCrawl: crawl.some((entry) => entry.available),
  };
}

/** Провайдеры, которые реально обслуживают текст запроса (для preview). */
export function queryServingProviders(registry: ProviderRegistry): string[] {
  return registry
    .descriptorInfo()
    .filter(
      (info) =>
        info.availability.available &&
        info.descriptor.policy !== "disabled" &&
        info.descriptor.policy !== "public_web" &&
        info.descriptor.policy !== "structured_data" &&
        (info.descriptor.policy === "search_api" ||
          info.descriptor.policy === "official_api"),
    )
    .map((info) => info.descriptor.id);
}

export function goalLevel(
  goal: GoalDescriptor,
  caps: ResearchCapabilities,
): GoalRuntime {
  const base = {
    id: goal.id,
    label: goal.label,
    description: goal.description,
    outcome: goal.outcome,
    sourceTypes: goal.sourceTypes,
  };
  switch (goal.id) {
    case "reviews":
      return caps.hasSearchApi
        ? {
            ...base,
            level: "partial",
            reason:
              "Поиск найдёт площадки, но рейтинги не агрегируются — будут источники и упоминания.",
          }
        : {
            ...base,
            level: "unsupported",
            reason:
              "Нет подключённого поискового индекса — площадки отзывов не находятся.",
          };
    case "services_goods":
      return {
        ...base,
        level: "unsupported",
        reason:
          "Извлечение услуг и товаров не реализовано в v1 (нет закрытого словаря).",
      };
    case "prices":
      return {
        ...base,
        level: "unsupported",
        reason: "Детерминированного извлечения цен в v1 нет.",
      };
    case "contacts":
      return { ...base, level: "supported", reason: null };
    case "website_changes":
      return caps.canCrawl
        ? { ...base, level: "supported", reason: null }
        : {
            ...base,
            level: "unsupported",
            reason: "Нет доступного HTTP-провайдера страниц для обхода.",
          };
    case "news_mentions":
      return caps.hasSearchApi
        ? { ...base, level: "partial", reason: "Только найденные ссылки без агрегации." }
        : {
            ...base,
            level: "unsupported",
            reason: "Новостной поисковый индекс не подключён.",
          };
    case "social_activity":
      return caps.socialSearch
        ? {
            ...base,
            level: "partial",
            reason: "Официальный API ВКонтакте: только группы, без прочих сетей.",
          }
        : {
            ...base,
            level: "unsupported",
            reason:
              "Нет доступного провайдера соцсетей (нужен OSINT_VK_API_TOKEN).",
          };
    case "competitors":
      return caps.hasSearchApi
        ? { ...base, level: "partial", reason: "Поиск по нише и городу, без рейтингов." }
        : {
            ...base,
            level: "unsupported",
            reason: "Нет поискового индекса для локального рынка.",
          };
    case "new_sources":
      return caps.canCrawl
        ? {
            ...base,
            level: "partial",
            reason: "Только ссылки с уже известных страниц — широкий поиск недоступен.",
          }
        : {
            ...base,
            level: "unsupported",
            reason: "Нет доступного HTTP-провайдера страниц.",
          };
    case "custom_task":
      return caps.hasSearchApi || caps.socialSearch
        ? {
            ...base,
            level: "partial",
            reason:
              "Текст хранится как постановка, фразы становятся запросами — не как инструкция.",
          }
        : {
            ...base,
            level: "unsupported",
            reason: "Фразы некому обслужить: нет поисковых провайдеров.",
          };
    default:
      return { ...base, level: "unsupported", reason: "Неизвестная цель." };
  }
}

function bad(message: string): never {
  throw new AppError(400, "INVALID_PASSPORT", message);
}

function cleanText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") bad(`${field}: ожидается текст.`);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > max) bad(`${field}: не больше ${max} символов.`);
  return text;
}

function optionalText(value: unknown, max: number, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return cleanText(value, max, field) || null;
}

function cleanList(
  value: unknown,
  maxItems: number,
  maxLen: number,
  field: string,
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) bad(`${field}: ожидается список.`);
  if (value.length > maxItems) bad(`${field}: не больше ${maxItems} элементов.`);
  const out: string[] = [];
  for (const item of value) {
    const text = cleanText(item, maxLen, field);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function cleanUrl(value: unknown, field: string): { url: string; role: PassportUrlRole } {
  if (!value || typeof value !== "object") bad(`${field}: ожидается объект URL.`);
  const entry = value as { url?: unknown; role?: unknown };
  const normalized = normalizeUrl(typeof entry.url === "string" ? entry.url : "");
  if (!normalized.ok) bad(`${field}: некорректный URL (${normalized.reason}).`);
  if (normalized.url.length > 2048) bad(`${field}: URL длиннее 2048 символов.`);
  const roles: PassportUrlRole[] = ["official", "confirmed", "candidate", "excluded"];
  const role = roles.includes(entry.role as PassportUrlRole)
    ? (entry.role as PassportUrlRole)
    : "candidate";
  return { url: normalized.url, role };
}

/**
 * Строгая серверная валидация: на выходе — ровно известная форма,
 * лишние поля и мусор отбрасываются, длины и размеры ограничены.
 */
export function parsePassportContent(raw: unknown): PassportContent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    bad("Ожидается объект паспорта.");
  const source = raw as Record<string, unknown>;
  if (
    source.formatVersion !== undefined &&
    source.formatVersion !== PASSPORT_FORMAT_VERSION
  )
    bad(`Неподдерживаемая версия формата: ${String(source.formatVersion)}.`);

  const identRaw = (source.identification ?? {}) as Record<string, unknown>;
  const goalsRaw = (source.goals ?? {}) as Record<string, unknown>;

  const displayName = cleanText(identRaw.displayName ?? "", PASSPORT_LIMITS.displayName, "identification.displayName");
  const urls = Array.isArray(identRaw.urls) ? identRaw.urls : [];
  if (urls.length > PASSPORT_LIMITS.urls)
    bad(`identification.urls: не больше ${PASSPORT_LIMITS.urls} элементов.`);
  const parsedUrls = urls.map((entry, index) => cleanUrl(entry, `identification.urls[${index}]`));
  const dedupUrls: PassportUrl[] = [];
  for (const entry of parsedUrls) {
    const existing = dedupUrls.find((item) => item.url === entry.url);
    if (existing) {
      if (entry.role !== "candidate" && existing.role === "candidate")
        existing.role = entry.role;
      continue;
    }
    dedupUrls.push(entry);
  }

  const domains = cleanList(identRaw.domains, PASSPORT_LIMITS.domains, 253, "identification.domains")
    .map((domain) => domain.toLowerCase().replace(/^\./, ""))
    .filter((domain) => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain));
  for (const entry of dedupUrls) {
    if (entry.role === "excluded") continue;
    try {
      const domain = registrableDomain(new URL(entry.url).hostname);
      if (domain && !domains.includes(domain)) domains.push(domain);
    } catch {
      /* normalizeUrl уже прошёл — бренд-локус не достижим */
    }
  }
  if (domains.length > PASSPORT_LIMITS.domains)
    domains.length = PASSPORT_LIMITS.domains;

  const goalIds = new Set<string>(GOAL_IDS as readonly string[]);
  const selectedRaw = Array.isArray(goalsRaw.selected) ? goalsRaw.selected : [];
  const selected: GoalId[] = [];
  for (const id of selectedRaw) {
    if (typeof id !== "string" || !goalIds.has(id)) bad(`goals.selected: неизвестная цель "${String(id)}".`);
    if (!selected.includes(id as GoalId)) selected.push(id as GoalId);
  }

  const phrases = cleanList(goalsRaw.searchPhrases, PASSPORT_LIMITS.phrases, PASSPORT_LIMITS.phrase, "goals.searchPhrases");

  return {
    formatVersion: PASSPORT_FORMAT_VERSION,
    identification: {
      displayName,
      legalName: optionalText(identRaw.legalName, PASSPORT_LIMITS.legalName, "identification.legalName"),
      aliases: cleanList(identRaw.aliases, PASSPORT_LIMITS.aliases, PASSPORT_LIMITS.alias, "identification.aliases"),
      category: optionalText(identRaw.category, PASSPORT_LIMITS.category, "identification.category"),
      country: optionalText(identRaw.country, PASSPORT_LIMITS.geo, "identification.country"),
      region: optionalText(identRaw.region, PASSPORT_LIMITS.geo, "identification.region"),
      city: optionalText(identRaw.city, PASSPORT_LIMITS.geo, "identification.city"),
      address: optionalText(identRaw.address, PASSPORT_LIMITS.address, "identification.address"),
      urls: dedupUrls,
      domains,
      phones: cleanList(identRaw.phones, PASSPORT_LIMITS.phones, 32, "identification.phones"),
      emails: cleanList(identRaw.emails, PASSPORT_LIMITS.emails, 254, "identification.emails"),
      notes: optionalText(identRaw.notes, PASSPORT_LIMITS.note, "identification.notes"),
    },
    goals: {
      selected,
      importantNotes: optionalText(goalsRaw.importantNotes, PASSPORT_LIMITS.note, "goals.importantNotes"),
      excludeNotes: optionalText(goalsRaw.excludeNotes, PASSPORT_LIMITS.note, "goals.excludeNotes"),
      geoLimits: optionalText(goalsRaw.geoLimits, PASSPORT_LIMITS.note, "goals.geoLimits"),
      searchPhrases: phrases,
    },
  };
}

/**
 * Постисковый профиль из паспорта: исключённые URL в профиль не попадают,
 * официальные/подтверждённые важнее кандидатов. Поля бизнеса не копируются
 * молча — паспорт самодостаточен, prefill отдаётся отдельно.
 */
export function profileFromPassport(content: PassportContent): DiscoveryProfile {
  const ident = content.identification;
  const active = ident.urls.filter((entry) => entry.role !== "excluded");
  const priority: Record<PassportUrlRole, number> = {
    official: 3,
    confirmed: 2,
    candidate: 1,
    excluded: 0,
  };
  const ordered = [...active].sort((a, b) => priority[b.role] - priority[a.role]);
  const social = ordered.filter((entry) => isSocial(entry.url));
  const sites = ordered.filter((entry) => !isSocial(entry.url));

  const knownDomains = [...ident.domains];
  for (const entry of sites) {
    try {
      const domain = registrableDomain(new URL(entry.url).hostname);
      if (domain && !knownDomains.includes(domain)) knownDomains.push(domain);
    } catch {
      /* unreachable */
    }
  }

  return {
    businessName: ident.displayName,
    aliases: ident.aliases,
    category: ident.category,
    city: ident.city,
    region: ident.region,
    country: ident.country,
    phone: ident.phones[0] ?? null,
    phones: ident.phones,
    email: ident.emails[0] ?? null,
    website: sites[0]?.url ?? null,
    address: ident.address,
    knownDomains: knownDomains.slice(0, 20),
    knownSocialLinks: social.map((entry) => entry.url),
  };
}

const SOCIAL_HOSTS = [
  "vk.com", "vk.ru", "t.me", "telegram.me", "instagram.com",
  "facebook.com", "ok.ru", "youtube.com", "youtu.be", "x.com", "twitter.com",
];

function isSocial(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
  } catch {
    return false;
  }
}

/** Исключённые URL: по нормализованному URL и по регистрируемому домену. */
export function excludedIndex(content: PassportContent): {
  urls: string[];
  domains: string[];
} {
  const urls: string[] = [];
  const domains: string[] = [];
  for (const entry of content.identification.urls) {
    if (entry.role !== "excluded") continue;
    urls.push(entry.url);
    try {
      const domain = registrableDomain(new URL(entry.url).hostname);
      if (domain) domains.push(domain);
    } catch {
      /* unreachable */
    }
  }
  return { urls, domains };
}

/** Исключение URL как в url.ts — публичный алиас домена паспорта. */
export { isUrlExcluded as isExcludedUrl } from "./url.ts";

/**
 * Санитизация поисковых фраз: ≤120 символов, без control-символов,
 * не URL (URL — это seed, а не запрос). Отклонённые возвращаются списком.
 */
export function sanitizePhrases(raw: unknown): {
  phrases: string[];
  invalid: string[];
} {
  const list = Array.isArray(raw) ? raw : [];
  const phrases: string[] = [];
  const invalid: string[] = [];
  for (const item of list.slice(0, PASSPORT_LIMITS.phrases)) {
    if (typeof item !== "string") {
      invalid.push(String(item ?? "").slice(0, 200));
      continue;
    }
    const text = item.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length > PASSPORT_LIMITS.phrase) {
      invalid.push(item.slice(0, 200));
      continue;
    }
    if (normalizeUrl(text).ok) {
      invalid.push(text);
      continue;
    }
    if (!phrases.includes(text)) phrases.push(text);
  }
  return { phrases, invalid };
}

/** Фразы паспорта → детерминированные запросы (первыми, до шаблонов). */
export function phraseQueries(
  phrases: readonly string[],
  excluded: { urls: string[]; domains: string[] },
): GeneratedQuery[] {
  const out: GeneratedQuery[] = [];
  const lowerExcluded = [
    ...excluded.urls.map((url) => url.toLowerCase()),
    ...excluded.domains.map((domain) => domain.toLowerCase()),
  ];
  for (const phrase of phrases) {
    const lower = phrase.toLowerCase();
    if (lowerExcluded.some((entry) => entry && lower.includes(entry))) continue;
    out.push({ templateId: "passport_phrase", intent: "any", text: phrase });
  }
  return out;
}

/**
 * Итоговый список запросов запуска: фразы пользователя, затем шаблоны,
 * затем лимит бюджета. Один и тот же порядок в preview и в run'е.
 */
export function buildResearchQueries(
  profile: DiscoveryProfile,
  budget: Pick<DiscoveryBudget, "maxQueries">,
  phrases: readonly string[],
  excluded: { urls: string[]; domains: string[] },
): GeneratedQuery[] {
  const fromPhrases = phraseQueries(phrases, excluded);
  const fromTemplates = buildDiscoveryQueries(profile, budget, DEFAULT_QUERY_TEMPLATES);
  return [...fromPhrases, ...fromTemplates].slice(0, budget.maxQueries);
}

export type ResearchPlan = {
  goals: GoalRuntime[];
  identification: {
    displayName: string;
    hasOfficialUrl: boolean;
    urlCount: number;
    excludedCount: number;
    domains: string[];
  };
  providers: {
    id: string;
    label: string;
    role: "search" | "crawl";
    available: boolean;
    reason: string | null;
    willParticipate: boolean;
  }[];
  officialSources: PassportUrl[];
  extraUrls: PassportUrl[];
  excludedUrls: string[];
  queries: { text: string; templateId: string; intent: string; servedBy: string[] }[];
  ignoredPhrases: string[];
  phrases: string[];
  crawl: {
    enabled: boolean;
    maxDepth: number;
    maxPages: number;
    maxRequests: number;
    maxTotalBytes: number;
    maxDurationMs: number;
  };
  budget: DiscoveryBudget;
  unsupported: string[];
  needsConfirmation: { url: string }[];
  results: string[];
  timeHorizon: { supported: false; reason: string };
  geoLimits: string | null;
};

/** Предпросмотр плана — детерминирован, без БД и сети. */
export function buildResearchPlan(
  content: PassportContent,
  registry: ProviderRegistry,
  rawBudget?: unknown,
): ResearchPlan {
  const budget = rawBudget === undefined
    ? { ...DEFAULT_DISCOVERY_BUDGET }
    : mergeDiscoveryBudget(rawBudget);
  const caps = researchCapabilities(registry);
  const profile = profileFromPassport(content);
  const excluded = excludedIndex(content);
  const goals = GOAL_CATALOG.map((goal) => goalLevel(goal, caps)).filter((goal) =>
    content.goals.selected.includes(goal.id),
  );

  const { phrases, invalid } = sanitizePhrases(content.goals.searchPhrases);
  const queries = buildResearchQueries(profile, budget, content.goals.searchPhrases, excluded);
  const serving = queryServingProviders(registry);

  const activeUrls = content.identification.urls.filter((entry) => entry.role !== "excluded");
  const startUrls = activeUrls.filter((entry) => !isUrlExcluded(entry.url, excluded));
  const intents = selectedIntents(content);
  const participating = new Set(
    registry.select(null, intents).map((provider) => provider.descriptor.id),
  );

  const unsupported: string[] = [];
  for (const goal of goals) {
    if (goal.level === "unsupported") unsupported.push(`${goal.label}: ${goal.reason}`);
    else if (goal.level === "partial" && goal.reason)
      unsupported.push(`${goal.label}: ${goal.reason}`);
  }
  if (content.goals.selected.includes("contacts"))
    unsupported.push("Часы работы (opening_hours) в v1 не извлекаются.");
  if (excluded.urls.length)
    unsupported.push(
      "Исключённые URL не блокируются на уровне обхода — страница может сослаться на них.",
    );
  if (!serving.length)
    unsupported.push(
      "Сформированные поисковые запросы не будут обслужены: в окружении нет поискового провайдера с текстом запроса.",
    );
  unsupported.push(
    "Временной горизонт не поддерживается: v1 сравнивает текущее состояние с предыдущими запусками.",
  );

  const officialSources = content.identification.urls.filter((entry) => entry.role === "official");
  const extraUrls = content.identification.urls.filter(
    (entry) => entry.role === "confirmed" || entry.role === "candidate",
  );

  return {
    goals,
    identification: {
      displayName: content.identification.displayName,
      hasOfficialUrl: officialSources.length > 0,
      urlCount: activeUrls.length,
      excludedCount: content.identification.urls.length - activeUrls.length,
      domains: content.identification.domains,
    },
    providers: [
      ...caps.search.map((entry) => ({
        id: entry.id,
        label: entry.label,
        role: "search" as const,
        available: entry.available,
        reason: entry.reason,
        willParticipate: entry.available && participating.has(entry.id),
      })),
      ...caps.crawl.map((entry) => ({
        id: entry.id,
        label: entry.label,
        role: "crawl" as const,
        available: entry.available,
        reason: entry.reason,
        willParticipate: entry.available,
      })),
    ],
    officialSources,
    extraUrls,
    excludedUrls: excluded.urls,
    queries: queries.map((query) => ({
      text: query.text,
      templateId: query.templateId,
      intent: query.intent,
      servedBy: serving,
    })),
    ignoredPhrases: invalid,
    phrases,
    crawl: {
      enabled: startUrls.length > 0 && caps.canCrawl,
      maxDepth: budget.maxDepth,
      maxPages: budget.maxPages,
      maxRequests: budget.maxRequests,
      maxTotalBytes: budget.maxTotalBytes,
      maxDurationMs: budget.maxDurationMs,
    },
    budget,
    unsupported,
    needsConfirmation: extraUrls
      .filter((entry) => entry.role === "candidate")
      .map((entry) => ({ url: entry.url })),
    results: [
      "Кандидаты источников и их статусы",
      "Наблюдения и извлечённые факты с источником и временем",
      "История изменений фактов",
      "Противоречия при расхождении сведений",
      ...(caps.canCrawl && startUrls.length
        ? ["Обход стартовых URL (crawl-очередь)"]
        : []),
    ],
    timeHorizon: {
      supported: false,
      reason: "Временной горизонт пока не поддерживается.",
    },
    geoLimits: content.goals.geoLimits,
  };
}

/**
 * Глубокое равенство без учёта порядка ключей: content приходит из jsonb
 * (порядок ключей нормализуется БД) и свежего parse — сравниваем содержимое.
 */
export function passportEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;
    return a.every((item, index) => passportEquals(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => key in right && passportEquals(left[key], right[key]),
    );
  }
  return false;
}

/** Интенты выбранных целей — фильтр провайдеров при запуске. */
export function selectedIntents(content: PassportContent): DiscoveryIntent[] {
  const intents = new Set<DiscoveryIntent>();
  for (const id of content.goals.selected) {
    const goal = GOAL_CATALOG.find((item) => item.id === id);
    for (const intent of goal?.intents ?? []) intents.add(intent);
  }
  if (!intents.size) intents.add("any");
  return [...intents];
}

/** Причины отказа запуска (422) — отдельно от валидации содержимого. */
export function assertLaunchable(content: PassportContent, registry: ProviderRegistry): void {
  if (!content.identification.displayName)
    throw new AppError(422, "RESEARCH_NAME_REQUIRED", "Укажите название бизнеса.");
  if (!content.goals.selected.length)
    throw new AppError(422, "RESEARCH_GOALS_REQUIRED", "Выберите хотя бы одну цель.");
  const caps = researchCapabilities(registry);
  const allUnsupported = content.goals.selected.every((id) => {
    const goal = GOAL_CATALOG.find((item) => item.id === id);
    return !goal || goalLevel(goal, caps).level === "unsupported";
  });
  if (allUnsupported)
    throw new AppError(
      422,
      "RESEARCH_GOALS_UNSUPPORTED",
      "Ни одна выбранная цель не поддерживается в текущей сборке — запуск нечестен.",
    );
}

/**
 * Профиль предзаполнения из карточки бизнеса: значения предлагаются как
 * начальные и никогда не перезаписывают сохранённый паспорт молча.
 */
export type PassportPrefill = {
  displayName: string;
  aliases: string[];
  category: string | null;
  city: string | null;
  region: string | null;
  address: string | null;
  urls: { url: string; role: PassportUrlRole }[];
  phones: string[];
  emails: string[];
  notes: string | null;
};

export function prefillFromProfile(profile: DiscoveryProfile): PassportPrefill {
  const urls: { url: string; role: PassportUrlRole }[] = [];
  if (profile.website) urls.push({ url: profile.website, role: "candidate" });
  for (const link of profile.knownSocialLinks)
    if (!urls.some((entry) => entry.url === link))
      urls.push({ url: link, role: "candidate" });
  return {
    displayName: profile.businessName,
    aliases: profile.aliases.filter((alias) => alias !== profile.businessName),
    category: profile.category,
    city: profile.city,
    region: profile.region,
    address: profile.address,
    urls,
    phones: profile.phones,
    emails: profile.email ? [profile.email] : [],
    notes: null,
  };
}
