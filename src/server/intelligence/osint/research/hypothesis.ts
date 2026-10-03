/**
 * Генератор исследовательских гипотез и поисковых запросов (§7, §8).
 *
 * Ключевое отличие от старого подхода: запросы НЕ являются конечным набором.
 * Гипотезы порождаются из того, что мы уже знаем, поэтому находка порождает
 * новые гипотезы. Пример: нашли домен romashka.ru → появились гипотезы
 * «у сайта есть контакты», «у сайта есть меню», «у сайта есть вакансии».
 *
 * Приоритет гипотезы падает, если мы её уже проверяли и не нашли ничего —
 * это и есть торможение насыщения на уровне плана (§70).
 */

import type {
  OsintHypothesisType,
  OsintResearchPurpose,
} from "../schema.ts";
import {
  identityConfidence,
  identitiesOfKind,
  type BusinessIdentity,
  type IdentityKind,
} from "./identity.ts";

export type HypothesisInput = {
  identity: BusinessIdentity;
  /** Что мы уже проверили и с каким исходом — чтобы не предлагать одно и то же. */
  exhausted?: ReadonlySet<string>;
  /** Найденные в ходе исследования идентичности (домен, телефон из источника). */
  discovered?: {
    kind: IdentityKind;
    value: string;
    display?: string;
  }[];
};

export type Hypothesis = {
  type: OsintHypothesisType;
  /** Человекочитаемое утверждение: «У бизнеса есть официальный сайт». */
  statement: string;
  /** Почему мы это проверяем — обязательно, гипотеза должна объяснять себя. */
  reason: string;
  purpose: OsintResearchPurpose;
  priority: number;
  confidence: number;
  /** Что именно проверяем: домен, телефон, адрес — объект гипотезы. */
  subjectKey: string;
  subjectValue: string;
  /** Детерминированный ключ: повторный запуск не создаёт дубликат. */
  dedupeKey: string;
};

/**
 * Базовые гипотезы «первого эшелона» — то, без чего нельзя опознать бизнес.
 * Порядок отражает приоритет: сначала опознание, потом расширение картины.
 */
const BASE_HYPOTHESES: {
  type: OsintHypothesisType;
  purpose: OsintResearchPurpose;
  statement: string;
  reason: string;
  requires: IdentityKind | "name";
  priority: number;
}[] = [
  {
    type: "website",
    purpose: "website",
    statement: "У бизнеса есть собственный сайт",
    reason: "без сайта нельзя подтвердить ни контакты, ни услуги",
    requires: "name",
    priority: 95,
  },
  {
    type: "identity",
    purpose: "identity",
    statement: "Найдены независимые упоминания бизнеса",
    reason: "независимые упоминания подтверждают, что бизнес существует публично",
    requires: "name",
    priority: 90,
  },
  {
    type: "maps",
    purpose: "maps",
    statement: "У бизнеса есть карточка в картах или каталоге",
    reason: "карточки содержат адрес, телефон и часы работы",
    requires: "name",
    priority: 80,
  },
  {
    type: "social",
    purpose: "social",
    statement: "У бизнеса есть публичные профили в соцсетях",
    reason: "профиль — сильный идентификатор и источник активности",
    requires: "name",
    priority: 75,
  },
  {
    type: "reviews",
    purpose: "reviews",
    statement: "У бизнеса есть отзывы и оценки",
    reason: "отзывы дают репутацию и часто содержат контакты",
    requires: "name",
    priority: 65,
  },
  {
    type: "legal",
    purpose: "legal",
    statement: "За бизнесом стоит юридическое лицо",
    reason: "юрлицо связывает бизнес с реестром и уточняет адрес",
    requires: "name",
    priority: 60,
  },
  {
    type: "news",
    purpose: "news",
    statement: "Бизнес упоминался в публикациях",
    reason: "публикации дают независимый источник и историю изменений",
    requires: "name",
    priority: 50,
  },
  {
    type: "vacancies",
    purpose: "vacancies",
    statement: "У бизнеса есть открытые вакансии",
    reason: "вакансии показывают масштаб, филиалы и контакты",
    requires: "name",
    priority: 45,
  },
  {
    type: "locations",
    purpose: "locations",
    statement: "У бизнеса есть филиалы или другие адреса",
    reason: "несколько адресов меняют картину присутствия",
    requires: "name",
    priority: 55,
  },
  {
    type: "mentions",
    purpose: "mentions",
    statement: "Бизнес упоминается в справочниках и агрегаторах",
    reason: "агрегаторы дают независимое подтверждение адреса и телефона",
    requires: "name",
    priority: 55,
  },
];

