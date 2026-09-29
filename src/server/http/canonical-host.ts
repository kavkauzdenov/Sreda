/**
 * Single-origin public host policy for «БизнеСоты».
 *
 * Source of truth for the public origin is APP_URL (exact HTTPS origin).
 * Alias brand hosts redirect browser-safe GET/HEAD to that origin. They are
 * never trusted auth origins and never weaken CSRF / requireOrigin.
 */

/** Brand aliases that only redirect to the APP_URL host. */
export const PUBLIC_ALIAS_HOSTS = Object.freeze(
  new Set([
    "biznesoty.online",
    "www.biznesoty.online",
    // бизнесоты.рф
    "xn--90aifd0ahuj5f.xn--p1ai",
    "www.biznesoty.ru",
  ]),
);

const HEALTH_PATHS = Object.freeze([
  "/api/health",
  "/api/health/web",
  "/api/health/live",
]);

/** Provider ingress must keep working on the registered webhook URL. */
const WEBHOOK_PREFIXES = Object.freeze([
  "/api/telegram/",
  "/api/vk/",
  "/api/meta/webhook",
]);

export type CanonicalDecision =
  | { action: "pass" }
  | { action: "redirect"; location: string; status: 308 }
  | { action: "reject"; status: 403; code: string; message: string };

export function normalizeHostname(raw: string | null | undefined): string {
  if (!raw) return "";
  const first = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  if (!first) return "";
  // Strip :port (IPv6 in brackets is not used for our public hosts).
  let host = first.startsWith("[") ? first : first.replace(/:\d+$/, "");
  // Unicode brand hosts (e.g. бизнесоты.рф) → punycode ASCII form.
  if (/[^\x00-\x7f]/.test(host)) {
    try {
      host = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      /* keep original */
    }
  }
  return host;
}

/**
 * Resolve the public request host.
 * Prefer Host; accept a single X-Forwarded-Host only when Host is empty.
 * Never trust forwarded host as a redirect *destination*.
 */
export function resolveRequestHostname(headers: Headers): string {
  const host = normalizeHostname(headers.get("host"));
  if (host) return host;
  return normalizeHostname(headers.get("x-forwarded-host"));
}

export function parseAppOrigin(
  appUrl: string | null | undefined,
): URL | null {
  const value = appUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.origin !== value) return null;
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url;
  } catch {
    return null;
  }
}

export function isPublicAliasHost(hostname: string): boolean {
  return PUBLIC_ALIAS_HOSTS.has(normalizeHostname(hostname));
}

export function isExemptFromCanonicalRedirect(pathname: string): boolean {
  if (HEALTH_PATHS.includes(pathname)) return true;
  return WEBHOOK_PREFIXES.some(
    (prefix) => pathname === prefix.replace(/\/$/, "") || pathname.startsWith(prefix),
  );
}

export function isSafeBrowserMethod(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

export function buildCanonicalLocation(
  canonicalOrigin: string,
  pathname: string,
  search: string,
): string {
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const query = search && !search.startsWith("?") ? `?${search}` : search;
  return canonicalOrigin + path + query;
}

/**
 * Decide whether a request should pass, redirect to APP_URL, or be rejected.
 * Redirect destination host always comes from APP_URL — never from request input.
 */
export function decideCanonicalHost(input: {
  method: string;
  hostname: string;
  pathname: string;
  search: string;
  appUrl: string | null | undefined;
}): CanonicalDecision {
  const canonical = parseAppOrigin(input.appUrl);
  if (!canonical) return { action: "pass" };

  const host = normalizeHostname(input.hostname);
  const canonicalHost = normalizeHostname(canonical.hostname);
  if (!host || host === canonicalHost) return { action: "pass" };

  if (isExemptFromCanonicalRedirect(input.pathname)) {
    return { action: "pass" };
  }

  // Only known brand aliases redirect. Unknown hosts are left alone.
  if (!isPublicAliasHost(host)) {
    return { action: "pass" };
  }

  if (!isSafeBrowserMethod(input.method)) {
    return {
      action: "reject",
      status: 403,
      code: "NON_CANONICAL_HOST",
      message: "Используйте основной адрес приложения.",
    };
  }

  // API GET/HEAD on aliases: reject rather than HTML-redirect clients.
  if (input.pathname.startsWith("/api/")) {
    return {
      action: "reject",
      status: 403,
      code: "NON_CANONICAL_HOST",
      message: "Используйте основной адрес приложения.",
    };
  }

  return {
    action: "redirect",
    status: 308,
    location: buildCanonicalLocation(
      canonical.origin,
      input.pathname,
      input.search,
    ),
  };
}
