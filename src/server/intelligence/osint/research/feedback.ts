/**
 * Обратная связь: найденный факт → следующая гипотеза (§7).
 *
 * Это то, что превращает набор интеграций в исследовательского агента.
 * Без этого шага цикл обрывается: агент выдаёт первую волну запросов,
 * получает результат и останавливается, так и не задав вопрос «а что ещё
 * следует из того, что мы нашли».
 *
 * Правила, которые здесь соблюдаются:
 *   - факт ДОЛЖЕН существовать в БД до того, как станет основанием;
 *   - каждая гипотеза несёт reason (что мы уже знаем) и ссылку на факт;
 *   - dedupe-ключ стабилен, поэтому повторная обработка того же факта не
 *     порождает новую волну;
 *   - совпадение телефона НЕ считается доказательством принадлежности:
 *     номер может быть общим, устаревшим или принадлежать агрегатору.
 */

import type { Hypothesis } from "./hypothesis.ts";

/** Факт, который уже сохранён и потому может быть основанием. */
export type ObservedFact = {
  id: string;
  factType: string;
  factKey: string;
  value: string;
  sourceId: string | null;
  observationId: string | null;
  /** Насколько источник авторитетен — влияет на силу основания. */
  sourceTrust?: string | null;
  observedAt?: string | null;
};

/**
 * Насколько основание надёжно. Общий телефон в каталоге — слабое
 * основание; телефон с официального сайта — сильное. Гипотеза, порождённая
 * слабым основанием, получает меньший приоритет, но не отбрасывается:
 * проверить всё равно нужно.
 */
export function evidenceStrength(fact: ObservedFact): number {
  const trust = (fact.sourceTrust ?? "").toLowerCase();
  if (trust === "official") return 1;
  if (trust === "public_directory" || trust === "review_platform") return 0.6;
  if (trust === "search_result") return 0.4;
  // Источник неизвестен — не выдумываем силу, берём осторожную.
  return 0.4;
}

/** Идентификатор основания для dedupe-ключа. */
function basisKey(fact: ObservedFact): string {
  return `${fact.factType}:${fact.factKey}:${fact.value}`;
}

/** Черновик гипотезы до применения силы основания. */
type HypothesisDraft = {
  type: Hypothesis["type"];
  statement: string;
  reason: string;
  purpose: Hypothesis["purpose"];
  priority: number;
  subjectKey: string;
  subjectValue: string;
  fact: ObservedFact;
};

/**
 * Правила «факт → гипотезы».
 *
 * Каждое правило отвечает на один тип находки. Ничего не выдумывается:
 * если факта нет, соответствующей гипотезы не будет.
 */
type Rule = {
  /** Типы фактов, на которые правило реагирует. */
  matches: (factType: string) => boolean;
  /** Строит гипотезы из факта. Пустой массив — правило не применилось. */
  build: (fact: ObservedFact, strength: number) => Hypothesis[];
};

function hypothesis(input: {
  type: Hypothesis["type"];
  statement: string;
  reason: string;
  purpose: Hypothesis["purpose"];
  priority: number;
  confidence: number;
  subjectKey: string;
  subjectValue: string;
  fact: ObservedFact;
}): Hypothesis {
  // dedupe-ключ включает факт и цель: тот же факт, поставленный с той же
  // целью, повторно не ставится. Разные цели по одному факту — разные
  // гипотезы, и это правильно: телефон стоит и проверить, и перепроверить.
  return {
    type: input.type,
    statement: input.statement,
    reason: input.reason,
    purpose: input.purpose,
    priority: input.priority,
    confidence: input.confidence,
    subjectKey: input.subjectKey,
    subjectValue: input.subjectValue,
    dedupeKey: `${input.type}:${input.subjectKey}:${input.subjectValue}:${basisKey(input.fact)}`,
  };
}

/**
 * Применяет силу основания и превращает черновики в готовые гипотезы.
 *
 * Слабое основание снижает приоритет, но не отменяет проверку: неуверенность
 * лечится свидетельствами, а не игнорированием находки.
 */
function finalize(drafts: HypothesisDraft[], strength: number): Hypothesis[] {
  return drafts
    .map((draft) => ({
      ...draft,
      type: draft.type,
      purpose: draft.purpose,
      priority: Math.round(draft.priority * (0.55 + strength * 0.45)),
      confidence: Math.round(strength * 100) / 100,
      dedupeKey: `${draft.type}:${draft.subjectKey}:${draft.subjectValue}:${basisKey(draft.fact)}`,
    }))
    .map((draft) => hypothesis(draft));
}