/** Гипотезы, порождаемые найденным доменом — второй эшелон. */
const DOMAIN_HYPOTHESES: {
  type: OsintHypothesisType;
  purpose: OsintResearchPurpose;
  statement: (domain: string) => string;
  reason: (domain: string) => string;
  suffix: string;
  priority: number;
}[] = [
  {
    type: "contact",
    purpose: "contact",
    statement: (d) => `На сайте ${d} есть контакты`,
    reason: (d) => `домен ${d} найден — ищем контакты внутри него`,
    suffix: "контакты",
    priority: 70,
  },
  {
    type: "services",
    purpose: "services",
    statement: (d) => `На сайте ${d} перечислены услуги или товары`,
    reason: (d) => `сайт ${d} — источник про продукт без сторонних площадок`,
    suffix: "услуги",
    priority: 55,
  },
  {
    type: "locations",
    purpose: "locations",
    statement: (d) => `На сайте ${d} указан адрес`,
    reason: (d) => `адрес с сайта ${d} сильнее адреса из каталога`,
    suffix: "адрес",
    priority: 65,
  },
  {
    type: "vacancies",
    purpose: "vacancies",
    statement: (d) => `На сайте ${d} есть раздел вакансий`,
    reason: (d) => `вакансии на сайте ${d} — прямой признак роста`,
    suffix: "вакансии",
    priority: 40,
  },
];

function dedupeKeyFor(type: string, subjectKey: string, subjectValue: string): string {
  return `${type}:${subjectKey}:${subjectValue}`;
}

/**
 * Строит начальный набор гипотез из идентичности бизнеса.
 *
 * Если бизнес уже опознан (есть телефон или домен), часть гипотез уже
 * подтверждена заранее — их приоритет падает, а не исчезает: мы всё равно
 * ищем подтверждение, но позже.
 */
export function buildInitialHypotheses(input: HypothesisInput): Hypothesis[] {
  const { identity } = input;
  const exhausted = input.exhausted ?? new Set<string>();
  const confidence = identityConfidence(identity);
  const hasPhone = identitiesOfKind(identity, "phone").length > 0;
  const hasDomain = identitiesOfKind(identity, "domain").length > 0;

  const out: Hypothesis[] = [];

  for (const rule of BASE_HYPOTHESES) {
    const hasRequirement =
      rule.requires === "name"
        ? identitiesOfKind(identity, "name").length > 0
        : identitiesOfKind(identity, rule.requires).length > 0;
    if (!hasRequirement) continue;

    // Уже опознанная идентичность делает «поиск подтверждения» вторичным.
    const alreadyKnown =
      (rule.type === "identity" && (hasPhone || hasDomain)) ||
      (rule.type === "website" && hasDomain);
    const priority = alreadyKnown
      ? Math.round(rule.priority * 0.45)
      : rule.priority;

    const dedupeKey = dedupeKeyFor(rule.type, "business", identity.normalizedName);
    if (exhausted.has(dedupeKey)) continue;

    out.push({
      type: rule.type,
      statement: rule.statement,
      reason: rule.reason,
      purpose: rule.purpose,
      priority,
      confidence,
      subjectKey: "business",
      subjectValue: identity.normalizedName,
      dedupeKey,
    });
  }

  for (const value of input.discovered ?? []) {
    if (value.kind !== "domain" || !value.value) continue;
    const domain = value.value;
    for (const rule of DOMAIN_HYPOTHESES) {
      const dedupeKey = dedupeKeyFor(rule.type, "domain", domain);
      if (exhausted.has(dedupeKey)) continue;
      out.push({
        type: rule.type,
        statement: rule.statement(domain),
        reason: rule.reason(domain),
        purpose: rule.purpose,
        priority: rule.priority,
        confidence,
        subjectKey: "domain",
        subjectValue: domain,
        dedupeKey,
      });
    }
  }

  return out.sort((a, b) => b.priority - a.priority);
}

/**
 * Пересчитывает приоритет после того, как гипотеза дала пустой результат.
 *
 * Не удаляем гипотезу, а демонстрируем: она проверена и ничего не дала. Падение
 * приоритета — то, что заставляет агента свернуть ветку вместо бесконечного
 * ползания по одному и тому же классу запросов.
 */
export function decayPriority(priority: number, attempts: number): number {
  if (attempts <= 0) return priority;
  return Math.round(priority / (1 + attempts * 0.8));
}
