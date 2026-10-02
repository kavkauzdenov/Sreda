import { createHash } from "node:crypto";
import { extractEmails, extractPhones } from "../profile.ts";
import { normalizeUrl, registrableDomain } from "../url.ts";
import {
  HTML_PARSER_VERSION,
  parseHtml,
  type ParsedHtml,
  type ParsedLink,
} from "./html.ts";

/**
 * Нормализация загруженной страницы в ParsedPage (§25).
 *
 * Каждое значение несёт провенанс (`origin`) — откуда оно взято: заголовок
 * документа, meta-тег, canonical, JSON-LD, ссылка или видимый текст. Это
 * требование §6 (provenance): наблюдение обязано объяснять, каким полем
 * было получено каждое утверждение, иначе оценка в Stage 3 не трассируется.
 *
 * Здесь только детерминированная нормализация: сеть, бюджеты, классификация
 * и запись в БД живут в crawl/providers.
 */

export type ExtractionOrigin =
  | "html_title"
  | "meta_description"
  | "og_title"
  | "og_description"
  | "canonical_link"
  | "base_href"
  | "html_lang"
  | "http_header"
  | "jsonld_name"
  | "jsonld_description"
  | "jsonld_url"
  | "jsonld_same_as"
  | "jsonld_telephone"
  | "jsonld_email"
  | "jsonld_address"
  | "anchor"
  | "visible_text"
  | "text_body"
  | "text_title";

export type PageLink = {
  /** Абсолютный нормализованный URL (без трекинговых параметров). */
  url: string;
  origin: ExtractionOrigin;
  rel: string | null;
  /** Видимый текст ссылки; пустая строка — иконочный линк. */
  text: string;
};

export type PageContact = {
  kind: "phone" | "email";
  /** Для телефона — цифровая нормализация, для email — нижний регистр. */
  value: string;
  origin: ExtractionOrigin;
};

export type PageDomain = {
  /** Регистрируемый домен (упрощённый public suffix). */
  domain: string;
  origin: ExtractionOrigin;
};

/** Сводка по одному JSON-LD блоку — сырой JSON не сохраняем (§9). */
export type StructuredPageSummary = {
  types: string[];
  name: string | null;
  url: string | null;
  sameAs: string[];
  telephone: string | null;
  email: string | null;
  description: string | null;
};

export type ParsedPage = {
  requestedUrl: string;
  /** Финальный URL после редиректов (то, что отдал safeFetch). */
  finalUrl: string;
  /** `<link rel="canonical">`, разрешённый относительно страницы. */
  canonicalUrl: string | null;
  type: "html" | "text";
  status: number;
  contentType: string | null;
  /** ISO-строка момента загрузки. */
  fetchedAt: string;
  language: string | null;
  parserVersion: string;
  title: string | null;
  description: string | null;
  /** Видимый текст, ограничен `maxTextLength`. */
  text: string;
  /** Полная длина текста до ограничения — сигнал «страница есть». */
  textLength: number;
  links: PageLink[];
  contacts: PageContact[];
  domains: PageDomain[];
  sameAs: string[];
  structured: StructuredPageSummary[];
  /** sha256 нормализованного материала — изменение контента → новый hash. */
  contentHash: string;
};

export type NormalizePageInput = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  /** Сырой тело ответа; для html используется как есть. */
  body: string;
  fetchedAt?: Date;
  /** Ограничение текста для наблюдения (по умолчанию 6000 символов). */
  maxTextLength?: number;
  maxLinks?: number;
};

const DEFAULT_MAX_TEXT = 6_000;
const DEFAULT_MAX_LINKS = 200;
const MAX_CONTACTS = 50;
const MAX_SAME_AS = 50;

function isHtmlContentType(contentType: string | null): boolean {
  if (!contentType) return true; // без заголовка пробуем как HTML
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}

function resolveUrl(raw: string, base: string): string | null {
  let absolute: URL;
  try {
    absolute = new URL(raw, base);
  } catch {
    return null;
  }
  if (absolute.protocol !== "http:" && absolute.protocol !== "https:")
    return null;
  const normalized = normalizeUrl(absolute.toString());
  return normalized.ok ? normalized.url : null;
}

