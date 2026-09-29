import { industryPreset } from "../../../lib/industryPresets.ts";
import { normalizePhone, tokenize } from "./text.ts";
import { normalizeUrl, registrableDomain } from "./url.ts";

/**
 * DiscoveryProfile — runtime/domain объект поискового профиля.
 * НЕ является копией таблицы `business`: только то, что нужно для поиска
 * бизнеса в открытом интернете (§2).
 */
export type DiscoveryProfile = {
  businessName: string;
  aliases: string[];
  category: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  phone: string | null;
  phones: string[];
  email: string | null;
  website: string | null;
  address: string | null;
  knownDomains: string[];
  knownSocialLinks: string[];
};

export type DiscoveryProfileInput = {
  name: string;
  public_name?: string | null;
  description?: string | null;
  contact_info?: string | null;
  industry?: string | null;
  industry_subtype?: string | null;
  greeting?: string | null;
  ai_about?: string | null;
  ai_geography?: string | null;
  ai_important_facts?: string | null;
  ai_extra_instructions?: string | null;
};

const PHONE_CANDIDATE =
  /(?<![\d.,])(\+?\d[\d\s().-]{8,18}\d)(?![\d.,])/g;
const EMAIL_CANDIDATE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const URL_CANDIDATE = /https?:\/\/[^\s<>"')\]]+/gi;

const SOCIAL_HOSTS = [
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
];

const LEGAL_FORMS =
  /^(?:общество\s+с\s+ограниченной\s+ответственностью|ооо|зао|пао|ао|ип|чп)\s+/i;

export function stripLegalForms(name: string): string {
  let current = name.trim();
  for (let i = 0; i < 3; i += 1) {
    const next = current.replace(LEGAL_FORMS, "").trim();
    if (next === current) break;
    current = next;
  }
  return current.replace(/^["«']|["»']$/g, "").trim() || name.trim();
}

/** Телефоны в порядке появления, нормализованные до 10–15 цифр, без дублей. */
export function extractPhones(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text ?? "").matchAll(PHONE_CANDIDATE)) {
    const phone = normalizePhone(match[1] ?? "");
    if (phone && !found.includes(phone)) found.push(phone);
  }
  return found;
}

export function extractEmails(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text ?? "").matchAll(EMAIL_CANDIDATE)) {
    const email = (match[0] ?? "").toLowerCase();
    if (!found.includes(email)) found.push(email);
  }
  return found;
}

/** Нормализованные http/https ссылки; невалидные и не-веб схемы отбрасываются. */
export function extractUrls(text: string): string[] {
  const found: string[] = [];
  for (const match of String(text ?? "").matchAll(URL_CANDIDATE)) {
    const normalized = normalizeUrl(match[0]);
    if (normalized.ok && !found.includes(normalized.url)) found.push(normalized.url);
  }
  return found;
}

export function isSocialUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return SOCIAL_HOSTS.some((domain) => host === domain || host.endsWith("." + domain));
  } catch {
    return false;
  }
}

export function extractSocialLinks(urls: string[]): string[] {
  return urls.filter(isSocialUrl);
}

const CITY_LABEL = /(?:^|\n)\s*(?:город|city)\s*[:=]\s*([А-ЯЁ][а-яё-]{2,30})/i;
// NB: \b не работает с кириллицей в JS — используем явные классы символов.
const CITY_INLINE = /(?<![0-9a-zа-яё])г\.\s*([А-ЯЁ][а-яё-]{2,30})/i;
const CITY_WORD = /(?<![0-9a-zа-яё])город\s+([А-ЯЁ][а-яё-]{2,30})(?![0-9a-zа-яё])/i;

export function detectCity(text: string): string | null {
  const source = String(text ?? "");
  const byLabel = source.match(CITY_LABEL)?.[1]?.trim();
  if (byLabel) return byLabel;
  const byInline = source.match(CITY_INLINE)?.[1]?.trim();
  if (byInline) return byInline;
  const byWord = source.match(CITY_WORD)?.[1]?.trim();
  if (byWord) return byWord;
  return null;
}

const STREET_LINE =
  /(?<![0-9a-zа-яё])(?:ул\.?|улица|проспект|пр-т|пер\.?|переулок|наб\.?|набережная|бульвар|ш\.?|шоссе)(?![0-9a-zа-яё])/i;