const RULES: Rule[] = [
  // ── Телефон ───────────────────────────────────────────────────────────
  {
    matches: (type) => type === "phone",
    build: (fact, strength) => {
      const value = fact.value;
      return finalize([
        {
          type: "corroboration",
          statement: `Номер ${value} подтверждается независимыми источниками`,
          reason:
            "Номер найден в публичном источнике. Совпадение само по себе не " +
            "доказывает принадлежность: номер бывает общим или устаревшим.",
          purpose: "identity",
          priority: 70,
          subjectKey: "phone",
          subjectValue: value,
          fact,
        },
        {
          type: "mentions",
          statement: `Ищем другие публичные упоминания номера ${value}`,
          reason: `Номер ${value} найден — ищем, где он публикуется ещё`,
          purpose: "mentions",
          priority: 55,
          subjectKey: "phone",
          subjectValue: value,
          fact,
        },
      ], strength);
    },
  },

  // ── Домен / сайт ──────────────────────────────────────────────────────
  {
    matches: (type) => type === "domain" || type === "website",
    build: (fact, strength) => {
      const domain = fact.value;
      return finalize([
        {
          type: "contact",
          statement: `На домене ${domain} есть публичные контакты`,
          reason: `Домен ${domain} найден — ищем контакты внутри него`,
          purpose: "contact",
          priority: 75,
          subjectKey: "domain",
          subjectValue: domain,
          fact,
        },
        {
          type: "services",
          statement: `На домене ${domain} перечислены услуги или товары`,
          reason: `Сайт ${domain} — источник о предложении без сторонних площадок`,
          purpose: "services",
          priority: 50,
          subjectKey: "domain",
          subjectValue: domain,
          fact,
        },
        {
          type: "social",
          statement: `Домен ${domain} связан с публичными профилями`,
          reason: `Ссылки на соцсети часто стоят на сайте ${domain}`,
          purpose: "social",
          priority: 45,
          subjectKey: "domain",
          subjectValue: domain,
          fact,
        },
        {
          type: "mentions",
          statement: `Ищем публичные упоминания домена ${domain}`,
          reason: `Домен ${domain} найден — ищем, где о нём пишут`,
          purpose: "mentions",
          priority: 50,
          subjectKey: "domain",
          subjectValue: domain,
          fact,
        },
      ], strength);
    },
  },

  // ── Адрес ─────────────────────────────────────────────────────────────
  {
    matches: (type) => type === "address",
    build: (fact, strength) => {
      const address = fact.value;
      return finalize([
        {
          type: "corroboration",
          statement: `Адрес «${address}» подтверждается независимыми источниками`,
          reason:
            `Адрес найден в публичном источнике. Один адрес не доказывает, ` +
            `что он актуален: возможна историческая смена.`,
          purpose: "identity",
          priority: 68,
          subjectKey: "address",
          subjectValue: address,
          fact,
        },
        {
          type: "locations",
          statement: `Ищем другие публично упоминаемые адреса рядом с «${address}»`,
          reason: `Адрес «${address}» найден — проверяем, есть ли другие точки`,
          purpose: "locations",
          priority: 58,
          subjectKey: "address",
          subjectValue: address,
          fact,
        },
      ], strength);
    },
  },

  // ── Юридическое лицо и идентификаторы ──────────────────────────────────
  {
    matches: (type) =>
      type === "legal_name" ||
      type === "registration_identifier" ||
      type === "tax_identifier" ||
      type === "license_identifier",
    build: (fact, strength) => {
      const value = fact.value;
      return finalize([
        {
          type: "corroboration",
          statement: `Юридическое лицо «${value}» связано с этим бизнесом`,
          reason:
            `Найдено юридическое наименование или идентификатор. Организация ` +
            `и коммерческая точка — не одно и то же, связь нужно подтвердить.`,
          purpose: "legal",
          priority: 72,
          subjectKey: "legal",
          subjectValue: value,
          fact,
        },
        {
          type: "locations",
          statement: `Ищем адреса, заявленные за «${value}»`,
          reason: `Юридическое лицо «${value}» может указывать на другие адреса`,
          purpose: "locations",
          priority: 52,
          subjectKey: "legal",
          subjectValue: value,
          fact,
        },
      ], strength);
    },
  },

  // ── Социальные профили ────────────────────────────────────────────────
  {
    matches: (type) =>
      ["telegram", "vk", "instagram", "facebook", "youtube", "tiktok", "other_social"].includes(
        type,
      ),
    build: (fact, strength) => {
      const handle = fact.value;
      return finalize([
        {
          type: "corroboration",
          statement: `Профиль «${handle}» принадлежит этому бизнесу`,
          reason:
            `Профиль найден по косвенному признаку. Одноимённые профили ` +
            `бывают у разных компаний — нужна независимая проверка.`,
          purpose: "identity",
          priority: 66,
          subjectKey: "social",
          subjectValue: handle,
          fact,
        },
        {
          type: "contact",
          statement: `В профиле «${handle}» есть публичные контакты`,
          reason: `Профиль ${handle} может содержать дополнительные контакты`,
          purpose: "contact",
          priority: 48,
          subjectKey: "social",
          subjectValue: handle,
          fact,
        },
      ], strength);
    },
  },

  // ── Отзывы и цены ─────────────────────────────────────────────────────
  {
    matches: (type) => type === "opening_hours",
    build: (fact, strength) =>
      finalize(
        [
          {
            type: "corroboration",
            statement: `Часы работы подтверждаются независимыми источниками`,
            reason: `Часы работы найдены — сверяем с другими публикациями`,
            purpose: "verification",
            priority: 45,
            subjectKey: "hours",
            subjectValue: fact.value,
            fact,
          },
        ],
        strength,
      ),
  },
];