function metaValue(
  parsed: ParsedHtml,
  ...keys: string[]
): { value: string; origin: ExtractionOrigin } | null {
  for (const key of keys) {
    const hit = parsed.meta.find((entry) => entry.key === key);
    if (hit) {
      const origin: ExtractionOrigin =
        key === "description"
          ? "meta_description"
          : key.startsWith("og:title")
            ? "og_title"
            : key.startsWith("og:") || key.startsWith("twitter:")
              ? "og_description"
              : "meta_description";
      return { value: hit.value, origin };
    }
  }
  return null;
}

function jsonLdString(
  value: Record<string, unknown>,
  ...keys: string[]
): string | null {
  for (const key of keys) {
    const found = Object.entries(value).find(
      ([entryKey]) => entryKey.toLowerCase() === key.toLowerCase(),
    );
    const raw = found?.[1];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "number") return String(raw);
  }
  return null;
}

function jsonLdStringList(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const found = Object.entries(value).find(
    ([entryKey]) => entryKey.toLowerCase() === key.toLowerCase(),
  );
  const raw = found?.[1];
  if (typeof raw === "string") return raw.trim() ? [raw.trim()] : [];
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is string | number => typeof item === "string" || typeof item === "number")
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  return [];
}

function collectStructured(
  parsed: ParsedHtml,
  baseUrl: string,
): {
  summaries: StructuredPageSummary[];
  sameAs: string[];
  links: PageLink[];
  contacts: PageContact[];
} {
  const summaries: StructuredPageSummary[] = [];
  const sameAs: string[] = [];
  const links: PageLink[] = [];
  const contacts: PageContact[] = [];

  for (const block of parsed.jsonLd) {
    const value = block.value;
    const sameAsValues = jsonLdStringList(value, "sameAs");
    const resolvedSameAs: string[] = [];
    for (const raw of sameAsValues) {
      const url = resolveUrl(raw, baseUrl);
      if (!url) continue;
      if (sameAs.length < MAX_SAME_AS && !sameAs.includes(url)) {
        sameAs.push(url);
        links.push({ url, origin: "jsonld_same_as", rel: "sameAs", text: "" });
      }
      if (!resolvedSameAs.includes(url)) resolvedSameAs.push(url);
    }

    const url = jsonLdString(value, "url");
    const resolvedUrl = url ? resolveUrl(url, baseUrl) : null;
    if (resolvedUrl) {
      links.push({ url: resolvedUrl, origin: "jsonld_url", rel: null, text: "" });
    }

    const telephone = jsonLdString(value, "telephone", "phone");
    if (telephone) {
      for (const phone of extractPhones(telephone).slice(0, 5)) {
        contacts.push({ kind: "phone", value: phone, origin: "jsonld_telephone" });
      }
    }
    const email = jsonLdString(value, "email");
    if (email) {
      for (const item of extractEmails(email).slice(0, 5)) {
        contacts.push({ kind: "email", value: item, origin: "jsonld_email" });
      }
    }

    summaries.push({
      types: block.types,
      name: jsonLdString(value, "name"),
      url: resolvedUrl,
      sameAs: resolvedSameAs,
      telephone: telephone ?? null,
      email: email ?? null,
      description: jsonLdString(value, "description"),
    });
  }

  return { summaries, sameAs, links, contacts };
}

function collectAnchorLinks(
  parsed: ParsedHtml,
  baseUrl: string,
  maxLinks: number,
): PageLink[] {
  const links: PageLink[] = [];
  const seen = new Set<string>();
  for (const link of parsed.links as ParsedLink[]) {
    if (links.length >= maxLinks) break;
    const resolved = resolveUrl(link.href, baseUrl);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    links.push({
      url: resolved,
      origin: link.rel ? "canonical_link" : "anchor",
      rel: link.rel,
      text: link.text,
    });
  }
  return links;
}

