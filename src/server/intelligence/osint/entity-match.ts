import { nameSimilarity, normalizePhone, normalizeText } from "./text.ts";
import { normalizeDomain } from "./normalize.ts";
import { registrableDomain } from "./url.ts";

/**
 * Entity resolution Stage 4 (§26.6): детерминированное сопоставление
 * извлечённого профиля с уже известными сущностями бизнеса.
 *
 * Это КЛАССИФИКАЦИЯ ПРОЦЕССА сопоставления, а не оценка качества бизнеса:
 * EXACT/STRONG/CANDIDATE/AMBIGUOUS/NO_MATCH описывают, насколько
 * объяснимо решение, и никогда — «насколько хорош» бизнес.
 *
 * Запрет слабого auto-merge (§26.6): функция НИЧЕГО не пишет в мосты
 * `osint_business_entities`. Слабое совпадение даёт AMBIGUOUS/CANDIDATE с
 * объяснением, а не слияние. Мерж сущностей — отдельное решение, не Stage 4.
 */

export type EntityMatchClass =
  | "EXACT"
  | "STRONG"
  | "CANDIDATE"
  | "AMBIGUOUS"
  | "NO_MATCH";

const CLASS_RANK: Record<EntityMatchClass, number> = {
  EXACT: 4,
  STRONG: 3,
  CANDIDATE: 2,
  AMBIGUOUS: 1,
  NO_MATCH: 0,
};

export type EntityMatchSignalId =
  | "domain_exact"
  | "phone_exact"
  | "name_exact"
  | "city_match"
  | "name_similar";

export type EntityMatchSignal = {
  signal: EntityMatchSignalId;
  matched: boolean;
  /** Человекочитаемое объяснение именно ЭТОГО сигнала. */
  detail: string;
};

export type MatchableEntity = {
  id: string;
  displayName: string;
  phone: string | null;
  website: string | null;
  city: string | null;
  /** osint_entities.identity_key — "domain:…" либо "phone:…". */
  identityKey: string | null;
};

/** Сводка извлечённых фактов — вход сопоставления. */
export type ExtractedIdentity = {
  names: string[];
  phones: string[];
  domains: string[];
  cities: string[];
};

export type EntityMatchResult = {
  status: EntityMatchClass;
  entityId: string | null;
  entityName: string | null;
  signals: EntityMatchSignal[];
  explanation: string;
};

/** Порог нечёткого совпадения имени (§26.6): ниже — не считаем даже кандидатом. */
export const NAME_SIMILARITY_THRESHOLD = 0.85;

function identityDomain(identityKey: string | null): string | null {
  if (!identityKey?.startsWith("domain:")) return null;
  const normalized = normalizeDomain(identityKey.slice("domain:".length));
  return normalized?.key ?? null;
}

function websiteDomain(website: string | null): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.startsWith("//") ? `https:${website}` : website).hostname;
    const normalized = normalizeDomain(registrableDomain(host) ?? host);
    return normalized?.key ?? null;
  } catch {
    const normalized = normalizeDomain(website);
    return normalized?.key ?? null;
  }
}

function bestNameSimilarity(displayName: string, names: string[]): number {
  let best = 0;
  for (const name of names) {
    const ratio = nameSimilarity(displayName, name);
    if (ratio > best) best = ratio;
  }
  return best;
}

/**
 * Оценка одной сущности: набор сигналов + класс. Классы (§26.6):
 *  - EXACT     — домен точен И (имя точно либо телефон точен);
 *  - STRONG    — ровно один сильный сигнал (domain_exact или phone_exact);
 *  - CANDIDATE — точное имя + совпадение города;
 *  - AMBIGUOUS — похожее имя (≥ порога) без точного;
 *  - NO_MATCH  — ни один сигнал не сработал.
 */
