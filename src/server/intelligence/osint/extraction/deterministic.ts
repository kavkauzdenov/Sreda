import { extractPhoneRuns, hasWord, normalizePhone } from "../text.ts";
import { registrableDomain } from "../url.ts";
import type { DiscoveryProfile } from "../profile.ts";
import {
  emptyExtraction,
  type ExtractedAttribute,
  type ExtractedEntity,
  type ExtractionResult,
} from "./contract.ts";

/**
 * Deterministic extraction (§11) — работает всегда, без сети и без AI.
 *
 * Что извлекаем структурно: телефоны, email, URL/домены, города из текста
 * наблюдения + подстановка значений профиля. Результат уже структурирован,
 * поэтому идёт напрямую в атрибуты/упоминания без парсинга модели.
 */

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const URL_RE = /\bhttps?:\/\/[^\s,;)"'<>]+/g;

const MAX_EVIDENCE = 500;

function snippetAround(text: string, needle: string): string {
  const index = text.toLowerCase().indexOf(needle.toLowerCase());
  if (index < 0) return text.slice(0, MAX_EVIDENCE);
  const start = Math.max(0, index - 120);
  return text.slice(start, start + MAX_EVIDENCE);
}

export type DeterministicExtractionInput = {
  text: string;
  /** Известный профиль — значения подставляются с evidence из текста. */
  profile?: DiscoveryProfile;
  /** Название уже известной сущности, к которой относится наблюдение. */
  knownEntityName?: string;
};

export function extractDeterministic(
  input: DeterministicExtractionInput,
): ExtractionResult {
  const text = input.text ?? "";
  if (!text.trim()) return emptyExtraction();

  const entities: ExtractedEntity[] = [];
  const attributes: ExtractedAttribute[] = [];

  if (input.knownEntityName && input.knownEntityName.trim()) {
    const evidence = snippetAround(text, input.knownEntityName);
    if (evidence) {
      entities.push({
        name: input.knownEntityName.slice(0, 300),
        kind: "business",
        mentionType: "ABOUT",
        evidenceKind: "text_span",
        evidenceText: evidence,
        confidence: 0.9,
      });
    }
  }

  for (const phone of extractPhoneRuns(text)) {
    const normalized = normalizePhone(phone);
    if (!normalized) continue;
    attributes.push({
      attribute: "phone",
      value: normalized,
      evidenceText: snippetAround(text, phone),
      confidence: 0.95,
    });
  }

  for (const email of new Set(text.match(EMAIL_RE) ?? [])) {
    attributes.push({
      attribute: "email",
      value: email.toLowerCase(),
      evidenceText: snippetAround(text, email),
      confidence: 0.95,
    });
  }

  for (const url of new Set(text.match(URL_RE) ?? [])) {
    let host: string | null = null;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    const domain = registrableDomain(host);
    if (!domain) continue;
    attributes.push({
      attribute: "website",
      value: domain,
      evidenceText: snippetAround(text, url),
      confidence: 0.9,
    });
  }

  const profile = input.profile;
  if (profile) {
    const cityCandidate = profile.city;
    if (cityCandidate && hasWord(text, cityCandidate)) {
      attributes.push({
        attribute: "city",
        value: cityCandidate,
        evidenceText: snippetAround(text, cityCandidate),
        confidence: 0.85,
      });
    }
    if (profile.address && text.toLowerCase().includes(profile.address.toLowerCase())) {
      attributes.push({
        attribute: "address",
        value: profile.address,
        evidenceText: snippetAround(text, profile.address),
        confidence: 0.85,
      });
    }
    if (profile.phone) {
      attributes.push({
        attribute: "phone",
        value: profile.phone,
        evidenceText: snippetAround(text, profile.phone),
        confidence: 0.8,
      });
    }
    if (profile.website) {
      try {
        const domain = registrableDomain(new URL(profile.website).hostname);
        if (domain) {
          attributes.push({
            attribute: "website",
            value: domain,
            evidenceText: snippetAround(text, profile.website),
            confidence: 0.8,
          });
        }
      } catch {
        // невалидный URL профиля — пропускаем, не роняем extraction
      }
    }
    if (profile.category) {
      attributes.push({
        attribute: "category",
        value: profile.category,
        evidenceText: snippetAround(text, profile.category),
        confidence: 0.7,
      });
    }
  }

  return { entities: dedupeEntities(entities), attributes: dedupeAttributes(attributes) };
}

function dedupeEntities(entities: ExtractedEntity[]): ExtractedEntity[] {
  const seen = new Map<string, ExtractedEntity>();
  for (const entity of entities) {
    const key = `${entity.name}|${entity.mentionType}`;
    const current = seen.get(key);
    if (!current || entity.confidence > current.confidence) seen.set(key, entity);
  }
  return [...seen.values()];
}

function dedupeAttributes(attributes: ExtractedAttribute[]): ExtractedAttribute[] {
  const seen = new Map<string, ExtractedAttribute>();
  for (const attribute of attributes) {
    const key = `${attribute.attribute}|${JSON.stringify(attribute.value)}`;
    const current = seen.get(key);
    if (!current || attribute.confidence > current.confidence)
      seen.set(key, attribute);
  }
  return [...seen.values()];
}
