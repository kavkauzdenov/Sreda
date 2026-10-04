/**
 * Построение идентичности бизнеса из того, что уже есть в системе (§6, §53).
 *
 * Zero-config: пользователь создал бизнес с названием и городом — этого
 * достаточно. Никаких API-ключей, провайдеров и ручных списков источников.
 * Всё остальное агент достраивает сам по ходу исследования.
 */

import type { DiscoveryProfile } from "../profile.ts";
import { normalizeDomain, normalizeFactValue } from "../normalize.ts";
import { normalizeText } from "../text.ts";
import {
  dedupeIdentities,
  type BusinessIdentity,
  type IdentityValue,
} from "./identity.ts";

export type IdentitySeed = {
  name?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
  category?: string | null;
  address?: string | null;
  phone?: string | null;
  phones?: string[];
  email?: string | null;
  website?: string | null;
  knownDomains?: string[];
  knownSocialLinks?: string[];
  legalName?: string | null;
  aliases?: string[];
};

/**
 * Собирает идентичность из карточки бизнеса.
 *
 * Важный момент: `name` сразу помечается как слабая идентичность. Это не
 * пессимизм — это защита от главной ошибки OSINT: объединения двух разных
 * «Ромашек» по совпадению названия (§17).
 */
export function buildIdentityFromSeed(seed: IdentitySeed): BusinessIdentity {
  const values: IdentityValue[] = [];
  const add = (value: IdentityValue) => {
    if (!value.value) return;
    values.push(value);
  };

  const name = (seed.name ?? "").trim();
  const normalizedName = normalizeText(name);

  if (name) {
    add({
      kind: "name",
      value: normalizedName,
      display: name,
      strength: "weak",
      origin: "profile",
    });
  }

  // Юрлицо сильнее названия: «ООО Ромашка» в реестре — конкретная компания.
  const legalName = (seed.legalName ?? "").trim();
  if (legalName) {
    add({
      kind: "legal_name",
      value: normalizeText(legalName),
      display: legalName,
      strength: "medium",
      origin: "profile",
    });
  }

  for (const alias of seed.aliases ?? []) {
    const trimmed = alias.trim();
    if (!trimmed) continue;
    add({
      kind: "name",
      value: normalizeText(trimmed),
      display: trimmed,
      strength: "weak",
      origin: "profile",
    });
  }

  const phones = [...(seed.phones ?? []), ...(seed.phone ? [seed.phone] : [])];
  for (const raw of phones) {
    const phone = normalizeFactValue("phone", raw);
    if (!phone) continue;
    add({
      kind: "phone",
      value: phone.key,
      display: raw.trim(),
      strength: "strong",
      origin: "profile",
    });
  }

  const email = (seed.email ?? "").trim();
  if (email) {
    add({
      kind: "email",
      value: email.toLowerCase(),
      display: email,
      strength: "medium",
      origin: "profile",
    });
  }

  const domains = new Set<string>();
  if (seed.website) {
    const domain = normalizeDomain(seed.website);
    if (domain) domains.add(domain.key);
  }
  for (const raw of seed.knownDomains ?? []) {
    const domain = normalizeDomain(raw);
    if (domain) domains.add(domain.key);
  }
  for (const domain of domains) {
    add({
      kind: "domain",
      value: domain,
      display: domain,
      strength: "strong",
      origin: "profile",
    });
  }

  const address = (seed.address ?? "").trim();
  if (address) {
    add({
      kind: "address",
      value: normalizeText(address),
      display: address,
      strength: "strong",
      origin: "profile",
    });
  }

  for (const [field, kind] of [
    ["city", "city"],
    ["region", "region"],
    ["country", "country"],
    ["category", "category"],
  ] as const) {
    const value = (seed[field] ?? "").trim();
    if (!value) continue;
    add({
      kind,
      value: normalizeText(value),
      display: value,
      strength: kind === "city" ? "medium" : "weak",
      origin: "profile",
    });
  }

  for (const link of seed.knownSocialLinks ?? []) {
    const trimmed = link.trim();
    if (!trimmed) continue;
    add({
      kind: "social",
      value: trimmed.toLowerCase(),
      display: trimmed,
      strength: "strong",
      origin: "profile",
    });
  }

  return {
    name: name || normalizedName,
    normalizedName,
    kind: legalName ? "organization" : "business",
    values: dedupeIdentities(values),
  };
}

/** Identity seed из существующего DiscoveryProfile — без дублирования логики. */
export function identitySeedFromProfile(
  profile: DiscoveryProfile,
): IdentitySeed {
  return {
    name: profile.businessName || profile.aliases[0] || "",
    aliases: profile.aliases,
    city: profile.city,
    region: profile.region,
    country: profile.country,
    category: profile.category,
    address: profile.address,
    phone: profile.phone,
    phones: profile.phones,
    email: profile.email,
    website: profile.website,
    knownDomains: profile.knownDomains,
    knownSocialLinks: profile.knownSocialLinks,
  };
}
