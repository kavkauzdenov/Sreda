import {
  AUTO_ACCEPT_RULES,
  DEFAULT_MATCH_THRESHOLDS,
  DEFAULT_MATCH_WEIGHTS,
  type AutoAcceptRuleId,
  type MatchThresholds,
  type MatchWeights,
} from "./config.ts";
import {
  extractPhoneRuns,
  hasCategory,
  hasPhrase,
  hasWord,
  nameSimilarity,
  normalizeText,
} from "./text.ts";
import { hostMatches } from "./url.ts";
import type { DiscoveryProfile } from "./profile.ts";

/**
 * Entity resolution (§12): score = matchedWeight / applicableWeight.
 * Каждый признак либо применим (профиль содержит значение + у candidate есть
 * текст/URL для проверки), либо исключён из знаменателя — score объясним 0..1.
 */

export type MatchFeature = keyof MatchWeights;

export type MatchSignal = {
  feature: MatchFeature;
  applicable: boolean;
  matched: boolean;
  weight: number;
  contribution: number;
  detail: string;
};

export type CandidateEvidence = {
  url: string;
  title?: string | null;
  snippet?: string | null;
  /** Полный текст страницы — заполняется на этапах сбора, не при discovery. */
  text?: string | null;
};

export type ScoreResult = {
  score: number;
  applicableWeight: number;
  matchedWeight: number;
  signals: MatchSignal[];
  reasons: string[];
  nameRatio: number;
  phoneMatched: boolean;
  domainMatched: boolean;
};

export type CandidateDecision = "accepted" | "candidate" | "rejected";

export type DecisionResult = {
  status: CandidateDecision;
  rule: AutoAcceptRuleId | null;
  score: number;
  reasons: string[];
};

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

export function scoreCandidate(
  evidence: CandidateEvidence,
  profile: DiscoveryProfile,
  weights: MatchWeights = DEFAULT_MATCH_WEIGHTS,
  thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): ScoreResult {
  const rawText = [evidence.title, evidence.snippet, evidence.text, evidence.url]
    .filter((value): value is string => Boolean(value && String(value).trim()))
    .join("\n")
    .slice(0, thresholds.maxCompareTextLength);
  const hasContent = rawText.trim().length > 0;
  const signals: MatchSignal[] = [];

  const push = (
    feature: MatchFeature,
    applicable: boolean,
    matched: boolean,
    contribution: number,
    detail: string,
  ) => {
    signals.push({
      feature,
      applicable,
      matched,
      weight: weights[feature],
      contribution: applicable ? contribution : 0,
      detail,
    });
  };

  // phone — нормализованные «телефонные» последовательности текста.
  const phoneApplicable = profile.phones.length > 0 && hasContent;
  const candidatePhones = hasContent ? extractPhoneRuns(rawText) : [];
  const phoneMatched =
    phoneApplicable &&
    profile.phones.some((phone) => Boolean(phone) && candidatePhones.includes(phone));
  push(
    "phone",
    phoneApplicable,
    phoneMatched,
    phoneMatched ? weights.phone : 0,
    phoneMatched ? "phone_exact" : "phone_absent",
  );

  // domain — registrable-домен найден в URL candidate.
  const domainApplicable = profile.knownDomains.length > 0 && Boolean(evidence.url);
  const domainMatched =
    domainApplicable &&
    profile.knownDomains.some((domain) => {
      try {
        return hostMatches(new URL(evidence.url).hostname, domain);
      } catch {
        return false;
      }
    });
  push(
    "domain",
    domainApplicable,
    domainMatched,
    domainMatched ? weights.domain : 0,
    domainMatched ? "domain_exact" : "domain_absent",
  );

  // address — фраза адреса (с домом или без него) в тексте.
  const addressApplicable = Boolean(profile.address) && hasContent;
  let addressMatched = false;
  if (addressApplicable && profile.address) {
    const address = profile.address;
    const withoutHouse = address.replace(/\d+\S*$/, "").trim();
    addressMatched =
      hasPhrase(rawText, address) ||
      (withoutHouse.length >= 6 && hasPhrase(rawText, withoutHouse));
  }
  push(
    "address",
    addressApplicable,
    addressMatched,
    addressMatched ? weights.address : 0,
    addressMatched ? "address_found" : "address_absent",
  );

  // city — целое слово в тексте.
  const cityApplicable = Boolean(profile.city) && hasContent;
  const cityMatched = cityApplicable && profile.city !== null && profile.city !== "" && hasWord(rawText, profile.city);
  push(
    "city",
    cityApplicable,
    cityMatched,
    cityMatched ? weights.city : 0,
    cityMatched ? "city_found" : "city_absent",
  );

  // name — максимум по алиасам против title/snippet; вклад weight * ratio.
  const nameApplicable = profile.aliases.length > 0 && hasContent;
  let nameRatio = 0;
  let bestAlias = "";
  if (nameApplicable) {
    const compareTexts = [evidence.title, evidence.snippet, evidence.text].filter(
      (value): value is string => Boolean(value && String(value).trim()),
    );
    for (const alias of profile.aliases) {
      for (const compare of compareTexts) {
        const ratio = nameSimilarity(alias, compare);
        if (ratio > nameRatio) {
          nameRatio = ratio;
          bestAlias = alias;
        }
      }
    }
    nameRatio = round3(nameRatio);
  }
  const nameContribution = nameApplicable ? weights.name * nameRatio : 0;
  push(
    "name",
    nameApplicable,
    nameApplicable && nameRatio >= thresholds.nameMatchMinRatio,
    nameContribution,
    nameApplicable && nameRatio >= thresholds.nameMatchMinRatio
      ? `name_ratio_${nameRatio}`
      : "name_weak",
  );

  // category — стем-совпадение отрасли.
  const categoryApplicable = Boolean(profile.category) && hasContent;
  const categoryMatched =
    categoryApplicable &&
    profile.category !== null &&
    profile.category !== "" &&
    hasCategory(rawText, profile.category);
  push(
    "category",
    categoryApplicable,
    categoryMatched,
    categoryMatched ? weights.category : 0,
    categoryMatched ? "category_found" : "category_absent",
  );

  // social — известный профиль бизнеса найден в URL candidate.
  const socialApplicable = profile.knownSocialLinks.length > 0 && Boolean(evidence.url);
  const socialMatched =
    socialApplicable &&
    profile.knownSocialLinks.some((link) => {
      try {
        const linkHost = new URL(link).hostname;
        const urlHost = new URL(evidence.url).hostname;
        return hostMatches(urlHost, linkHost);
      } catch {
        return false;
      }
    });
  push(
    "social",
    socialApplicable,
    socialMatched,
    socialMatched ? weights.social : 0,
    socialMatched ? "social_found" : "social_absent",
  );

  const applicable = signals.filter((signal) => signal.applicable);
  const applicableWeight = round3(
    applicable.reduce((sum, signal) => sum + signal.weight, 0),
  );
  const matchedWeight = round3(
    applicable.reduce((sum, signal) => sum + signal.contribution, 0),
  );
  const score = applicableWeight > 0 ? round3(matchedWeight / applicableWeight) : 0;

  const reasons = signals
    .filter((signal) => signal.applicable && signal.matched)
    .map((signal) => signal.detail);
  if (bestAlias && nameRatio >= thresholds.nameMatchMinRatio)
    reasons.push(`alias:${bestAlias}`);

  return {
    score,
    applicableWeight,
    matchedWeight,
    signals,
    reasons: [...new Set(reasons)],
    nameRatio,
    phoneMatched,
    domainMatched,
  };
}

