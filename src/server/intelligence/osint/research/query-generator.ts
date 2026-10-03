/**
 * Генератор поисковых запросов (§8).
 *
 * Запрос — это НЕ строка, а обоснованное решение: зачем мы ищем, с какой
 * целью, из чего выведено. Это позволяет (а) не повторяться, (б) объяснить
 * пользователю, почему система ищет именно это, (в) отказаться от целой ветки,
 * если поставщик поиска недоступен, не потеряв остальные ветки.
 *
 * Набор НЕ финален: гипотеза рождает запросы, находка порождает новую
 * гипотезу, та — новые запросы. Это и есть исследовательский цикл.
 */

import type { OsintResearchPurpose } from "../schema.ts";
import { identitiesOfKind, type BusinessIdentity } from "./identity.ts";
import type { Hypothesis } from "./hypothesis.ts";

export type SearchQuery = {
  query: string;
  /** Зачем этот запрос. Внутреннее рассуждение, не пользовательский выбор. */
  purpose: OsintResearchPurpose;
  priority: number;
  /** Из чего выведен запрос: гипотеза или найденная идентичность. */
  derivedFrom: string;
  /** Ключ дедупликации — дважды такой запрос не пойдёт. */
  dedupeKey: string;
  /** id гипотезы-основания, для трассировки audit-цепочки. */
  hypothesisKey?: string;
};

/**
 * Шаблоны запросов по назначению. Список НЕ выводится из ручного набора
 * пользователем — это внутренняя карта поискового пространства.
 */
const PURPOSE_TERMS: Record<OsintResearchPurpose, string[]> = {
  identity: [],
  contact: ["телефон", "контакты", "адрес"],
  website: ["официальный сайт", "сайт"],
  social: ["ВКонтакте", "Telegram", "Instagram"],
  reviews: ["отзывы", "оценки"],
  maps: ["2ГИС", "Яндекс Карты"],
  legal: ["ИП", "ООО", "реквизиты"],
  news: ["новости", "статья"],
  products: ["меню", "каталог", "цены", "ассортимент"],
  services: ["услуги", "прайс"],
  prices: ["цены", "стоимость"],
  vacancies: ["вакансии", "работа"],
  locations: ["филиалы", "адреса"],
  competitors: ["аналоги", "конкуренты"],
  mentions: ["справочник", "каталог организаций"],
  reputation: ["отзывы", "жалобы"],
  changes: ["переехал", "закрылся", "новый адрес"],
  verification: [],
};

const MAX_TERMS_PER_PURPOSE = 3;

/**
 * Собирает запросы для одной гипотезы.
 *
 * Возвращает 0..N запросов. Ноль — нормальный результат: значит, для этой
 * гипотезы искать нечем (например, нечего подтверждать), и агент пойдёт дальше.
 */
export function queriesForHypothesis(
  identity: BusinessIdentity,
  hypothesis: Hypothesis,
): SearchQuery[] {
  const out: SearchQuery[] = [];
  const name = identity.name.trim();
  const city = identitiesOfKind(identity, "city")[0]?.display ?? "";
  const region = identitiesOfKind(identity, "region")[0]?.display ?? "";
  const category = identitiesOfKind(identity, "category")[0]?.display ?? "";
  const base = [name, city].filter(Boolean).join(" ");

  const push = (query: string, term: string) => {
    const text = query.replace(/\s+/g, " ").trim();
    if (!text) return;
    const dedupeKey = `${hypothesis.dedupeKey}:${term || "base"}`;
    if (out.some((entry) => entry.dedupeKey === dedupeKey)) return;
    out.push({
      query: text,
      purpose: hypothesis.purpose,
      priority: hypothesis.priority,
      derivedFrom: hypothesis.statement,
      dedupeKey,
      hypothesisKey: hypothesis.dedupeKey,
    });
  };

  // Запрос по найденному объекту проверки: если проверяем домен — ищем внутри
  // него, это самый дешёвый и точный источник.
  if (hypothesis.subjectKey === "domain" && hypothesis.subjectValue) {
    const domain = hypothesis.subjectValue;
    for (const term of PURPOSE_TERMS[hypothesis.purpose].slice(
      0,
      MAX_TERMS_PER_PURPOSE,
    )) {
      push(`site:${domain} ${term}`, term);
    }
    push(`site:${domain}`, "");
    return out;
  }

  if (!name) return out;

  // Базовый запрос: имя + город. Самая широкая разведка.
  push(base, "");

  for (const term of PURPOSE_TERMS[hypothesis.purpose].slice(
    0,
    MAX_TERMS_PER_PURPOSE,
  )) {
    push(`${base} ${term}`, term);
  }

  // Уточнение по найденному телефону: он опознаёт бизнес точнее имени.
  if (hypothesis.purpose === "identity") {
    for (const phone of identitiesOfKind(identity, "phone")) {
      push(phone.display ?? phone.value, `phone:${phone.value}`);
    }
  }

  // Категория и регион дают разные срезы, когда имя коллизионно.
  if (category && hypothesis.purpose !== "identity") {
    push([name, category, city].filter(Boolean).join(" "), "category");
  }
  if (region && hypothesis.purpose === "location" as OsintResearchPurpose) {
    push([name, city, region].filter(Boolean).join(" "), "region");
  }

  return out;
}

/**
 * Запросы для набора гипотез. Порядок — по убыванию приоритета, с общим
 * бюджетом: это и есть «мы потратим запросы на самое важное».
 */
export function planQueries(
  identity: BusinessIdentity,
  hypotheses: Hypothesis[],
  maxQueries: number,
  exhaustedQueries?: ReadonlySet<string>,
): SearchQuery[] {
  const seen = new Set<string>(exhaustedQueries ?? []);
  const out: SearchQuery[] = [];
  for (const hypothesis of hypotheses) {
    if (out.length >= maxQueries) break;
    for (const query of queriesForHypothesis(identity, hypothesis)) {
      if (out.length >= maxQueries) break;
      if (seen.has(query.dedupeKey)) continue;
      seen.add(query.dedupeKey);
      out.push(query);
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}