/**
 * Строит гипотезы, порождённые фактом.
 *
 * Фактов без основания быть не должно: функция принимает только уже
 * сохранённые факты из `osint_intelligence_facts`.
 */
export function hypothesesFromFact(fact: ObservedFact): Hypothesis[] {
  if (!fact.id || !fact.value) return [];
  const strength = evidenceStrength(fact);
  const out: Hypothesis[] = [];
  const seen = new Set<string>();
  for (const rule of RULES) {
    if (!rule.matches(fact.factType)) continue;
    for (const built of rule.build(fact, strength)) {
      if (seen.has(built.dedupeKey)) continue;
      seen.add(built.dedupeKey);
      out.push(built);
    }
  }
  return out.sort((a, b) => b.priority - a.priority);
}

/**
 * Гипотезы, порождённые найденной сущностью (§7 «найдена новая сущность»).
 *
 * Сущность сама по себе не доказывает связь с бизнесом. Поэтому первое
 * действие — проверка принадлежности, и только потом исследование её
 * содержимого.
 */
export function hypothesesFromEntity(entity: {
  id: string;
  normalizedName: string;
  kind: string;
  phone: string | null;
  website: string | null;
  address: string | null;
}): Hypothesis[] {
  const out: Hypothesis[] = [];
  const push = (input: Omit<Hypothesis, "dedupeKey" | "confidence"> & { confidence?: number }) => {
    out.push({
      ...input,
      confidence: input.confidence ?? 0.5,
      dedupeKey: `${input.type}:${input.subjectKey}:${input.subjectValue}:entity:${entity.id}`,
    });
  };

  push({
    type: "identity",
    statement: `Сущность «${entity.normalizedName}» связана с исследуемым бизнесом`,
    reason:
      `Найдена новая сущность. Похожее название не доказывает связь — ` +
      `нужны сильные признаки: телефон, домен или адрес.`,
    purpose: "identity",
    priority: 78,
    subjectKey: "entity",
    subjectValue: entity.id,
  });

  if (entity.phone) {
    push({
      type: "corroboration",
      statement: `Телефон сущности «${entity.normalizedName}» подтверждает принадлежность`,
      reason: `У найденной сущности есть телефон ${entity.phone} — сверяем с телефоном бизнеса`,
      purpose: "identity",
      priority: 72,
      subjectKey: "phone",
      subjectValue: entity.phone,
    });
  }
  if (entity.website) {
    push({
      type: "website",
      statement: `Сайт ${entity.website} принадлежит исследуемому бизнесу`,
      reason: `Домен ${entity.website} найден у новой сущности — проверяем принадлежность`,
      purpose: "website",
      priority: 70,
      subjectKey: "domain",
      subjectValue: entity.website,
    });
  }
  if (entity.address) {
    push({
      type: "locations",
      statement: `Адрес «${entity.address}» относится к исследуемому бизнесу`,
      reason: `Адрес найден у новой сущности — проверяем, наш это бизнес`,
      purpose: "locations",
      priority: 62,
      subjectKey: "address",
      subjectValue: entity.address,
    });
  }
  return out.sort((a, b) => b.priority - a.priority);
}