/**
 * Порядок правил auto-accept — приоритет (§14). Слабые совпадения никогда
 * не принимаются автоматически: уходят в ручную очередь `candidate`.
 */
export function decideCandidate(
  result: ScoreResult,
  profile: DiscoveryProfile,
  thresholds: MatchThresholds = DEFAULT_MATCH_THRESHOLDS,
): DecisionResult {
  const base = { score: result.score, reasons: result.reasons };

  if (result.score < thresholds.candidateMinScore)
    return { ...base, status: "rejected", rule: null };

  for (const rule of AUTO_ACCEPT_RULES) {
    if (rule === "domain_exact" && result.domainMatched && result.score >= 0.4)
      return { ...base, status: "accepted", rule };
    if (
      rule === "phone_plus_identity" &&
      result.phoneMatched &&
      (result.nameRatio >= thresholds.phoneAutoAcceptMinNameRatio ||
        result.signals.some((signal) => signal.feature === "city" && signal.matched))
    )
      return { ...base, status: "accepted", rule };
  }

  return { ...base, status: "candidate", rule: null };
}

/** Первичный identity-ключ сущности для дедупликации в `osint_entities`. */
export function buildIdentityKey(profile: DiscoveryProfile): string | null {
  if (profile.knownDomains.length) return `domain:${profile.knownDomains[0]}`;
  if (profile.phone) return `phone:${profile.phone}`;
  return null;
}

/** Стабильный fingerprint сущности — для последующих merge (Этап 4+). */
export function buildEntityFingerprint(profile: DiscoveryProfile): Record<string, unknown> {
  return {
    name: normalizeText(profile.businessName || profile.aliases[0] || ""),
    city: normalizeText(profile.city ?? ""),
    phone: profile.phone ?? "",
    domains: profile.knownDomains,
  };
}
