import { isIP } from "node:net";

/**
 * Нормализация URL для дедупликации discovery-результатов (§20).
 * Удаляются ТОЛЬКО известные трекинговые параметры: параметры, меняющие
 * содержимое страницы, сохраняются. Порядок параметров упорядочивается.
 */

const TRACKING_PARAMS = new Set([
  "gclid",
  "yclid",
  "dclid",
  "gclsrc",
  "fbclid",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_openstat",
  "wbraid",
  "gbraid",
]);

const TRACKING_PREFIXES = ["utm_", "ym_"];

export type NormalizeUrlResult =
  | {
      ok: true;
      url: string;
      host: string;
      registrableDomain: string | null;
      path: string;
      protocol: string;
    }
  | { ok: false; reason: string };

function isTrackingParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (TRACKING_PARAMS.has(lower)) return true;
  return TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function normalizeUrl(raw: string): NormalizeUrlResult {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    return { ok: false, reason: "protocol_not_allowed" };
  if (parsed.username || parsed.password)
    return { ok: false, reason: "credentials_in_url" };

  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "empty_host" };

  parsed.hash = "";

  const params = [...parsed.searchParams.entries()].filter(
    ([key]) => !isTrackingParam(key),
  );
  params.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const search = params.length
    ? "?" +
      params
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&")
    : "";

  let path = parsed.pathname || "/";
  while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (!path) path = "/";

  const port = parsed.port ? `:${parsed.port}` : "";
  const url = `${parsed.protocol}//${host}${port}${path}${search}`;

  return {
    ok: true,
    url,
    host,
    registrableDomain: registrableDomain(host),
    path,
    protocol: parsed.protocol,
  };
}

/**
 * Регистрируемый домен (упрощённый public-suffix): последние две метки,
 * кроме известных двухуровневых суффиксов. IP → null.
 */
const TWO_LEVEL_SUFFIXES = new Set([
  "com.ru",
  "net.ru",
  "org.ru",
  "gov.ru",
  "co.uk",
  "org.uk",
  "com.ua",
  "net.ua",
  "com.au",
  "co.jp",
  "com.cn",
  "com.tr",
]);

export function registrableDomain(host: string): string | null {
  const lower = String(host ?? "")
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^\[|\]$/g, "");
  if (!lower) return null;
  if (isIP(lower)) return null;
  const labels = lower.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LEVEL_SUFFIXES.has(lastTwo))
    return labels.slice(-3).join(".");
  return lastTwo;
}

/** Точный хост или его поддомен: `www.site.ru` совпадает с `site.ru`. */
export function hostMatches(host: string, domain: string): boolean {
  const left = String(host ?? "").toLowerCase().replace(/\.$/, "");
  const right = String(domain ?? "").toLowerCase().replace(/\.$/, "");
  if (!left || !right) return false;
  return left === right || left.endsWith("." + right);
}

/** Набор исключений паспорта: точные URL и регистрируемые домены. */
export type UrlExclusion = {
  urls: readonly string[];
  domains: readonly string[];
};

/**
 * Исключён ли URL: точное совпадение/префикс нормализованного URL либо
 * совпадение хоста/регистрируемого домена. Match детерминирован и читается
 * человеком — для чтения человеком нужны обе ветки.
 */
export function isUrlExcluded(url: string, excluded: UrlExclusion): boolean {
  let host = "";
  let domain: string | null = null;
  try {
    host = new URL(url).hostname.toLowerCase();
    domain = registrableDomain(host);
  } catch {
    return false;
  }
  for (const entry of excluded.urls) {
    if (!entry) continue;
    if (url === entry || url.startsWith(entry)) return true;
    try {
      const entryDomain = registrableDomain(new URL(entry).hostname);
      if (entryDomain && entryDomain === domain) return true;
    } catch {
      /* entry должен быть нормализован вызывающим — иначе это не совпадение */
    }
  }
  for (const entry of excluded.domains) {
    if (!entry) continue;
    if (entry === domain || entry === host) return true;
  }
  return false;
}
