import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import {
  buildEntityFingerprint,
  buildIdentityKey,
} from "./entity-resolution.ts";
import { normalizeText, tokenize } from "./text.ts";
import type { DiscoveryProfile } from "./profile.ts";
import type {
  OsintBusinessEntityStatus,
  OsintRelationType,
} from "./schema.ts";

/**
 * Глобальная модель сущности (§3, §12).
 *
 * Инварианты:
 *   1. osint_entities не содержит business_id — сущность принадлежит всем.
 *   2. Дедупликация глобально — ТОЛЬКО по identity_key (domain:/phone:).
 *      Сопоставление по одному имени запрещено (§12): имя коллизионно.
 *   3. Принадлежность конкретному бизнесу — только через
 *      osint_business_entities (§4).
 */

export type EnsureGlobalEntityInput = {
  identityKey: string | null;
  kind?: "business" | "location" | "organization";
  displayName: string;
  normalizedName: string;
  aliases?: string[];
  category?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  socialLinks?: Record<string, unknown>;
  fingerprint?: Record<string, unknown>;
  sourceKind?: "discovery" | "manual";
};

/** Находит глобальную сущность строго по identity_key. */
export async function findGlobalEntity(
  db: Kysely<Database>,
  identityKey: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("osint_entities")
    .select("id")
    .where("identity_key", "=", identityKey)
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Создаёт или возвращает глобальную сущность. Дедуп — только identity_key. */
export async function ensureGlobalEntity(
  db: Kysely<Database>,
  input: EnsureGlobalEntityInput,
): Promise<string> {
  if (input.identityKey) {
    const existing = await findGlobalEntity(db, input.identityKey);
    if (existing) {
      await db
        .updateTable("osint_entities")
        .set({ last_seen_at: new Date(), updated_at: new Date() })
        .where("id", "=", existing)
        .execute();
      return existing;
    }
  }

  const id = randomUUID();
  await db
    .insertInto("osint_entities")
    .values({
      id,
      kind: input.kind ?? "business",
      display_name: input.displayName.slice(0, 300),
      normalized_name: input.normalizedName,
      identity_key: input.identityKey,
      aliases: input.aliases ?? [],
      category: input.category ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      country: input.country ?? null,
      address: input.address ?? null,
      phone: input.phone ?? null,
      email: input.email ?? null,
      website: input.website ?? null,
      social_links: input.socialLinks ?? {},
      fingerprint: input.fingerprint ?? {},
      latitude: null,
      longitude: null,
      source_kind: input.sourceKind ?? "discovery",
      merged_into_id: null,
      first_seen_at: new Date(),
      last_seen_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return id;
}

export type LinkBusinessEntityInput = {
  businessId: string;
  entityId: string;
  relationship?: OsintRelationType;
  confidence?: number;
  status?: OsintBusinessEntityStatus;
  evidence?: unknown[];
  decidedByUserId?: string | null;
};

/**
 * Мост тенант → глобальная сущность (§4). Существующая связь никогда не
 * деградирует: confidence берётся максимумом, status обновляется только
 * вперёд по важности.
 */
export async function linkBusinessEntity(
  db: Kysely<Database>,
  input: LinkBusinessEntityInput,
): Promise<void> {
  const relationship = input.relationship ?? "ABOUT";
  const confidence = String(input.confidence ?? 1);

  const existing = await db
    .selectFrom("osint_business_entities")
    .select(["confidence", "status"])
    .where("business_id", "=", input.businessId)
    .where("entity_id", "=", input.entityId)
    .where("relationship", "=", relationship)
    .executeTakeFirst();

  if (existing) {
    const next = Number(input.confidence ?? 1);
    if (next > Number(existing.confidence)) {
      await db
        .updateTable("osint_business_entities")
        .set({
          confidence,
          ...(input.status ? { status: input.status } : {}),
          updated_at: new Date(),
        })
        .where("business_id", "=", input.businessId)
        .where("entity_id", "=", input.entityId)
        .where("relationship", "=", relationship)
        .execute();
    }
    return;
  }

  await db
    .insertInto("osint_business_entities")
    .values({
      business_id: input.businessId,
      entity_id: input.entityId,
      relationship,
      confidence,
      status: input.status ?? "linked",
      evidence: input.evidence ?? [],
      decided_by_user_id: input.decidedByUserId ?? null,
      decided_at: input.decidedByUserId ? new Date() : null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .onConflict((oc) =>
      oc.columns(["business_id", "entity_id", "relationship"]).doNothing(),
    )
    .execute();
}

/**
 * Тенант-скоуп-поиск «своей» сущности по имени. Допустим: речь о бизнесе
 * самого тенанта, а не о мерже двух внешних компаний (§12 запрещает
 * мерж внешних по одному имени).
 */
export async function findOwnBusinessEntity(
  db: Kysely<Database>,
  input: { businessId: string; normalizedName: string },
): Promise<string | null> {
  const row = await db
    .selectFrom("osint_business_entities")
    .innerJoin("osint_entities", "osint_entities.id", "osint_business_entities.entity_id")
    .select("osint_entities.id")
    .where("osint_business_entities.business_id", "=", input.businessId)
    .where("osint_entities.kind", "=", "business")
    .where("osint_entities.normalized_name", "=", input.normalizedName)
    .where("osint_business_entities.status", "!=", "rejected")
    .executeTakeFirst();
  return row?.id ?? null;
}

/**
 * Разрешает сущность для тенанта: глобальный identity_key → тенант-скоупное
 * имя → создание новой. Каждый результат закрепляется мостом (§4).
 */
export async function ensureBusinessEntity(
  db: Kysely<Database>,
  input: {
    businessId: string;
    profile: DiscoveryProfile;
    relationship?: OsintRelationType;
    confidence?: number;
    sourceKind?: "discovery" | "manual";
  },
): Promise<string> {
  const { profile } = input;
  const identityKey = buildIdentityKey(profile);
  const displayName = (
    profile.businessName ||
    profile.aliases[0] ||
    "Без названия"
  ).slice(0, 300);
  const normalizedName =
    normalizeText(displayName) || tokenize(displayName).join(" ") || "unnamed";

  let entityId: string;

  if (identityKey) {
    const global = await findGlobalEntity(db, identityKey);
    entityId =
      global ??
      (await ensureGlobalEntity(db, {
        identityKey,
        kind: "business",
        displayName,
        normalizedName,
        aliases: profile.aliases,
        category: profile.category,
        city: profile.city,
        region: profile.region,
        country: profile.country,
        address: profile.address,
        phone: profile.phone,
        email: profile.email,
        website: profile.website,
        socialLinks: { links: profile.knownSocialLinks },
        fingerprint: buildEntityFingerprint(profile),
        sourceKind: input.sourceKind,
      }));
  } else {
    const owned = await findOwnBusinessEntity(db, {
      businessId: input.businessId,
      normalizedName,
    });
    entityId =
      owned ??
      (await ensureGlobalEntity(db, {
        identityKey: null,
        kind: "business",
        displayName,
        normalizedName,
        aliases: profile.aliases,
        category: profile.category,
        city: profile.city,
        region: profile.region,
        country: profile.country,
        address: profile.address,
        phone: profile.phone,
        email: profile.email,
        website: profile.website,
        socialLinks: { links: profile.knownSocialLinks },
        fingerprint: buildEntityFingerprint(profile),
        sourceKind: input.sourceKind,
      }));
  }

  await linkBusinessEntity(db, {
    businessId: input.businessId,
    entityId,
    relationship: input.relationship ?? "OWNER",
    confidence: input.confidence ?? 1,
    status: "linked",
    evidence: [{ kind: "discovery_profile", name: displayName }],
  });

  return entityId;
}

/**
 * Cross-source linking (§20): если новое наблюдение даёт сильный сигнал
 * (phone/domain/address/coordinates) уже известной сущности, связываем
 * источник с ней, а не создаём дубликат.
 */
export type StrongSignal = {
  phone?: string | null;
  domain?: string | null;
  address?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

const round5 = (value: number): number => Math.round(value * 100000) / 100000;

export function strongSignalsMatch(a: StrongSignal, b: StrongSignal): {
  matched: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (a.phone && b.phone && a.phone === b.phone) reasons.push("phone_exact");
  if (a.domain && b.domain && a.domain === b.domain) reasons.push("domain_exact");
  if (a.address && b.address && normalizeText(a.address) === normalizeText(b.address))
    reasons.push("address_exact");
  if (
    a.latitude != null &&
    b.latitude != null &&
    a.longitude != null &&
    b.longitude != null &&
    round5(a.latitude) === round5(b.latitude) &&
    round5(a.longitude) === round5(b.longitude)
  )
    reasons.push("coordinates_exact");
  return { matched: reasons.length > 0, reasons };
}
