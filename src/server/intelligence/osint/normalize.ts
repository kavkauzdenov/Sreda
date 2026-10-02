import { createHash } from "node:crypto";
import type { OsintFactType } from "./schema.ts";
import { digitSequence, normalizePhone, normalizeText } from "./text.ts";

/**
 * Deterministic normalization layer Stage 4 (§26.5).
 *
 * Принцип: raw_value никогда не теряется — здесь строится только каноническое
 * представление. Никакого LLM и никакой геокодации: только детерминированные
 * правила. На выходе два слоя:
 *   value — каноническое представление для показа и хранения;
 *   key   — ключ сравнения (факт-идентичность): там, где регистр не несёт
 *           смысла (email, домены, имена, адреса), key — casefold(value).
 *
 * Один и тот же вход всегда даёт один и тот же результат — иначе
 * идемпотентность enrichment (§26.9) невозможна.
 */

export type NormalizedFactValue = {
  /** Каноническое представление (сохраняется в fact.value). */
  value: string;
  /** Ключ сравнения (fact.fact_key). */
  key: string;
};

/** Query-параметры, которые является чистым tracking-шумом (§26.5 URL). */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_reader",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "yclid",
  "msclkid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "openstat",
  "_openstat",
  "from",
  "referer",
  "referrer",
]);

const collapseWs = (value: string): string =>
  value.replace(/\s+/g, " ").trim();

const casefold = (value: string): string => collapseWs(value).toLowerCase();

/** TRIM + collapse whitespace + ё→е, без изменения смысла. */
function prettyText(value: string): string {
  return collapseWs(String(value ?? "")).replace(/ё/g, "е").replace(/Ё/g, "Е");
}

/**
 * Email: trim, домен — lowercase, локальная часть не трогаем (RFC 5321),
 * исходный регистр не уничтожаем — raw хранится отдельно.
 */
export function normalizeEmail(raw: string): NormalizedFactValue | null {
  const value = prettyText(raw);
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  const canonical = `${local}@${domain}`;
  return { value: canonical, key: canonical.toLowerCase() };
}

/**
 * Домен: lowercase, без схемы/пути/www, без завершающей точки.
 * Разные subdomains НЕ считаются одним доменом — убирается только ведущий
 * «www.» (эквивалент apex по веб-конвенции).
 */
export function normalizeDomain(raw: string): NormalizedFactValue | null {
  let host = prettyText(raw).toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split("?")[0] ?? "";
  host = host.split(":")[0] ?? "";
  host = host.replace(/^www\./, "").replace(/\.+$/, "");
  if (!host || !host.includes(".")) return null;
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return { value: host, key: host };
}

/**
 * URL (§26.5): lowercase scheme+host, без фрагмента, без известного
 * tracking-шума, параметры в детерминированном порядке, trailing slash
 * нормализован (корень — без слэша). Query сохраняется целиком, кроме
 * tracking-списка. Схема в value сохраняется как в источнике, но в key не
 * входит — http и https одного ресурса сходятся к одному факту.
 */
export function normalizeWebUrl(raw: string): NormalizedFactValue | null {
  const input = prettyText(raw);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return null;
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !TRACKING_PARAMS.has(name.toLowerCase()))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const search = params.length
    ? "?" +
      params
        .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
        .join("&")
    : "";
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path === "/") path = "";
  const origin = `${url.protocol}//${host}`;
  const value = `${origin}${path}${search}`;
  const key = `${host}${path}${search}`;
  return { value, key };
}

/** Социальный профиль: network → handle (§26.5 Social). */
type SocialRule = { network: OsintFactType; hosts: string[] };

const SOCIAL_RULES: readonly SocialRule[] = [
  { network: "vk", hosts: ["vk.com", "vk.ru"] },
  { network: "telegram", hosts: ["t.me", "telegram.me", "telegram.dog"] },
  { network: "instagram", hosts: ["instagram.com", "instagr.am"] },
  { network: "facebook", hosts: ["facebook.com", "fb.com"] },
  { network: "youtube", hosts: ["youtube.com", "m.youtube.com"] },
  { network: "tiktok", hosts: ["tiktok.com"] },
];

const OTHER_SOCIAL_HOSTS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "ok.ru",
  "dzen.ru",
  "rutube.ru",
  "pinterest.com",
];

/**
 * Нормализация social URL/строки до канонической идентичности профиля:
 * `network:handle`. `vk.com/example` и `https://www.vk.com/example/` — одно
 * профиль; `vk.com/example` и `vk.com/example2` — разные.
 * Для неизвестных сетей (other_social) идентичность — host + путь: не
 * выдумываем семантику чужих маршрутов.
 */
export function normalizeSocial(
  factType: OsintFactType,
  raw: string,
): NormalizedFactValue | null {
  let input = prettyText(raw).toLowerCase();
  if (!input) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = `https://${input}`;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const rule = SOCIAL_RULES.find((entry) => entry.hosts.includes(host));
  const isOther =
    !rule && OTHER_SOCIAL_HOSTS.some((other) => host === other || host.endsWith(`.${other}`));
  if (!rule && !isOther) return null;

  if (!rule) {
    const path = url.pathname.replace(/\/+$/, "").toLowerCase();
    if (!path) return null;
    return { value: `other:${host}${path}`, key: `other:${host}${path}` };
  }

  const segments = url.pathname
    .split("/")
    .map((segment) => decodeURIComponent(segment).replace(/^@/, ""))
    .filter((segment) => segment.length > 0);

  let handle: string | null = null;
  if (rule.network === "youtube") {
    const marker = segments[0];
    if (marker === "channel" || marker === "c" || marker === "user") {
      handle = segments.slice(0, 2).join("/");
    } else if (marker) {
      handle = marker;
    }
  } else if ((segments[0] ?? "").endsWith(".php")) {
    // facebook profile.php?id=… — идентичность в query, не в пути.
    const id = url.searchParams.get("id");
    handle = id ? `id:${id}` : null;
  } else if (
    (segments[0] === "people" || segments[0] === "profile" || segments[0] === "in") &&
    segments[1]
  ) {
    handle = segments.slice(1).join("/");
  } else {
    handle = segments[0] ?? null;
  }
  if (!handle) return null;
  handle = handle.replace(/\/+$/, "").toLowerCase();
  if (!handle) return null;

  return { value: `${rule.network}:${handle}`, key: `${rule.network}:${handle}` };
}

