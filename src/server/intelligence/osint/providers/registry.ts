import type { DiscoveryIntent } from "../config.ts";
import type {
  OsintPageProvider,
  OsintProvider,
  ProviderAvailability,
  ProviderDescriptor,
} from "./types.ts";

/**
 * Реестр провайдеров: единственная точка выбора «кто участвует в run'е».
 * Провайдер с policy "disabled" или без enabledByDefault не попадает в run
 * без явного списка в `osint_discovery_runs.providers`.
 *
 * Провайдеры с `availability().available === false` (нет токена окружения)
 * не участвуют в run'е — выборка молча их исключает, snapshot показывает
 * причину.
 */

type AnyProvider = OsintProvider | OsintPageProvider;

function isAvailable(provider: AnyProvider): boolean {
  if (!provider.availability) return true;
  try {
    return provider.availability().available;
  } catch {
    return false;
  }
}

export type ProviderDescriptorInfo = {
  descriptor: ProviderDescriptor;
  availability: ProviderAvailability;
};

export class ProviderRegistry {
  private readonly providers = new Map<string, OsintProvider>();
  private readonly pageProviders = new Map<string, OsintPageProvider>();

  register(provider: OsintProvider): this {
    const id = provider.descriptor.id;
    if (!id) throw new Error("provider id is required");
    if (this.providers.has(id) || this.pageProviders.has(id))
      throw new Error(`provider "${id}" is already registered`);
    this.providers.set(id, provider);
    return this;
  }

  registerPage(provider: OsintPageProvider): this {
    const id = provider.descriptor.id;
    if (!id) throw new Error("provider id is required");
    if (this.providers.has(id) || this.pageProviders.has(id))
      throw new Error(`provider "${id}" is already registered`);
    this.pageProviders.set(id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id) || this.pageProviders.has(id);
  }

  get(id: string): OsintProvider | null {
    return this.providers.get(id) ?? null;
  }

  getPage(id: string): OsintPageProvider | null {
    return this.pageProviders.get(id) ?? null;
  }

  list(): OsintProvider[] {
    return [...this.providers.values()];
  }

  listPages(): OsintPageProvider[] {
    return [...this.pageProviders.values()];
  }

  /** Все дескрипторы (поисковые + страниц) с динамической доступностью. */
  descriptorInfo(): ProviderDescriptorInfo[] {
    const all: AnyProvider[] = [...this.providers.values(), ...this.pageProviders.values()];
    return all.map((provider) => ({
      descriptor: provider.descriptor,
      availability: safeAvailability(provider),
    }));
  }

  descriptors(): ProviderDescriptor[] {
    return this.descriptorInfo().map((info) => info.descriptor);
  }

  /**
   * Провайдеры конкретного run'а.
   * - `requested == null` → включённые по умолчанию (и не disabled);
   * - иначе → явно запрошенные, но только зарегистрированные, не disabled
   *   и доступные (отсутствующий id молча пропускается — run уйдёт в
   *   partial/fail сам).
   */
  select(
    requested: readonly string[] | null | undefined,
    intents?: readonly DiscoveryIntent[],
  ): OsintProvider[] {
    const all = this.list();
    const usable = all.filter(
      (provider) =>
        provider.descriptor.policy !== "disabled" && isAvailable(provider),
    );
    const base =
      requested === null || requested === undefined || requested.length === 0
        ? usable.filter((provider) => provider.descriptor.enabledByDefault)
        : usable.filter((provider) => requested.includes(provider.descriptor.id));

    if (!intents?.length) return base;
    return base.filter((provider) =>
      intents.some(
        (intent) =>
          provider.descriptor.intents.includes(intent) ||
          provider.descriptor.intents.includes("any"),
      ),
    );
  }

  /** Crawl-провайдер run'а: явный id, иначе единственный зарегистрированный. */
  selectPage(requested?: string | null): OsintPageProvider | null {
    if (requested) return this.pageProviders.get(requested) ?? null;
    const pages = this.listPages().filter(
      (provider) =>
        provider.descriptor.policy !== "disabled" && isAvailable(provider),
    );
    return pages[0] ?? null;
  }
}

function safeAvailability(provider: AnyProvider): ProviderAvailability {
  try {
    return provider.availability?.() ?? { available: true };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message.slice(0, 120) : "unavailable",
    };
  }
}

export function createRegistry(
  providers: readonly OsintProvider[] = [],
  pageProviders: readonly OsintPageProvider[] = [],
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  for (const provider of pageProviders) registry.registerPage(provider);
  return registry;
}
