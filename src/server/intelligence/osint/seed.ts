import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import { normalizeUrl } from "./url.ts";
import type { DiscoveryProfile } from "./profile.ts";

/**
 * Seed-URL для crawl-фазы (§25): откуда стартует обход одного run'а.
 *
 * Приоритеты — детерминированы: явные URL оператора выше профиля, профиль
 * выше прежних источников/кандидатов. Никакой сети здесь нет — это только
 * нормализация и чтение уже накопленных строк тенанта.
 */

export type SeedReason =
  | "explicit"
  | "profile_website"
  | "profile_social"
  | "profile_domain"
  | "run_candidate"
  | "prior_source"
  | "prior_candidate";

export type SeedUrl = {
  url: string;
  reason: SeedReason;
  priority: number;
};

export const SEED_PRIORITY: Record<SeedReason, number> = {
  explicit: 110,
  profile_website: 100,
  profile_social: 95,
  profile_domain: 90,
  run_candidate: 85,
  prior_source: 80,
  prior_candidate: 70,
};

/** Сколько seed'ов в одном run'е (очередь всё равно ограничена бюджетом). */
export const MAX_SEEDS = 40;
export const MAX_EXPLICIT_SEEDS = 20;

/** Нормализует один seed; невалидный/длинный → null (причина у вызывающего). */
export function normalizeSeed(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const normalized = normalizeUrl(raw);
  if (!normalized.ok) return null;
  if (normalized.url.length > 2048) return null;
  return normalized.url;
}

export type ExplicitSeeds = {
  seeds: SeedUrl[];
  /** Отклонённые значения — для 422 с перечнем ошибок. */
  invalid: string[];
};

/** Валидирует явные seed'ы оператора (только http/https, ≤20 штук). */
export function normalizeExplicitSeeds(raw: unknown): ExplicitSeeds {
  const list = Array.isArray(raw) ? raw : [];
  const seeds: SeedUrl[] = [];
  const invalid: string[] = [];
  for (const item of list.slice(0, MAX_EXPLICIT_SEEDS)) {
    const url = normalizeSeed(item);
    if (!url) {
      invalid.push(String(item ?? "").slice(0, 300));
      continue;
    }
    if (seeds.some((seed) => seed.url === url)) continue;
    seeds.push({ url, reason: "explicit", priority: SEED_PRIORITY.explicit });
  }
  return { seeds, invalid };
}

/** Seed'ы из поискового профиля: сайт, соцсети, известные домены. */
export function seedsFromProfile(profile: DiscoveryProfile): SeedUrl[] {
  const seeds: SeedUrl[] = [];
  const push = (raw: string | null | undefined, reason: SeedReason) => {
    if (!raw) return;
    const url = normalizeSeed(raw);
    if (!url) return;
    if (seeds.some((seed) => seed.url === url)) return;
    seeds.push({ url, reason, priority: SEED_PRIORITY[reason] });
  };

  push(profile.website, "profile_website");
  for (const link of profile.knownSocialLinks) push(link, "profile_social");
  for (const domain of profile.knownDomains) push(`https://${domain}/`, "profile_domain");
  return seeds;
}

export type CollectSeedInput = {
  businessId: string;
  profile: DiscoveryProfile;
  explicit?: readonly SeedUrl[];
  /** Читать ли прежние источники/кандидаты тенанта (для новых run'ов). */
  includePrior?: boolean;
  maxSeeds?: number;
};

/**
 * Собирает полный набор seed'ов: явные → профиль → прежние источники и
 * принятые кандидаты тенанта. Дедуп по нормализованному URL, порядок по
 * приоритету.
 */
export async function collectSeedUrls(
  db: Kysely<Database>,
  input: CollectSeedInput,
): Promise<SeedUrl[]> {
  const maxSeeds = input.maxSeeds ?? MAX_SEEDS;
  const merged: SeedUrl[] = [];
  const push = (seed: SeedUrl | undefined) => {
    if (!seed || merged.some((item) => item.url === seed.url)) return;
    if (merged.length < maxSeeds) merged.push(seed);
  };

  for (const seed of input.explicit ?? []) push(seed);
  for (const seed of seedsFromProfile(input.profile)) push(seed);

  if (input.includePrior !== false) {
    const prior = await collectPriorSeeds(db, input.businessId, maxSeeds);
    for (const seed of prior) push(seed);
  }

  return merged.sort((a, b) => b.priority - a.priority);
}

/** Прежние источники (через мост тенанта) и непринятые-к-отказу кандидаты. */
export async function collectPriorSeeds(
  db: Kysely<Database>,
  businessId: string,
  limit: number,
): Promise<SeedUrl[]> {
  const sources = await db
    .selectFrom("osint_sources as s")
    .innerJoin("osint_entity_sources as es", "es.source_id", "s.id")
    .innerJoin("osint_business_entities as be", "be.entity_id", "es.entity_id")
    .select("s.normalized_url")
    .where("be.business_id", "=", businessId)
    .where("be.status", "!=", "rejected")
    .limit(limit)
    .execute();

  const candidates = await db
    .selectFrom("osint_source_candidates")
    .select("normalized_url")
    .where("business_id", "=", businessId)
    .where("status", "!=", "rejected")
    .orderBy("discovered_at", "desc")
    .limit(limit)
    .execute();

  const seeds: SeedUrl[] = [];
  const push = (raw: string, reason: SeedReason) => {
    const url = normalizeSeed(raw);
    if (!url) return;
    if (seeds.some((seed) => seed.url === url)) return;
    if (seeds.length >= limit) return;
    seeds.push({ url, reason, priority: SEED_PRIORITY[reason] });
  };

  for (const row of sources) push(row.normalized_url, "prior_source");
  for (const row of candidates) push(row.normalized_url, "prior_candidate");
  return seeds;
}
