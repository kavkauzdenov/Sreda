/**
 * Консервативный HTML-разбор для OSINT-сбора (Stage 3 full).
 *
 * Никаких внешних зависимостей и никакого выполнения JavaScript: разбор идёт
 * по токенам регулярными выражениями, поэтому он одинаково работает на
 * валидной вёрстке и на битой разметке реального интернета. Результат —
 * сырой материал (заголовок, описание, канонический URL, ссылки, текст,
 * JSON-LD); нормализация и провенанс живут в `extraction/page.ts`.
 *
 * Ограничения осознаны: документ обрезается до `MAX_HTML_LENGTH`, текст — до
 * `MAX_TEXT_LENGTH`, ссылки — до `MAX_LINKS`. Развёрнутая навигация и
 * вложенные `<a>` внутри таблиц не преследуются — нужен именно материал
 * страницы, а не полноценный браузер.
 */

export const HTML_PARSER_VERSION = "html-v1";

const MAX_HTML_LENGTH = 2_000_000;
const MAX_TEXT_LENGTH = 60_000;
const MAX_LINKS = 300;
const MAX_JSONLD_BLOCKS = 20;
const MAX_JSONLD_LENGTH = 100_000;
const MAX_META = 80;

const COMMENT_RE = /<!--[\s\S]*?-->/g;
const SCRIPT_OR_STYLE_RE =
  /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const JSONLD_RE =
  /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i;
const META_RE = /<meta\b([^>]*)>/gi;
const LINK_TAG_RE = /<link\b([^>]*)>/gi;
const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
const HTML_LANG_RE = /<html\b[^>]*\blang\s*=\s*["']?([^"'\s>]+)/i;
const BASE_HREF_RE = /<base\b[^>]*\bhref\s*=\s*["']([^"']+)["']/i;
const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
const BLOCK_END_RE =
  /<\/(p|div|li|h[1-6]|tr|section|article|header|footer|br|blockquote|dd|dt)\s*>|<br\s*\/?>/gi;
const TAG_RE = /<[^>]+>/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  raquo: "»",
  laquo: "«",
};

/** Декодирует именованные и числовые HTML-сущности; неизвестные — как есть. */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code)
        : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? safeFromCodePoint(code)
        : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

function safeFromCodePoint(code: number): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Разбирает атрибуты тега в объект с ключами в нижнем регистре. */
export function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  for (;;) {
    const match = ATTR_RE.exec(raw);
    if (!match) break;
    const name = match[1]?.toLowerCase();
    if (!name) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!(name in attributes)) attributes[name] = decodeEntities(value).trim();
    if (Object.keys(attributes).length > 64) break;
  }
  return attributes;
}

function collapseWhitespace(value: string): string {
  return value.replace(/[ \t\f\v ]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** Текст из фрагмента разметки: теги вырезаются, сущности декодируются. */
export function textOf(fragment: string): string {
  return collapseWhitespace(
    decodeEntities(fragment.replace(TAG_RE, " ")),
  );
}

export type ParsedLink = {
  /** Атрибут href как есть (до разрешения относительно базы). */
  href: string;
  rel: string | null;
  text: string;
  /** Внешний видимый текст ссылки пуст — типичный иконочный линк. */
  textPresent: boolean;
};

export type ParsedMeta = {
  key: string;
  value: string;
  /** `name` или `property` — как объявлено в разметке. */
  kind: "name" | "property" | "http-equiv" | "other";
};

export type ParsedJsonLd = {
  /** Первый `@type` (или его массив) в нижнем регистре для маршрутизации. */
  types: string[];
  value: Record<string, unknown>;
};

export type ParsedHtml = {
  title: string | null;
  /** Первое осмысленное описание: meta description → og:description. */
  description: string | null;
  canonical: string | null;
  /** `<base href>` — база для разрешения относительных ссылок. */
  baseUrl: string | null;
  language: string | null;
  meta: ParsedMeta[];
  links: ParsedLink[];
  jsonLd: ParsedJsonLd[];
  /** Видимый текст страницы (без script/style), ограничен. */
  text: string;
  parserVersion: string;
};

function parseJsonLdBlocks(html: string): ParsedJsonLd[] {
  const blocks: ParsedJsonLd[] = [];
  JSONLD_RE.lastIndex = 0;
  for (;;) {
    const match = JSONLD_RE.exec(html);
    if (!match) break;
    const raw = (match[1] ?? "").slice(0, MAX_JSONLD_LENGTH).trim();
    if (!raw || blocks.length >= MAX_JSONLD_BLOCKS) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Битый JSON-LD — не ошибка страницы: пропускаем блок целиком.
      continue;
    }
    const stack = Array.isArray(parsed) ? [...parsed] : [parsed];
    for (const node of stack) {
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const record = node as Record<string, unknown>;
      const graph = record["@graph"];
      const nodes = Array.isArray(graph) ? graph : [record];
      for (const item of nodes) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const value = item as Record<string, unknown>;
        const rawType = value["@type"];
        const types = (Array.isArray(rawType) ? rawType : [rawType])
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.toLowerCase());
        blocks.push({ types, value });
        if (blocks.length >= MAX_JSONLD_BLOCKS) break;
      }
      if (blocks.length >= MAX_JSONLD_BLOCKS) break;
    }
    if (blocks.length >= MAX_JSONLD_BLOCKS) break;
  }
  return blocks;
}

