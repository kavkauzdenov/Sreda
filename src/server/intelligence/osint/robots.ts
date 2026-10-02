import {
  safeFetch,
  type SafeFetchDeps,
  type SafeFetchOptions,
  type SafeFetchResult,
} from "./safe-fetch.ts";

/**
 * robots.txt для обхода (§25, RFC 9309 с ослаблениями).
 *
 * Берётся только группа `*` и группа с нашим UA; `Allow` выигрывает при
 * равной длине правила. robots.txt, который не удалось получить
 * (404/сеть/запрет сети), трактуется как «разрешено» — как в RFC; кэш в
 * памяти живёт один run (инстанс чекера создаётся на запуск).
 */

export type RobotsRules = {
  allow: string[];
  disallow: string[];
};

export type RobotsDecision =
  | { allowed: true }
  | { allowed: false; reason: "robots_disallowed"; pattern: string };

const DEFAULT_UA = "BizneSotyBot/1.0 (+osint)";

export function parseRobots(
  text: string,
  userAgent: string = DEFAULT_UA,
): RobotsRules {
  const uaToken = userAgent.toLowerCase().split(/[\s/;(]/)[0] ?? "";
  const rules: RobotsRules = { allow: [], disallow: [] };
  const specific: RobotsRules = { allow: [], disallow: [] };

  let activeGroup: "none" | "wildcard" | "specific" = "none";
  let sawRule = false;

  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === "user-agent") {
      const group = value.toLowerCase();
      if (sawRule) {
        activeGroup = "none";
        sawRule = false;
      }
      if (group === "*") {
        if (activeGroup === "none") activeGroup = "wildcard";
      } else if (
        uaToken &&
        (uaToken.startsWith(group) || group.startsWith(uaToken))
      ) {
        if (activeGroup === "none" || activeGroup === "specific")
          activeGroup = "specific";
      }
      continue;
    }

    if (field === "disallow" || field === "allow") {
      if (activeGroup === "none") continue;
      sawRule = true;
      if (!value) continue; // пустой Disallow = разрешить всё
      const bucket = activeGroup === "specific" ? specific : rules;
      if (field === "disallow") bucket.disallow.push(value);
      else bucket.allow.push(value);
    }
  }

  // Группа конкретного UA перекрывает wildcard (RFC 9309).
  return specific.allow.length || specific.disallow.length ? specific : rules;
}

const REGEX_SPECIALS = "\\^$.|?+()[]{}";

function patternToRegex(pattern: string): RegExp | null {
  if (!pattern) return null;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  let out = "";
  for (const char of body) {
    if (char === "*") out += ".*";
    else if (REGEX_SPECIALS.includes(char)) out += "\\" + char;
    else out += char;
  }
  try {
    return new RegExp("^" + out + (anchored ? "$" : ""));
  } catch {
    return null;
  }
}

/** Самое длинное совпадение выигрывает; при равной длине — Allow. */
export function robotsAllows(rules: RobotsRules, path: string): RobotsDecision {
  const target = path || "/";
  let bestAllow = -1;
  let bestDisallow = -1;
  let allowPattern = "";
  let disallowPattern = "";

  for (const pattern of rules.allow) {
    const regex = patternToRegex(pattern);
    if (!regex || !regex.test(target)) continue;
    if (pattern.length > bestAllow) {
      bestAllow = pattern.length;
      allowPattern = pattern;
    }
  }
  for (const pattern of rules.disallow) {
    const regex = patternToRegex(pattern);
    if (!regex || !regex.test(target)) continue;
    if (pattern.length > bestDisallow) {
      bestDisallow = pattern.length;
      disallowPattern = pattern;
    }
  }

  if (bestDisallow < 0) return { allowed: true };
  if (bestAllow >= bestDisallow) return { allowed: true };
  return {
    allowed: false,
    reason: "robots_disallowed",
    pattern: disallowPattern || allowPattern,
  };
}

export type RobotsCheckerOptions = {
  userAgent?: string;
  /** Инжектируемая загрузка (тесты); по умолчанию safeFetch. */
  fetchFn?: (url: string, options: SafeFetchOptions) => Promise<SafeFetchResult>;
  fetchOptions?: SafeFetchOptions;
  deps?: SafeFetchDeps;
  signal?: AbortSignal;
  /** TTL кэша в памяти; 0 — один результат на origin на весь инстанс. */
  ttlMs?: number;
  now?: () => number;
};

export type RobotsChecker = {
  isAllowed(url: string): Promise<RobotsDecision>;
  /** Сколько robots.txt реально загружено (для бюджета запросов). */
  fetchedCount(): number;
};

type CacheEntry = { rules: RobotsRules | null; fetchedAt: number };

export function createRobotsChecker(
  options: RobotsCheckerOptions = {},
): RobotsChecker {
  const userAgent = options.userAgent ?? DEFAULT_UA;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? 0;
  const cache = new Map<string, CacheEntry>();
  let fetched = 0;

  async function loadRules(origin: string): Promise<RobotsRules | null> {
    const cached = cache.get(origin);
    if (cached && (ttlMs === 0 || now() - cached.fetchedAt < ttlMs))
      return cached.rules;

    const fetchFn =
      options.fetchFn ??
      ((url: string, opts: SafeFetchOptions) =>
        safeFetch(url, opts, options.deps ?? {}));
    fetched += 1;
    let rules: RobotsRules | null = null;
    try {
      const response = await fetchFn(`${origin}/robots.txt`, {
        method: "GET",
        maxBytes: 65_536,
        timeoutMs: 5_000,
        acceptContentTypes: ["text/plain", "text/*"],
        headers: { "user-agent": userAgent },
        signal: options.signal,
        ...options.fetchOptions,
      });
      if (response.ok && response.status === 200 && response.body) {
        rules = parseRobots(response.body, userAgent);
      }
    } catch {
      rules = null; // недоступный robots.txt не блокирует (RFC 9309)
    }
    cache.set(origin, { rules, fetchedAt: now() });
    return rules;
  }

  return {
    async isAllowed(url: string): Promise<RobotsDecision> {
      let origin: string;
      let path: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
          return { allowed: true };
        origin = parsed.origin;
        path = `${parsed.pathname}${parsed.search}`;
      } catch {
        return { allowed: true };
      }
      const rules = await loadRules(origin);
      if (!rules) return { allowed: true };
      return robotsAllows(rules, path);
    },
    fetchedCount: () => fetched,
  };
}