/**
 * Адрес (§26.5): только осторожная детерминированная нормализация —
 * пробелы, ё→е, явные типовые сокращения. Без геокодирования и без
 * попыток выделить город «по здравому смыслу».
 */
export function normalizeAddress(raw: string): NormalizedFactValue | null {
  let value = prettyText(raw);
  if (!value) return null;
  // NB: \b не работает с кириллицей (границы слова определены только для
  // [A-Za-z0-9_]), поэтому позиция задаётся явно: (^|\s) перед аббревиатурой.
  value = value
    .replace(/(^|\s)ул\.\s*/gi, "$1улица ")
    .replace(/(^|\s)улица\s+/gi, "$1улица ")
    .replace(/(^|\s)пр\.(?=\s)/gi, "$1проспект")
    .replace(/(^|\s)просп\.\s*/gi, "$1проспект ")
    .replace(/(^|\s)пер\.\s*/gi, "$1переулок ")
    .replace(/(^|\s)наб\.\s*/gi, "$1набережная ")
    .replace(/(^|\s)бул\.\s*/gi, "$1бульвар ")
    .replace(/(^|\s)ш\.(?=\s)/gi, "$1шоссе")
    .replace(/(^|\s)д\.(?=\s)/gi, "$1дом ")
    .replace(/\s+/g, " ")
    .trim();
  return { value, key: casefold(value) };
}

/**
 * Публичный идентификатор: консервативно — только trim/collapse и casefold.
 * Детерминированная экстракция таких значений из текста не производится
 * (§26.2) — тип существует для структурированных источников.
 */
function normalizeIdentifier(raw: string): NormalizedFactValue | null {
  const value = prettyText(raw);
  if (!value) return null;
  return { value, key: casefold(value) };
}

/** Свободный текст (имя, категория, часы…): pretty + casefold-key. */
function normalizeFreeText(raw: string): NormalizedFactValue | null {
  const value = prettyText(raw);
  if (!value) return null;
  return { value, key: normalizeText(value) || casefold(value) };
}

/** Телефон: общий с Stage 3 normalizePhone — 10–15 цифр, 8→7 (§26.5). */
function normalizePhoneFact(raw: string): NormalizedFactValue | null {
  const digits = digitSequence(raw);
  const phone = normalizePhone(digits);
  if (!phone) return null;
  return { value: phone, key: phone };
}

/**
 * Единая точка входа: raw → каноническое значение для конкретного типа.
 * `null` — значение непригодно как факт (например, телефон из 4 цифр):
 * факт в этом случае не создаётся, а не сохраняется «как есть».
 */
export function normalizeFactValue(
  factType: OsintFactType,
  raw: string,
): NormalizedFactValue | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  switch (factType) {
    case "phone":
      return normalizePhoneFact(text);
    case "email":
      return normalizeEmail(text);
    case "domain":
      return normalizeDomain(text);
    case "website":
      return normalizeWebUrl(text);
    case "telegram":
    case "vk":
    case "instagram":
    case "facebook":
    case "youtube":
    case "tiktok":
    case "other_social":
      return normalizeSocial(factType, text);
    case "address":
      return normalizeAddress(text);
    case "postal_code": {
      const digits = digitSequence(text);
      if (digits.length === 6) return { value: digits, key: digits };
      return normalizeFreeText(text);
    }
    case "registration_identifier":
    case "tax_identifier":
    case "license_identifier":
      return normalizeIdentifier(text);
    default:
      return normalizeFreeText(text);
  }
}

/**
 * Детерминированный отпечаток fact-строки: (business, type, key, source).
 * Одинаковый вход → одинаковый fingerprint → UNIQUE(gusiness_id, fingerprint)
 * делает повторный enrichment идемпотентным (§26.9).
 */
export function factFingerprint(input: {
  businessId: string;
  factType: OsintFactType;
  factKey: string;
  sourceId: string;
}): string {
  return createHash("sha256")
    .update(
      [input.businessId, input.factType, input.factKey, input.sourceId].join(
        "\u0000",
      ),
    )
    .digest("hex");
}

/**
 * Детерминированный отпечаток change event: переход целиком
 * (business, type, key, kind, old, new, source). Повторный пересчёт того же
 * перехода даёт тот же отпечаток → дубль гасится UNIQUE (§26.9).
 */
export function changeFingerprint(input: {
  businessId: string;
  factType: OsintFactType;
  factKey: string;
  changeKind: string;
  oldValue: string | null;
  newValue: string | null;
  sourceId: string | null;
}): string {
  return createHash("sha256")
    .update(
      [
        input.businessId,
        input.factType,
        input.factKey,
        input.changeKind,
        input.oldValue ?? "",
        input.newValue ?? "",
        input.sourceId ?? "",
      ].join("\u0000"),
    )
    .digest("hex");
}
