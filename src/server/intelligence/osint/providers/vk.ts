import {
  safeFetch,
  type SafeFetchDeps,
} from "../safe-fetch.ts";
import type {
  OsintProvider,
  ProviderSearchInput,
  ProviderSearchOutput,
  ProviderSearchResult,
} from "./types.ts";

/**
 * Провайдер «ВКонтакте» через официальный API (§13: только официальные
 * endpoint'ы с учётом лимитов). Метод `groups.search` ищет сообщества по
 * запросу — это единственный официальный способ найти соцсеть бизнеса
 * без обхода авторизации.
 *
 * Без `OSINT_VK_API_TOKEN` провайдер недоступен: availability() → false,
 * registry исключает его из run'а, snapshot показывает причину. Никаких
 * ключей в репозитории и в логах — токен только из переменной окружения.
 */
export const VK_PROVIDER_ID = "vk";

const API_VERSION = "5.199";
const API_URL = "https://api.vk.com/method/groups.search";

export type VkProviderOptions = {
  token?: string;
  apiVersion?: string;
  deps?: SafeFetchDeps;
  now?: () => number;
  rateLimitPerMinute?: number;
  /** Инжектируемая загрузка (тесты):(url, options) → результат safeFetch. */
  fetchFn?: typeof safeFetch;
};

type VkGroup = {
  id?: number;
  name?: string;
  screen_name?: string;
  type?: string;
};

export function createVkProvider(options: VkProviderOptions = {}): OsintProvider {
  const token = (options.token ?? process.env.OSINT_VK_API_TOKEN ?? "").trim();
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimitPerMinute ?? 30;
  const callTimestamps: number[] = [];

  const availability = () =>
    token
      ? ({ available: true } as const)
      : ({
          available: false,
          reason: "osint_vk_token_missing",
        } as const);

  const acquireRateSlot = (): void => {
    const current = now();
    while (callTimestamps.length && current - callTimestamps[0]! > 60_000)
      callTimestamps.shift();
    if (callTimestamps.length >= rateLimit)
      throw new Error("provider_rate_limited");
    callTimestamps.push(current);
  };

  return {
    descriptor: {
      id: VK_PROVIDER_ID,
      label: "ВКонтакте (официальный API)",
      types: ["social_network"],
      intents: ["social", "any"],
      requiresNetwork: true,
      enabledByDefault: true,
      policy: "official_api",
      rateLimitPerMinute: rateLimit,
      documentationUrl: "https://dev.vk.com/ru/reference/groups/search",
    },
    availability,
    async search(input: ProviderSearchInput): Promise<ProviderSearchOutput> {
      if (!token) throw new Error("provider_not_configured");
      acquireRateSlot();

      const url = new URL(API_URL);
      url.searchParams.set("q", input.query.text);
      url.searchParams.set("count", String(Math.max(1, Math.min(20, input.limit))));
      url.searchParams.set("v", options.apiVersion ?? API_VERSION);
      url.searchParams.set("access_token", token);

      const fetchFn = options.fetchFn ?? safeFetch;
      const response = await fetchFn(
        url.toString(),
        {
          method: "GET",
          timeoutMs: 8_000,
          maxBytes: 500_000,
          acceptContentTypes: ["application/json"],
          headers: { accept: "application/json" },
          signal: input.signal,
        },
        options.deps ?? {},
      );
      if (!response.ok)
        throw new Error(`vk_api_${response.reason}`);

      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error("vk_api_invalid_response");
      }

      const record = payload as Record<string, unknown>;
      const error = record.error as { error_msg?: unknown } | undefined;
      if (error?.error_msg)
        throw new Error(`vk_api_error:${String(error.error_msg).slice(0, 200)}`);

      const items = (record.response as { items?: unknown } | undefined)?.items;
      const results: ProviderSearchResult[] = [];
      if (Array.isArray(items)) {
        for (const raw of items) {
          if (results.length >= input.limit) break;
          if (!raw || typeof raw !== "object") continue;
          const group = raw as VkGroup;
          const handle =
            typeof group.screen_name === "string" && group.screen_name
              ? group.screen_name
              : typeof group.id === "number"
                ? `club${group.id}`
                : null;
          if (!handle) continue;
          results.push({
            url: `https://vk.com/${handle}`,
            title: typeof group.name === "string" ? group.name : null,
            snippet: null,
            position: results.length + 1,
            externalId: typeof group.id === "number" ? String(group.id) : null,
            publishedAt: null,
          });
        }
      }
      return { results };
    },
  };
}
