import { lookup as dnsLookup } from "node:dns/promises";

/**
 * SSRF-safe fetch (§16): DNS-резолв → проверка ВСЕХ IP до соединения →
 * ручной follow redirect с повторной проверкой каждой цели.
 * lookup/transport внедряются — модуль тестируется без сети.
 */

export type TransportInit = {
  method: "GET" | "HEAD";
  headers: Record<string, string>;
  maxBytes: number;
  signal?: AbortSignal;
  /**
   * Если задано, defaultTransport не читает тело ответа с другим
   * content-type — бандл экономится до отказа в safeFetch.
   */
  acceptContentTypes?: readonly string[];
};

export type TransportResponse = {
  status: number;
  /** Ключи в нижнем регистре. */
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
};

export type Transport = (
  url: string,
  init: TransportInit,
) => Promise<TransportResponse>;

export type SafeFetchOptions = {
  method?: "GET" | "HEAD";
  maxBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxRedirects?: number;
  /** Только для тестов/dev: разрешить приватные диапазоны. */
  allowPrivateNetworks?: boolean;
  signal?: AbortSignal;
  /**
   * Белый список content-type (по префиксу, без параметров charset).
   * Ответ с другим типом отклоняется как `unsupported_content_type`,
   * не загружая тело. Без опции список не проверяется (обратная
   * совместимость).
   */
  acceptContentTypes?: readonly string[];
};

export type SafeFetchRejectReason =
  | "invalid_url"
  | "protocol_not_allowed"
  | "credentials_in_url"
  | "private_address"
  | "dns_failed"
  | "redirect_limit"
  | "too_large"
  | "http_error"
  | "timeout"
  | "aborted"
  | "transport_error"
  | "unsupported_content_type";

export type SafeFetchResult =
  | {
      ok: true;
      status: number;
      url: string;
      contentType: string | null;
      body: string;
      truncated: boolean;
      resolvedIp: string;
      redirects: number;
    }
  | { ok: false; reason: SafeFetchRejectReason; detail?: string };

export type SafeFetchDeps = {
  /** Все IP хоста (A + AAAA). По умолчанию node:dns. */
  lookup?: (hostname: string) => Promise<string[]>;
  transport?: Transport;
  allowPrivateNetworks?: boolean;
};

const DEFAULT_MAX_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;

function ipv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255))
    return null;
  return octets;
}

/** Приватные/служебные диапазоны IPv4 и IPv6 (включая metadata endpoint). */
export function isPrivateIp(ip: string): boolean {
  const clean = ip.trim().replace(/^\[|\]$/g, "");

  const dotted = clean.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return isPrivateIp(dotted[1]!);

  const hex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (hex) {
    const high = parseInt(hex[1]!, 16);
    const low = parseInt(hex[2]!, 16);
    return isPrivateIp(
      `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`,
    );
  }

  const v4 = ipv4Octets(clean);
  if (v4) {
    const [a, b, c] = v4;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b! >= 16 && b! <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF/TEST-NET-1
    if (a === 100 && b! >= 64 && b! <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
    if (a! >= 224) return true; // multicast + reserved + broadcast
    return false;
  }

  const lower = clean.toLowerCase();
  if (lower === "::" || lower === "::0" || lower === "::1") return true;
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (/^ff/.test(lower)) return true; // ff00::/8 multicast
  if (lower.startsWith("64:ff9b")) return true; // NAT64
  return false;
}

function combineSignals(
  timeoutMs: number,
  caller: AbortSignal | undefined,
): AbortSignal | undefined {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([timeout, caller]);
  const controller = new AbortController();
  const onAbort = () => controller.abort(caller.reason);
  caller.addEventListener("abort", onAbort, { once: true });
  timeout.addEventListener("abort", () => controller.abort(timeout.reason), {
    once: true,
  });
  return controller.signal;
}

async function defaultLookup(hostname: string): Promise<string[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

/** Префиксное сравнение content-type без учёта charset и регистра. */
function contentTypeAllowed(
  contentType: string | null | undefined,
  allowed: readonly string[] | undefined,
): boolean {
  if (!allowed?.length) return true;
  if (!contentType) return true;
  const lower = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!lower) return true;
  return allowed.some((entry) => lower.startsWith(entry.toLowerCase()));
}

async function defaultTransport(
  url: string,
  init: TransportInit,
): Promise<TransportResponse> {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    redirect: "manual",
    signal: init.signal,
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const declared = Number(headers["content-length"] ?? "");
  if (Number.isFinite(declared) && declared > init.maxBytes) {
    return { status: response.status, headers, body: "", truncated: true };
  }

  if (!contentTypeAllowed(headers["content-type"], init.acceptContentTypes)) {
    return { status: response.status, headers, body: "", truncated: false };
  }

  if (init.method === "HEAD" || !response.body) {
    return { status: response.status, headers, body: "" };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = init.maxBytes - total;
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, Math.max(0, remaining)));
      total = init.maxBytes;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const body = Buffer.concat(chunks).toString("utf8");
  return { status: response.status, headers, body, truncated };
}

function reject(
  reason: SafeFetchRejectReason,
  detail?: string,
): SafeFetchResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowPrivate =
    options.allowPrivateNetworks ?? deps.allowPrivateNetworks ?? false;
  const lookup = deps.lookup ?? defaultLookup;
  const transport = deps.transport ?? defaultTransport;
  const method = options.method ?? "GET";
  const signal = combineSignals(timeoutMs, options.signal);

  let current = rawUrl;
  let redirects = 0;

  for (;;) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return reject("invalid_url", current);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      return reject("protocol_not_allowed", parsed.protocol);
    if (parsed.username || parsed.password)
      return reject("credentials_in_url", parsed.host);

    let addresses: string[];
    try {
      addresses = await lookup(parsed.hostname);
    } catch (error) {
      return reject("dns_failed", error instanceof Error ? error.message : String(error));
    }
    if (!addresses.length) return reject("dns_failed", parsed.hostname);

    const bad = addresses.find((address) => isPrivateIp(address));
    if (bad && !allowPrivate)
      return reject("private_address", `${parsed.hostname} -> ${bad}`);

    let response: TransportResponse;
    try {
      response = await transport(parsed.toString(), {
        method,
        headers: {
          "user-agent": options.headers?.["user-agent"] ?? "BizneSotyBot/1.0 (+osint)",
          accept: options.headers?.accept ?? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
          ...options.headers,
        },
        maxBytes,
        signal,
        acceptContentTypes: options.acceptContentTypes,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/abort|timeout/i.test(message)) {
        return options.signal?.aborted ? reject("aborted", message) : reject("timeout", message);
      }
      return reject("transport_error", message);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers["location"];
      if (!location) return reject("http_error", `redirect_without_location:${response.status}`);
      redirects += 1;
      if (redirects > maxRedirects) return reject("redirect_limit", String(maxRedirects));
      try {
        current = new URL(location, parsed).toString();
      } catch {
        return reject("invalid_url", location);
      }
      continue;
    }

    if (response.status >= 400)
      return reject("http_error", String(response.status));

    if (!contentTypeAllowed(response.headers["content-type"], options.acceptContentTypes))
      return reject(
        "unsupported_content_type",
        response.headers["content-type"] ?? "missing",
      );

    return {
      ok: true,
      status: response.status,
      url: parsed.toString(),
      contentType: response.headers["content-type"] ?? null,
      body: response.body,
      truncated: Boolean(response.truncated),
      resolvedIp: addresses[0]!,
      redirects,
    };
  }
}
