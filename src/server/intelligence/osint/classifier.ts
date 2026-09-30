import type {
  OsintDiscoveryMethod,
  OsintSourceType,
  OsintTrustLevel,
} from "./schema.ts";
import type { DiscoveryIntent } from "./config.ts";
import { digitSequence, normalizeText } from "./text.ts";
import { hostMatches, normalizeUrl, registrableDomain } from "./url.ts";

/**
 * Классификация raw-результатов провайдеров в тип/уровень доверия источника
 * (§13). Только детерминированные host-правила — AI здесь не участвует.
 */

/** Хосты, где содержимое не является страницей бизнеса — отбрасываем. */
export const REJECT_HOSTS: readonly string[] = [
  "hh.ru",
  "superjob.ru",
  "rabota.ru",
  "zarplata.ru",
  "avito.ru",
  "youla.ru",
];

/** Собственные сайты/реестры (официальный уровень доверия). */
export const OFFICIAL_HOSTS: readonly string[] = [
  "egrul.nalog.ru",
  "egrul.nalog.gov.ru",
  "nalog.ru",
];

export const MAPS_HOSTS: readonly string[] = [
  "2gis.ru",
  "yandex.ru",
  "yandex.com",
  "google.com",
  "google.ru",
  "maps.apple.com",
  "zoon.ru",
];

export const REVIEW_PLATFORM_HOSTS: readonly string[] = [
  "otzovik.com",
  "irecommend.ru",
  "yell.ru",
  "flamp.ru",
];

export const DIRECTORY_HOSTS: readonly string[] = [
  "zoon.ru",
  "list-org.com",
  "rusprofile.ru",
  "sbis.ru",
  "gde.ru",
  "yellowpages",
  "orgpage.ru",
  "worldorgs.ru",
];

export const NEWS_HOSTS: readonly string[] = [
  "ria.ru",
  "tass.ru",
  "rbc.ru",
  "kommersant.ru",
  "vedomosti.ru",
  "kp.ru",
  "mk.ru",
  "rg.ru",
  "interfax.ru",
  "dzen.ru",
];

export const SOCIAL_HOSTS: readonly string[] = [
  "vk.com",
  "vk.ru",
  "t.me",
  "telegram.me",
  "instagram.com",
  "facebook.com",
  "ok.ru",
  "youtube.com",
  "youtu.be",
  "x.com",
  "twitter.com",
  "linkedin.com",
];

function hostIn(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => hostMatches(host, domain));
}

export type ClassifyInput = {
  url: string;
  provider: string;
  title?: string | null;
  snippet?: string | null;
  query?: string | null;
  position?: number | null;
  intent?: DiscoveryIntent | null;
  method?: OsintDiscoveryMethod | null;
  knownDomains?: readonly string[];
  knownSocialLinks?: readonly string[];
};

export type ClassifiedCandidate = {
  normalizedUrl: string;
  host: string;
  registrableDomain: string | null;
  type: OsintSourceType;
  trustLevel: OsintTrustLevel;
  method: OsintDiscoveryMethod;
  title: string | null;
  snippet: string | null;
};

export type ClassifyResult =
  | { ok: true; candidate: ClassifiedCandidate }
  | { ok: false; reason: string };

const SERP_PATH = /^\/(search|search\/|p\/|yandsearch|go\.yandsearch|web)/i;

function isSerpPage(host: string, path: string): boolean {
  if (host === "yandex.ru" || host === "ya.ru") return SERP_PATH.test(path) || path === "/search";
  // Только точный хост или его поддомен: `evilgoogle.com` — не Google.
  if (hostMatches(host, "google.com") || hostMatches(host, "google.ru"))
    return path.startsWith("/search") || path === "/";
  if (host === "go.mail.ru") return true;
  if (host === "mail.ru") return path.startsWith("/search");
  return false;
}

function methodFor(intent: DiscoveryIntent | null | undefined): OsintDiscoveryMethod {
  switch (intent) {
    case "maps":
      return "map";
    case "social":
      return "social";
    case "website":
      return "search";
    default:
      return "search";
  }
}

/**
 * Классифицирует один результат провайдера. Невалидный URL, SERP-страницы,
 * доски вакансий → `ok:false` с причиной (не попадают в кандидаты).
 */
export function classifyResult(input: ClassifyInput): ClassifyResult {
  const normalized = normalizeUrl(input.url);
  if (!normalized.ok) return { ok: false, reason: normalized.reason };

  const host = normalized.host;
  const path = normalized.path;
  const text = normalizeText(`${input.title ?? ""} ${input.snippet ?? ""}`);

  if (hostIn(host, REJECT_HOSTS)) return { ok: false, reason: "jobs_or_ads_board" };
  if (isSerpPage(host, path)) return { ok: false, reason: "search_page" };

  const knownDomains = input.knownDomains ?? [];
  const knownSocialLinks = input.knownSocialLinks ?? [];
  const isOwnWebsite =
    knownDomains.some((domain) => hostMatches(host, domain)) ||
    knownSocialLinks.some((link) => {
      try {
        return hostMatches(host, new URL(link).hostname);
      } catch {
        return false;
      }
    });

  let type: OsintSourceType;
  let trustLevel: OsintTrustLevel;

  if (hostIn(host, OFFICIAL_HOSTS)) {
    type = "public_registry";
    trustLevel = "official";
  } else if (hostIn(host, SOCIAL_HOSTS) || knownSocialLinks.some((link) => {
    try {
      return hostMatches(host, new URL(link).hostname);
    } catch {
      return false;
    }
  })) {
    type = "social_network";
    trustLevel = "third_party";
  } else if (hostIn(host, REVIEW_PLATFORM_HOSTS)) {
    type = "review_platform";
    trustLevel = "review_platform";
  } else if (hostIn(host, MAPS_HOSTS)) {
    // yandex.ru/gmaps и 2gis — карточки-справочники.
    type = "maps";
    trustLevel = "public_directory";
  } else if (hostIn(host, DIRECTORY_HOSTS)) {
    type = "directory";
    trustLevel = "public_directory";
  } else if (hostIn(host, NEWS_HOSTS)) {
    type = "news";
    trustLevel = "third_party";
  } else if (isOwnWebsite) {
    type = "website";
    trustLevel = "official";
  } else if (input.intent === "identity" && !text && !input.title) {
    return { ok: false, reason: "empty_candidate" };
  } else {
    type = "website";
    trustLevel = "third_party";
  }

  return {
    ok: true,
    candidate: {
      normalizedUrl: normalized.url,
      host,
      registrableDomain: normalized.registrableDomain ?? registrableDomain(host),
      type,
      trustLevel,
      method: input.method ?? methodFor(input.intent),
      title: input.title?.trim() || null,
      snippet: input.snippet?.trim() || null,
    },
  };
}

/** Экспортируется для тестов/аудита: используемые в правилах сигнатуры. */
export function classifySignature(url: string): string | null {
  const normalized = normalizeUrl(url);
  if (!normalized.ok) return null;
  return `${normalized.host}${normalized.path}`;
}

/** Хеш-подпись для дедупликации кандидатов одного run'а. */
export function candidateKey(candidate: {
  normalizedUrl: string;
  type: string;
}): string {
  return `${candidate.type}:${candidate.normalizedUrl}`;
}

/** Цифровая подпись телефона в тексте — вспомогательный сигнал. */
export function phoneInText(text: string, phone: string): boolean {
  return digitSequence(text).includes(digitSequence(phone));
}