function textMaterials(
  page: Omit<ParsedPage, "contentHash">,
): string {
  return [page.title, page.description, page.canonicalUrl, page.text]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

function hashOf(material: string): string {
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** Нормализует загруженную страницу в структуру с провенансом полей. */
export function normalizePage(input: NormalizePageInput): ParsedPage {
  const fetchedAt = (input.fetchedAt ?? new Date()).toISOString();
  const maxText = input.maxTextLength ?? DEFAULT_MAX_TEXT;
  const maxLinks = input.maxLinks ?? DEFAULT_MAX_LINKS;
  const base = input.finalUrl;

  if (!isHtmlContentType(input.contentType)) {
    const full = input.body;
    const titleLine = full.split(/\r?\n/, 1)[0]?.trim() ?? null;
    const base64: Omit<ParsedPage, "contentHash"> = {
      requestedUrl: input.requestedUrl,
      finalUrl: input.finalUrl,
      canonicalUrl: null,
      type: "text",
      status: input.status,
      contentType: input.contentType,
      fetchedAt,
      language: null,
      parserVersion: HTML_PARSER_VERSION,
      title: titleLine ? titleLine.slice(0, 500) : null,
      description: null,
      text: full.slice(0, maxText),
      textLength: full.length,
      links: [],
      contacts: [],
      domains: [],
      sameAs: [],
      structured: [],
    };
    return { ...base64, contentHash: hashOf(textMaterials(base64)) };
  }

  const parsed = parseHtml(input.body);
  const effectiveBase = parsed.baseUrl ? resolveUrl(parsed.baseUrl, base) ?? base : base;

  const title =
    parsed.title ??
    metaValue(parsed, "og:title", "twitter:title")?.value ??
    null;

  const descriptionEntry = metaValue(parsed, "description", "og:description", "twitter:description");
  const description = parsed.description ?? descriptionEntry?.value ?? null;

  const canonicalRaw = parsed.canonical;
  const canonicalUrl = canonicalRaw ? resolveUrl(canonicalRaw, effectiveBase) : null;

  const structured = collectStructured(parsed, effectiveBase);

  const anchorLinks = collectAnchorLinks(parsed, effectiveBase, maxLinks);
  const allLinks: PageLink[] = [];
  const seenUrls = new Set<string>();
  for (const link of [...structured.links, ...anchorLinks]) {
    if (seenUrls.has(link.url)) continue;
    if (allLinks.length >= maxLinks) break;
    seenUrls.add(link.url);
    allLinks.push(link);
  }

  const contacts: PageContact[] = [...structured.contacts];
  const contactKeys = new Set(contacts.map((c) => `${c.kind}:${c.value}`));
  const pushContact = (kind: "phone" | "email", values: string[], origin: ExtractionOrigin) => {
    for (const value of values) {
      if (contacts.length >= MAX_CONTACTS) return;
      const key = `${kind}:${value}`;
      if (contactKeys.has(key)) continue;
      contactKeys.add(key);
      contacts.push({ kind, value, origin });
    }
  };
  pushContact("phone", extractPhones(parsed.text), "visible_text");
  pushContact("email", extractEmails(parsed.text), "visible_text");

  const domains: PageDomain[] = [];
  const domainKeys = new Set<string>();
  const pushDomain = (raw: string, origin: ExtractionOrigin) => {
    const host = (() => {
      try {
        return new URL(raw).hostname;
      } catch {
        return null;
      }
    })();
    if (!host) return;
    const domain = registrableDomain(host);
    if (!domain || domainKeys.has(domain)) return;
    domainKeys.add(domain);
    domains.push({ domain, origin });
  };
  for (const link of allLinks) pushDomain(link.url, "anchor");
  if (canonicalUrl) pushDomain(canonicalUrl, "canonical_link");
  for (const sameAs of structured.sameAs) pushDomain(sameAs, "jsonld_same_as");

  const language =
    parsed.language ??
    metaValue(parsed, "og:locale")?.value ??
    null;

  const material: Omit<ParsedPage, "contentHash"> = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    canonicalUrl,
    type: "html",
    status: input.status,
    contentType: input.contentType,
    fetchedAt,
    language: language ? language.slice(0, 32) : null,
    parserVersion: parsed.parserVersion,
    title: title ? title.slice(0, 500) : null,
    description: description ? description.slice(0, 2000) : null,
    text: parsed.text.slice(0, maxText),
    textLength: parsed.text.length,
    links: allLinks,
    contacts,
    domains,
    sameAs: structured.sameAs,
    structured: structured.summaries,
  };

  return { ...material, contentHash: hashOf(textMaterials(material)) };
}