export function matchEntity(
  entity: MatchableEntity,
  extracted: ExtractedIdentity,
): { status: EntityMatchClass; signals: EntityMatchSignal[] } {
  const entityDomain =
    identityDomain(entity.identityKey) ?? websiteDomain(entity.website);
  const entityPhone = entity.phone ? normalizePhone(entity.phone) : null;
  const entityNameKey = normalizeText(entity.displayName);

  const domainExact = Boolean(
    entityDomain && extracted.domains.includes(entityDomain),
  );
  const phoneExact = Boolean(
    entityPhone && extracted.phones.includes(entityPhone),
  );
  const nameExact = Boolean(
    entityNameKey &&
      extracted.names.some((name) => normalizeText(name) === entityNameKey),
  );
  const cityMatch = Boolean(
    entity.city &&
      extracted.cities.some(
        (city) => city.trim().toLowerCase() === entity.city?.trim().toLowerCase(),
      ),
  );
  const similar = bestNameSimilarity(entity.displayName, extracted.names);
  const nameSimilar = similar >= NAME_SIMILARITY_THRESHOLD;

  const signals: EntityMatchSignal[] = [
    {
      signal: "domain_exact",
      matched: domainExact,
      detail: domainExact
        ? `домен ${entityDomain} совпал с извлечённым доменом`
        : `домен сущности ${entityDomain ?? "не задан"} не найден среди извлечённых`,
    },
    {
      signal: "phone_exact",
      matched: phoneExact,
      detail: phoneExact
        ? `телефон ${entityPhone} совпал канонически`
        : `телефон сущности ${entityPhone ?? "не задан"} не найден среди извлечённых`,
    },
    {
      signal: "name_exact",
      matched: nameExact,
      detail: nameExact
        ? `название «${entity.displayName}» совпало после нормализации`
        : `название «${entity.displayName}» не совпало точно`,
    },
    {
      signal: "city_match",
      matched: cityMatch,
      detail: cityMatch
        ? `город ${entity.city} совпал`
        : `город сущности ${entity.city ?? "не задан"} не найден среди извлечённых`,
    },
    {
      signal: "name_similar",
      matched: nameSimilar,
      detail: `сходство названия ${similar.toFixed(2)} (порог ${NAME_SIMILARITY_THRESHOLD})`,
    },
  ];

  let status: EntityMatchClass = "NO_MATCH";
  if (domainExact && (nameExact || phoneExact)) status = "EXACT";
  else if (domainExact || phoneExact) status = "STRONG";
  else if (nameExact && cityMatch) status = "CANDIDATE";
  else if (nameSimilar) status = "AMBIGUOUS";

  return { status, signals };
}

/**
 * Сопоставление для бизнеса: лучшая сущность среди моста
 * `osint_business_entities` (status <> 'rejected'). При равенстве классов
 * между несколькими сущностями результат принижается до AMBIGUOUS с
 * перечислением кандидатов — равные претенденты не сливаются (§26.6).
 */
export function resolveEntityMatch(
  entities: readonly MatchableEntity[],
  extracted: ExtractedIdentity,
): EntityMatchResult {
  if (entities.length === 0) {
    return {
      status: "NO_MATCH",
      entityId: null,
      entityName: null,
      signals: [],
      explanation:
        "У бизнеса нет связанных сущностей — сопоставлять не с чем (NO_MATCH).",
    };
  }

  const scored = entities.map((entity) => ({
    entity,
    ...matchEntity(entity, extracted),
  }));

  const bestRank = Math.max(
    ...scored.map((entry) => CLASS_RANK[entry.status]),
    0,
  );
  const top = scored.filter((entry) => CLASS_RANK[entry.status] === bestRank);
  const winner = top[0];

  if (!winner || winner.status === "NO_MATCH") {
    const tried = scored
      .map((entry) => `${entry.entity.displayName}: ${entry.status}`)
      .join(", ");
    return {
      status: "NO_MATCH",
      entityId: null,
      entityName: null,
      signals: winner?.signals ?? [],
      explanation: `Совпадений не найдено. Проверено: ${tried}.`,
    };
  }

  if (top.length > 1) {
    const names = top.map((entry) => entry.entity.displayName).join(", ");
    return {
      status: "AMBIGUOUS",
      entityId: null,
      entityName: null,
      signals: winner.signals,
      explanation: `${top.length} сущности совпали классом ${winner.status} одинаково (${names}) — без явного решения не выбираем (AMBIGUOUS).`,
    };
  }

  const matched = winner.signals
    .filter((signal) => signal.matched)
    .map((signal) => signal.signal);
  return {
    status: winner.status,
    entityId: winner.entity.id,
    entityName: winner.entity.displayName,
    signals: winner.signals,
    explanation: `Класс ${winner.status}: совпали сигналы ${matched.join(", ") || "—"} для «${winner.entity.displayName}».`,
  };
}
