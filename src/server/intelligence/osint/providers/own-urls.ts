import type { DiscoveryProfile } from "../profile.ts";
import { normalizeUrl } from "../url.ts";
import type {
  OsintProvider,
  ProviderSearchInput,
  ProviderSearchResult,
} from "./types.ts";

/**
 * Провайдер «объявленные самим бизнесом URL».
 *
 * Это НЕ поиск и НЕ сбор: он возвращает ровно те ссылки, которые бизнес уже
 * сообщил о себе (website, известные домены, соцсети — profile.ts §2).
 * Ни одного сетевого вызова, ни одного запроса к чужим ресурсам
 * (`requiresNetwork: false`, `policy: "structured_data"`).
 *
 * Зачем: регистрация собственного присутствия в knowledge graph — корневая
 * сущность и кандидаты-«свой сайт» появляются и без внешних провайдеров.
 * Дальше их подхватывают traversal/collectors (Этапы 5+).
 *
 * Инстанс создаётся на один discovery run: он отдаёт результаты ровно один
 * раз, чтобы не раздувать `maxSearchResults` дублями в одном run'е.
 */
export const OWN_URLS_PROVIDER_ID = "own_urls";

export function createOwnUrlsProvider(): OsintProvider {
  let emitted = false;

  const collect = (profile: DiscoveryProfile): ProviderSearchResult[] => {
    const urls: ProviderSearchResult[] = [];
    const push = (raw: string) => {
      const normalized = normalizeUrl(raw);
      if (!normalized.ok) return;
      if (urls.some((item) => item.url === normalized.url)) return;
      urls.push({
        url: normalized.url,
        title: profile.businessName || null,
        snippet: null,
        position: urls.length + 1,
        externalId: null,
        publishedAt: null,
      });
    };

    if (profile.website) push(profile.website);
    for (const domain of profile.knownDomains) push(`https://${domain}/`);
    for (const link of profile.knownSocialLinks) push(link);
    return urls;
  };

  return {
    descriptor: {
      id: OWN_URLS_PROVIDER_ID,
      label: "Объявленные URL бизнеса",
      types: ["website", "social_network"],
      intents: ["any"],
      requiresNetwork: false,
      enabledByDefault: true,
      policy: "structured_data",
      rateLimitPerMinute: 60,
    },
    async search(input: ProviderSearchInput) {
      if (emitted) return { results: [] };
      emitted = true;
      const results = collect(input.profile);
      return { results: results.slice(0, Math.max(0, input.limit)) };
    },
  };
}