function collectMeta(html: string): ParsedMeta[] {
  const meta: ParsedMeta[] = [];
  META_RE.lastIndex = 0;
  for (;;) {
    const match = META_RE.exec(html);
    if (!match) break;
    const attributes = parseAttributes(match[1] ?? "");
    const content = attributes.content;
    if (content === undefined || content === "") continue;
    const kind: ParsedMeta["kind"] = attributes.name
      ? "name"
      : attributes.property
        ? "property"
        : attributes["http-equiv"]
          ? "http-equiv"
          : "other";
    const key = (
      attributes.name ??
      attributes.property ??
      attributes["http-equiv"] ??
      ""
    )
      .trim()
      .toLowerCase();
    if (!key) continue;
    meta.push({ key, value: content, kind });
    if (meta.length >= MAX_META) break;
  }
  return meta;
}

function collectLinks(html: string): ParsedLink[] {
  const links: ParsedLink[] = [];
  ANCHOR_RE.lastIndex = 0;
  for (;;) {
    const match = ANCHOR_RE.exec(html);
    if (!match) break;
    const attributes = parseAttributes(match[1] ?? "");
    const href = attributes.href;
    if (!href) continue;
    const text = textOf(match[2] ?? "");
    links.push({
      href,
      rel: attributes.rel ?? null,
      text: truncate(text, 300),
      textPresent: text.length > 0,
    });
    if (links.length >= MAX_LINKS) break;
  }
  // `<link rel="canonical|alternate|me">` — не навигация, но источники URL.
  LINK_TAG_RE.lastIndex = 0;
  for (;;) {
    const match = LINK_TAG_RE.exec(html);
    if (!match) break;
    const attributes = parseAttributes(match[1] ?? "");
    const href = attributes.href;
    const rel = attributes.rel?.toLowerCase();
    if (!href || !rel) continue;
    if (!/(canonical|alternate|me)/.test(rel)) continue;
    links.push({ href, rel, text: "", textPresent: false });
    if (links.length >= MAX_LINKS) break;
  }
  return links;
}

/**
 * Разбирает HTML-документ. Невалидная разметка не выбрасывает исключений:
 * каждый блок по возможности извлекается независимо от остальных.
 */
export function parseHtml(input: string): ParsedHtml {
  const html = input.length > MAX_HTML_LENGTH
    ? input.slice(0, MAX_HTML_LENGTH)
    : input;

  const jsonLd = parseJsonLdBlocks(html);

  const withoutHeavy = html
    .replace(COMMENT_RE, " ")
    .replace(SCRIPT_OR_STYLE_RE, " ");

  const titleMatch = withoutHeavy.match(TITLE_RE);
  const title = titleMatch ? textOf(titleMatch[1] ?? "") : null;

  const meta = collectMeta(withoutHeavy);
  const description =
    meta.find((entry) => entry.key === "description" && entry.kind === "name")
      ?.value ??
    meta.find((entry) => entry.key === "og:description")?.value ??
    meta.find((entry) => entry.key === "twitter:description")?.value ??
    null;

  const canonical =
    collectLinks(html).find((link) => link.rel === "canonical")?.href ?? null;
  const baseUrl = html.match(BASE_HREF_RE)?.[1]?.trim() ?? null;
  const language = html.match(HTML_LANG_RE)?.[1]?.trim() ?? null;

  const text = truncate(
    collapseWhitespace(
      decodeEntities(
        withoutHeavy.replace(BLOCK_END_RE, "\n").replace(TAG_RE, " "),
      ),
    ),
    MAX_TEXT_LENGTH,
  );

  return {
    title: title ? truncate(title, 500) : null,
    description: description ? truncate(description, 2000) : null,
    canonical: canonical ? truncate(canonical, 2048) : null,
    baseUrl: baseUrl ? truncate(baseUrl, 2048) : null,
    language: language ? truncate(language, 32) : null,
    meta,
    links: collectLinks(html),
    jsonLd,
    text,
    parserVersion: HTML_PARSER_VERSION,
  };
}
