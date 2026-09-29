import type { DiscoveryIntent } from "../config.ts";
import type { OsintProvider, ProviderDescriptor } from "./types.ts";

/**
 * Реестр провайдеров: единственная точка выбора «кто участвует в run'е».
 * Провайдер с policy "disabled" или без enabledByDefault не попадает в run
 * без явного списка в `osint_discovery_runs.providers`.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, OsintProvider>();

  register(provider: OsintProvider): this {
    const id = provider.descriptor.id;
    if (!id) throw new Error("provider id is required");
    if (this.providers.has(id))
      throw new Error(`provider "${id}" is already registered`);
    this.providers.set(id, provider);
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): OsintProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): OsintProvider[] {
    return [...this.providers.values()];
  }

  descriptors(): ProviderDescriptor[] {
    return this.list().map((provider) => provider.descriptor);
  }

  /**
   * Провайдеры конкретного run'а.
   * - `requested == null` → включённые по умолчанию (и не disabled);
   * - иначе → явно запрошенные, но только зарегистрированные и не disabled
   *   (отсутствующий id молча пропускается — run уйдёт в partial/fail сам).
   */
  select(
    requested: readonly string[] | null | undefined,
    intents?: readonly DiscoveryIntent[],
  ): OsintProvider[] {
    const all = this.list();
    const usable = all.filter(
      (provider) => provider.descriptor.policy !== "disabled",
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
}

export function createRegistry(
  providers: readonly OsintProvider[] = [],
): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}
