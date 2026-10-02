import type { OsintFactType } from "./schema.ts";
import { extractPhoneRuns } from "./text.ts";
import { registrableDomain } from "./url.ts";
import {
  normalizeDomain,
  normalizeSocial,
  normalizeWebUrl,
} from "./normalize.ts";

/**
 * Fact extraction Stage 4 (§26.3): Observation → детерминированные Fact
 * candidates. Никакого LLM и никакого NLP — только структурированные поля
 * источника и закрытые текстовые паттерны, безопасные для детерминизма.
 *
 * Приоритет источников (§26.3):
 *   1. structured data        — osint_source_context (canonical_name, city,
 *                               address, contacts, domains, social_links);
 *   2. provider-structured   — нормализованный URL самого источника
 *                               (domain/website факты);
 *   3. deterministic page    — телефоны/email/URL из текста наблюдения;
 *   4. plain text patterns   — только уже проверенные regex (телефон/email).
 *
 * Сознательно НЕ извлекается в v1 (§26.2): brand_name/legal_name без
 * структурированного источника, public identifiers из произвольного текста,
 * service/product/opening_hours без закрытого словаря. Типы определены в
 * схеме, строка создаётся только когда значение уже дано структурно.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s,;)"'<>]+/g;

/** Происхождение кандидата — попадает в fact.metadata.origin (§26.4). */
export type FactCandidateOrigin =
  | "source_context"
  | "source_url"
  | "observation_text";

export type FactCandidate = {
  factType: OsintFactType;
  rawValue: string;
  origin: FactCandidateOrigin;
};

/** Структурированный контекст источника — ровно те поля, что уже собран Stage 3. */
export type StructuredSourceContext = {
  canonical_name?: string | null;
  category?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  address?: string | null;
  contacts?: unknown;
  domains?: unknown;
  social_links?: unknown;
};

export type ExtractFactsInput = {
  /** Content наблюдения — ровно то, что Stage 3 уже сохранил (§26.19). */
  content: string;
  /** display_name целевой сущности — имя подтверждается только присутствием в тексте. */
  entityName?: string | null;
  /** Нормализованный URL самого источника — домен источника. */
  sourceUrl?: string | null;
  sourceContext?: StructuredSourceContext | null;
};

function asString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number") return String(value);
  return null;
}

function collectContacts(raw: unknown): { kind: string; value: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { kind: string; value: string }[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object") {
      const kind = asString((entry as Record<string, unknown>).kind);
      const value = asString((entry as Record<string, unknown>).value);
      if (kind && value) out.push({ kind, value });
      continue;
    }
    const plain = asString(entry);
    // Форма без kind: решает нормализация (телефон/email — по содержимому).
    if (plain) out.push({ kind: "", value: plain });
  }
  return out;
}

function collectDomains(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const value = asString(entry);
    if (value) out.push(value);
  }
  return out;
}

function collectSocialUrls(raw: unknown): string[] {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const urls = (raw as Record<string, unknown>).urls;
    if (Array.isArray(urls)) {
      return urls.map(asString).filter((value): value is string => Boolean(value));
    }
  }
  if (Array.isArray(raw)) return raw.map(asString).filter((v): v is string => Boolean(v));
  return [];
}

/** Социальный URL → тип факта; не социальный → null. */
function socialFactType(rawUrl: string): OsintFactType | null {
  const normalized = normalizeSocial("other_social", rawUrl);
  if (!normalized) return null;
  const prefix = normalized.key.slice(0, normalized.key.indexOf(":"));
  if (prefix === "other") return "other_social";
  return prefix as OsintFactType;
}

/**
 * Построение кандидатов для одного наблюдения. Дедупликация по
 * (factType, raw) не нужна — нормализация + fingerprint в enrichment гасят
 * повторы детерминированно (§26.9).
 */
export function extractFacts(input: ExtractFactsInput): FactCandidate[] {
  const candidates: FactCandidate[] = [];
  const push = (
    factType: OsintFactType,
    rawValue: string,
    origin: FactCandidateOrigin,
  ): void => {
    const value = rawValue.trim();
    if (value) candidates.push({ factType, rawValue: value, origin });
  };

  const context = input.sourceContext;

  // 1. Structured data — поля контекста источника.
  if (context) {
    if (context.canonical_name) push("business_name", context.canonical_name, "source_context");
    if (context.category) push("category", context.category, "source_context");
    if (context.city) push("city", context.city, "source_context");
    if (context.region) push("region", context.region, "source_context");
    if (context.country) push("country", context.country, "source_context");
    if (context.address) push("address", context.address, "source_context");

    for (const contact of collectContacts(context.contacts)) {
      if (contact.kind === "phone") push("phone", contact.value, "source_context");
      else if (contact.kind === "email") push("email", contact.value, "source_context");
      else if (!contact.kind) {
        // Форма без kind: пробуем обе типизации, нормализация отфильтрует.
        push("phone", contact.value, "source_context");
        push("email", contact.value, "source_context");
      }
    }

    // Домен из структуры — только если это домен самого источника: случайные
    // anchor-домены соседних сайтов не являются доменом бизнеса (§26.19).
    const ownDomain = input.sourceUrl ? registrableDomainOf(input.sourceUrl) : null;
    for (const domain of collectDomains(context.domains)) {
      const normalized = normalizeDomain(domain);
      if (!normalized || !ownDomain) continue;
      if (normalized.key === ownDomain) push("domain", normalized.value, "source_context");
    }

    for (const url of collectSocialUrls(context.social_links)) {
      const factType = socialFactType(url);
      if (factType) push(factType, url, "source_context");
    }
  }

  // 2. Provider-structured: домен и сайт самого источника.
  if (input.sourceUrl) {
    const ownDomain = registrableDomainOf(input.sourceUrl);
    if (ownDomain) push("domain", ownDomain, "source_url");
    const ownUrl = normalizeWebUrl(input.sourceUrl);
    if (ownUrl) push("website", ownUrl.value, "source_url");
  }

  const content = input.content ?? "";

  // 3. Deterministic page extraction из текста наблюдения.
  for (const phone of extractPhoneRuns(content)) {
    push("phone", phone, "observation_text");
  }
  for (const email of new Set(content.match(EMAIL_RE) ?? [])) {
    push("email", email, "observation_text");
  }
  for (const url of new Set(content.match(URL_RE) ?? [])) {
    const clean = url.replace(/[.,;:]+$/, "");
    const social = socialFactType(clean);
    if (social) {
      push(social, clean, "observation_text");
      continue;
    }
    const web = normalizeWebUrl(clean);
    if (web) push("website", web.value, "observation_text");
  }

  // 4. Имя сущности — только при явном присутствии в тексте наблюдения.
  const entityName = input.entityName?.trim();
  if (entityName && content.toLowerCase().includes(entityName.toLowerCase())) {
    push("business_name", entityName, "observation_text");
  }

  return candidates;
}

function registrableDomainOf(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname;
    const domain = normalizeDomain(registrableDomain(host) ?? host);
    return domain?.key ?? null;
  } catch {
    return null;
  }
}
