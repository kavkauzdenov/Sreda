import { createOwnUrlsProvider } from "./own-urls.ts";
import { createVkProvider, type VkProviderOptions } from "./vk.ts";
import {
  createWebPageProvider,
  type WebPageProviderOptions,
} from "./web-page.ts";
import { createRegistry, type ProviderRegistry } from "./registry.ts";
import type { OsintProvider } from "./types.ts";

/**
 * Стандартный набор провайдеров приложения (§25):
 * поиск — объявленные URL бизнеса + официальный VK API (при наличии
 * токена), crawl — HTTP-провайдер страниц. Тесты могут подменить любой
 * из трёх, production собирает здесь же.
 */
export type BuiltinRegistryOptions = {
  webPage?: WebPageProviderOptions;
  vk?: VkProviderOptions;
  extraSearch?: readonly OsintProvider[];
};

export function createBuiltinRegistry(
  options: BuiltinRegistryOptions = {},
): ProviderRegistry {
  return createRegistry(
    [createOwnUrlsProvider(), createVkProvider(options.vk ?? {}), ...(options.extraSearch ?? [])],
    [createWebPageProvider(options.webPage ?? {})],
  );
}
