import {
  DEFAULT_QUERY_TEMPLATES,
  type DiscoveryBudget,
  type DiscoveryIntent,
  type QueryTemplate,
} from "./config.ts";
import { queryPlaceholders, type DiscoveryProfile } from "./profile.ts";

export type GeneratedQuery = {
  templateId: string;
  intent: DiscoveryIntent;
  text: string;
};

/**
 * Генерация поисковых запросов из профиля (§7). Детерминирована:
 * порядок — порядок шаблонов, лишние плейсхолдеры → шаблон пропускается.
 * Запросы с пустым текстом не создаются; лимит берётся из бюджета.
 */
export function buildDiscoveryQueries(
  profile: DiscoveryProfile,
  budget: Pick<DiscoveryBudget, "maxQueries">,
  templates: readonly QueryTemplate[] = DEFAULT_QUERY_TEMPLATES,
): GeneratedQuery[] {
  const placeholders = queryPlaceholders(profile);
  const out: GeneratedQuery[] = [];
  const seen = new Set<string>();

  for (const template of templates) {
    if (out.length >= budget.maxQueries) break;

    // Шаблон с {name} без имени бессмыслен.
    if (/\{name\}/.test(template.template) && !placeholders.name) continue;

    let text = template.template;
    let missing = false;
    text = text.replace(/\{(\w+)\}/g, (_match, key: string) => {
      const value = placeholders[key];
      if (value === undefined) {
        // Отсутствующий необязательный плейсхолдер → шаблон неприменим.
        missing = true;
        return "";
      }
      return value;
    });
    if (missing) continue;

    text = text.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push({ templateId: template.id, intent: template.intents[0] ?? "any", text });
  }

  return out;
}

/** Интенты, поддерживаемые провайдером, отфильтрованные по запросам. */
export function filterQueriesByIntent<T extends GeneratedQuery>(
  queries: readonly T[],
  intents: readonly DiscoveryIntent[],
): T[] {
  if (intents.includes("any")) return [...queries];
  return queries.filter((query) => intents.includes(query.intent));
}
