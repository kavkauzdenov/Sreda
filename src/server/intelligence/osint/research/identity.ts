/**
 * Идентичность бизнеса для автономного исследования (§6).
 *
 * Ключевая идея: идентичности НЕ равнозначны. Телефон и домен — сильные
 * идентификаторы, название — слабое (оно коллизионно: «Ромашка» в Барнауле
 * и «Ромашка» в Томске). Каждая идентичность несёт вес, и именно вес решает,
 * во что агенту верить сильнее.
 *
 * Модуль чистый: ни БД, ни сети. Всё детерминировано, поэтому и приоритеты
 * гипотез, и пороги разрешения воспроизводимы и тестируемы.
 */

export type IdentityKind =
  | "name"
  | "legal_name"
  | "domain"
  | "phone"
  | "email"
  | "address"
  | "city"
  | "region"
  | "country"
  | "social"
  | "category";

/**
 * Надёжность идентичности. Не «уверенность в конкретном факте», а сила
 * идентификатора как такового: по телефону можно опознать бизнес, по названию
 * — почти нет.
 */
export type IdentityStrength = "strong" | "medium" | "weak";

export type StrengthWeight = {
  strong: number;
  medium: number;
  weak: number;
};

/** Базовый вес типа идентичности. Сумма нормализуется при подсчёте score. */
export const IDENTITY_WEIGHTS: Record<IdentityKind, StrengthWeight> = {
  // Сильные: уникально опознают бизнес.
  phone: { strong: 1, medium: 1, weak: 1 },
  domain: { strong: 1, medium: 1, weak: 1 },
  email: { strong: 1, medium: 0.6, weak: 0.25 },
  address: { strong: 1, medium: 0.6, weak: 0.25 },
  // Средние: сужают круг, но не опознают.
  legal_name: { strong: 0.6, medium: 0.6, weak: 0.25 },
  social: { strong: 1, medium: 0.6, weak: 0.25 },
  city: { strong: 0.6, medium: 0.6, weak: 0.25 },
  region: { strong: 0.25, medium: 0.25, weak: 0.25 },
  country: { strong: 0.25, medium: 0.25, weak: 0.25 },
  category: { strong: 0.25, medium: 0.25, weak: 0.25 },
  // Слабые: коллизионны по построению, никогда не опознают бизнес сами.
  name: { strong: 0.25, medium: 0.25, weak: 0.25 },
};

export type IdentityValue = {
  kind: IdentityKind;
  /** Нормализованное значение для сравнения (домен без схемы, телефон по E164-ish). */
  value: string;
  /** Человекочитаемое значение для показа. */
  display?: string;
  strength: IdentityStrength;
  /** Откуда мы это знаем: карточка бизнеса, найденный источник, гипотеза. */
  origin: "profile" | "source" | "derived" | "user";
  /** Идентификатор источника, если значение пришло из источника. */
  sourceId?: string | null;
};

export type BusinessIdentity = {
  /** Каноническое имя для показа. */
  name: string;
  /** Нормализованное имя — ключ для fuzzy-сравнения. */
  normalizedName: string;
  kind: "business" | "organization";
  values: IdentityValue[];
};

/**
 * Суммарный вес, при котором идентичность считается полностью опознанной.
 *
 * Калибровка: name+city ≈ 0.39, +телефон ≈ 0.84, +домен → 1.0. Одно название
 * без контакта принципиально не может дать «уверенное» опознание.
 */
export const IDENTITY_TARGET_TOTAL = 2.2;

/**
 * Насколько опознана идентичность, 0..1.
 *
 * Считается как нормированная сумма весов найденных идентичностей, но с
 * насыщением: третий телефон того же бизнеса уже не добавляет уверенности.
 * Это отличает «много контактов» от «одного точного идентификатора».
 */
export function identityConfidence(identity: BusinessIdentity): number {
  const raw = identityWeightTotal(identity);
  return Math.min(1, Math.round((raw / IDENTITY_TARGET_TOTAL) * 1000) / 1000);
}

/** Ненормализованная сумма весов — нужна для сравнения и калибровки тестов. */
export function identityWeightTotal(identity: BusinessIdentity): number {
  const byKind = new Map<IdentityKind, number>();
  for (const value of identity.values) {
    const weight = IDENTITY_WEIGHTS[value.kind]?.[value.strength] ?? 0.25;
    const current = byKind.get(value.kind) ?? 0;
    // Насыщение по повторным значениям одного типа: 1-я даёт полный вес,
    // каждая следующая — половину от предыдущей.
    const contribution = current === 0 ? weight : weight * Math.pow(0.5, current);
    byKind.set(value.kind, current + contribution);
  }
  return [...byKind.values()].reduce((sum, weight) => sum + weight, 0);
}

/** Идентичности, достаточные чтобы опознать бизнес (не только предположить). */
export function hasStrongIdentity(identity: BusinessIdentity): boolean {
  return identity.values.some(
    (value) =>
      IDENTITY_WEIGHTS[value.kind]?.[value.strength] === 1 &&
      (value.kind === "phone" ||
        value.kind === "domain" ||
        value.kind === "address"),
  );
}

/** Идентичности конкретного типа — удобный доступ для генератора гипотез. */
export function identitiesOfKind(
  identity: BusinessIdentity,
  kind: IdentityKind,
): IdentityValue[] {
  return identity.values.filter((value) => value.kind === kind);
}

export function hasIdentityOfKind(
  identity: BusinessIdentity,
  kind: IdentityKind,
): boolean {
  return identitiesOfKind(identity, kind).length > 0;
}

/** Человекочитаемое имя для показа в логе/UI. */
export function identityDisplay(value: IdentityValue): string {
  return value.display?.trim() || value.value;
}

/**
 * Детерминированный dedupe для набора идентичностей. Ключ — тип+нормализованное
 * значение, поэтому повторный прогон агента не размножает записи.
 */
export function dedupeIdentities(values: IdentityValue[]): IdentityValue[] {
  const seen = new Map<string, IdentityValue>();
  for (const value of values) {
    const key = `${value.kind}:${value.value}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, value);
      continue;
    }
    // При повторе оставляем более сильный вариант. Из двух равных
    // предпочитаем тот, у которого есть источник: он даёт провенанс, а
    // безымянное значение из карточки — нет.
    const currentWeight = IDENTITY_WEIGHTS[value.kind]?.[value.strength] ?? 0.25;
    const existingWeight =
      IDENTITY_WEIGHTS[existing.kind]?.[existing.strength] ?? 0.25;
    if (currentWeight > existingWeight) {
      seen.set(key, { ...value, sourceId: value.sourceId ?? existing.sourceId });
    } else if (!existing.sourceId && value.sourceId) {
      seen.set(key, { ...existing, sourceId: value.sourceId });
    }
  }
  return [...seen.values()];
}
