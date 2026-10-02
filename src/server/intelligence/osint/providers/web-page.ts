import {
  safeFetch,
  type SafeFetchDeps,
} from "../safe-fetch.ts";
import { normalizePage } from "../extraction/page.ts";
import type {
  OsintPageProvider,
  PageFetchInput,
  PageFetchOutput,
} from "./types.ts";

/**
 * HTTP-провайдер загрузки страниц (§25): единственная точка, где OSINT
 * ходит в открытый web. Все сетевые ограничения — в safe-fetch (DNS →
 * проверка IP → ручной редирект), здесь только content-type, лимиты и
 * нормализация в ParsedPage.
 *
 * Обход авторизации/CAPTCHA/paywall запрещён контрактом §13: только
 * публичные страницы по http/https.
 */
export const WEB_PAGE_PROVIDER_ID = "web_page";

const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
];

export type WebPageProviderOptions = {
  deps?: SafeFetchDeps;
  /** Только тесты/dev — приватные диапазоны (см. safe-fetch). */
  allowPrivateNetworks?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
};

export function createWebPageProvider(
  options: WebPageProviderOptions = {},
): OsintPageProvider {
  return {
    descriptor: {
      id: WEB_PAGE_PROVIDER_ID,
      label: "Загрузка страниц (HTTP)",
      types: ["website", "social_network", "directory", "news", "other"],
      intents: ["any"],
      requiresNetwork: true,
      enabledByDefault: true,
      policy: "public_web",
      rateLimitPerMinute: 60,
    },
    async fetchPage(input: PageFetchInput): Promise<PageFetchOutput> {
      const response = await safeFetch(
        input.url,
        {
          method: "GET",
          maxBytes: input.maxBytes ?? options.maxBytes ?? 2_000_000,
          timeoutMs: input.timeoutMs ?? options.timeoutMs ?? 10_000,
          maxRedirects: options.maxRedirects ?? 3,
          allowPrivateNetworks: options.allowPrivateNetworks ?? false,
          acceptContentTypes: ALLOWED_CONTENT_TYPES,
          signal: input.signal,
        },
        options.deps ?? {},
      );

      if (!response.ok)
        return {
          ok: false,
          reason: response.reason,
          ...(response.detail !== undefined ? { detail: response.detail } : {}),
        };

      const page = normalizePage({
        requestedUrl: input.url,
        finalUrl: response.url,
        status: response.status,
        contentType: response.contentType,
        body: response.body,
        maxTextLength: 6_000,
        maxLinks: 300,
      });
      return { ok: true, page };
    },
  };
}
