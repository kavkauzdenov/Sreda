import type { DiscoveryIntent } from "../config.ts";
import type {
  OsintProvider,
  ProviderSearchInput,
  ProviderSearchResult,
} from "./types.ts";

/**
 * Тестируемый мок-провайдер: детерминированные результаты, никакой сети.
 * Используется в unit-тестах discovery-оркестратора (§37).
 */
export type MockProviderOptions = {
  id?: string;
  label?: string;
  enabledByDefault?: boolean;
  intents?: DiscoveryIntent[];
  /** Статичный список результатов на любой запрос. */
  results?: ProviderSearchResult[];
  /** Генератор результатов из запроса (вместо results). */
  respond?: (input: ProviderSearchInput) => ProviderSearchResult[];
  /** Симуляция отказа провайдера (run → partial/failed). */
  fail?: string | Error | null;
};

export function createMockProvider(options: MockProviderOptions = {}): OsintProvider {
  const id = options.id ?? "mock";
  return {
    descriptor: {
      id,
      label: options.label ?? `Mock provider ${id}`,
      types: ["website", "directory", "social_network", "maps", "review_platform"],
      intents: options.intents ?? ["any"],
      requiresNetwork: false,
      enabledByDefault: options.enabledByDefault ?? true,
      policy: "structured_data",
      rateLimitPerMinute: 120,
    },
    async search(input: ProviderSearchInput) {
      if (options.fail) {
        throw typeof options.fail === "string" ? new Error(options.fail) : options.fail;
      }
      const results = options.respond
        ? options.respond(input)
        : [...(options.results ?? [])];
      return { results: results.slice(0, Math.max(0, input.limit)) };
    },
  };
}