export function detectAddress(text: string): string | null {
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 5 || line.length > 200) continue;
    if (STREET_LINE.test(line) && /\d/.test(line)) return line;
  }
  return null;
}

const REGION_LABEL = /(?:^|\n)\s*(?:регион|region)\s*[:=]\s*([А-ЯЁ][а-яё\s-]{3,40})/i;
const REGION_WORD =
  /(?<![0-9a-zа-яё])([А-ЯЁ][а-яё-]+(?:ская|ая|ый|ий))\s+(?:область|край)(?![0-9a-zа-яё])/i;

export function detectRegion(text: string): string | null {
  const source = String(text ?? "");
  const byLabel = source.match(REGION_LABEL)?.[1]?.trim();
  if (byLabel) return byLabel;
  const byWord = source.match(REGION_WORD)?.[0]?.trim();
  if (byWord) return byWord;
  return null;
}

function categoryFrom(input: DiscoveryProfileInput): string | null {
  const preset = industryPreset(input.industry);
  const subtype = input.industry_subtype?.trim();
  if (subtype) {
    const label = preset?.subtypes.find((item) => item.id === subtype)?.label;
    if (label) return label;
    // Сырой подтип может быть как человекочитаемым текстом, так и id.
    return subtype;
  }
  return preset?.label ?? input.industry?.trim() ?? null;
}

/** Строит поисковый профиль из уже существующих полей бизнеса БизнеСот. */
export function buildDiscoveryProfile(input: DiscoveryProfileInput): DiscoveryProfile {
  const name = String(input.name ?? "").trim();
  const publicName = input.public_name?.trim() || null;

  const corpus = [
    input.description,
    input.contact_info,
    input.greeting,
    input.ai_about,
    input.ai_geography,
    input.ai_important_facts,
    input.ai_extra_instructions,
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join("\n");

  const phones = extractPhones(corpus);
  const emails = extractEmails(corpus);
  const urls = extractUrls(corpus);
  const socialLinks = extractSocialLinks(urls);

  const siteUrls = urls.filter((url) => !isSocialUrl(url));
  const website = siteUrls[0] ?? null;

  const knownDomains = [
    ...new Set(
      siteUrls
        .map((url) => {
          try {
            return registrableDomain(new URL(url).hostname);
          } catch {
            return null;
          }
        })
        .filter((domain): domain is string => Boolean(domain)),
    ),
  ];

  const aliases = [
    ...new Set(
      [name, publicName ?? "", stripLegalForms(name)]
        .map((value) => value.trim())
        .filter((value, index, all) => value && all.indexOf(value) === index),
      ),
  ];

  return {
    businessName: name,
    aliases,
    category: categoryFrom(input),
    city: detectCity(corpus),
    region: detectRegion(corpus),
    country: null,
    phone: phones[0] ?? null,
    phones,
    email: emails[0] ?? null,
    website,
    address: detectAddress(corpus),
    knownDomains,
    knownSocialLinks: socialLinks,
  };
}

/** Пустой профиль — источник строк, в которых нет ни одного признака. */
export function isEmptyProfile(profile: DiscoveryProfile): boolean {
  return (
    !profile.businessName &&
    !profile.aliases.length &&
    !profile.phones.length &&
    !profile.website &&
    !profile.knownDomains.length
  );
}

/** Плейсхолдеры, доступные для подстановки в шаблоны запросов. */
export function queryPlaceholders(profile: DiscoveryProfile): Record<string, string> {
  const domain = (() => {
    if (profile.website) {
      try {
        return registrableDomain(new URL(profile.website).hostname) ?? "";
      } catch {
        return "";
      }
    }
    return profile.knownDomains[0] ?? "";
  })();

  const placeholders: Record<string, string> = {};
  const name = profile.businessName || profile.aliases[0] || "";
  if (tokenize(name).length) placeholders.name = name;
  if (profile.city) placeholders.city = profile.city;
  if (profile.region) placeholders.region = profile.region;
  if (profile.category) placeholders.category = profile.category;
  if (profile.phone) placeholders.phone = profile.phone;
  if (domain) placeholders.domain = domain;
  return placeholders;
}
