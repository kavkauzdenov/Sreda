import { createHash } from "node:crypto";
import type {
  Claim,
  Contradiction,
  Corroboration,
} from "@/lib/intelligence-contracts.ts";
import type {
  Stage3Assessment,
  Stage3AssessmentGap,
  Stage3AssessmentGroup,
  Stage3AssessmentRule,
  Stage3Provenance,
} from "@/lib/intelligence-types.ts";
import { EXTRACTABLE_ATTRIBUTES } from "./extraction/contract.ts";

/**
 * Stage 3 runtime v2 — corroboration / contradiction / claim assessment (§5).
 *
 * Чистая функция над уже построенными `Claim`: ни обращений к сети, ни
 * персистентности, ни LLM, ни прогнозов. На входе — ровно то, что уже
 * извлечено из наблюдений; на выходе — объяснимая оценка с указанием
 * правила, источников и того, чего данных не хватает (§1).
 *
 * Инварианты:
 *  - §5: сравнение идёт только по совместимым `subject` + `predicate`.
 *    Предмет сравнивается ТОЧНО (без нечёткого merge) — «похожая строка»
 *    не является основанием считать два утверждения одним.
 *  - §6: claim без проверяемой цепочки Observation → Source не может ни
 *    подтвердить, ни опровергнуть — он отбрасывается с gap.
 *  - §4: одно наблюдение не подтверждает само себя; повторная проекция не
 *    растит счётчик; один source с несколькими observations ≠ несколько
 *    источников; разные `source_id` дают разнообразие, но не доказанную
 *    независимость — поэтому `independence` всегда `"unknown"`.
 *  - §8: никаких `now()` и случайных id — детерминизм от входных данных.
 */

type Normalizer = (value: string) => string;

const collapseWs = (value: string) => value.replace(/\s+/g, " ").trim();
const casefold = (value: string) => collapseWs(value).toLowerCase();
const digitsOnly = (value: string) => value.replace(/\D/g, "");
const domain = (value: string) =>
  collapseWs(value).toLowerCase().replace(/\.+$/, "");

/**
 * Таблица безопасного сравнения (§5).
 *
 * Реально сравниваемые predicate'ы — это те, что Stage 3 v1 вообще умеет
 * извлекать из текста наблюдения (`phone`, `email`, `website`), плюс
 * текстовые атрибуты того же закрытого словаря, чьё равенство после
 * регистр/пробельной нормализации не искажает смысл (`name`, `city`,
 * `region`, `country`).
 *
 * Сознательно НЕ сравниваются:
 *  - `address`      — форматы не унифицированы («ул. Ленина, 10» vs
 *                     «улица Ленина, 10») и без парсера равенство врёт;
 *  - `category`     — несколько категорий одновременно не противоречат;
 *  - `description`, `working_hours` — свободный текст;
 *  - `social_links`, `coordinates`  — список и числовая точность.
 * Любое значение, не являющееся строкой, тоже несравнимо.
 */
export const CLAIM_COMPARISON_TABLE: Readonly<Partial<Record<string, Normalizer>>> =
  {
    phone: digitsOnly,
    email: casefold,
    website: domain,
    name: casefold,
    city: casefold,
    region: casefold,
    country: casefold,
  };

export type AssessClaimsInput = {
  businessId: string;
  /** Сколько тенантских наблюдений просмотрено (диагностика, не оценка). */
  observationCount: number;
  /** Сколько наблюдений не дало пригодной цепочки (субъект/вид/контент). */
  skippedObservations: number;
  claims: readonly Claim[];
  /**
   * `observationId → sourceId`. Единственное доказательство того, что claim
   * действительно трассируется до источника в ЭТОМ тенанте (§6).
   */
  provenance: ReadonlyMap<string, string>;
};

type SubjectBucket = {
  subject: string;
  predicate: string;
  claims: Claim[];
};

type ValueBucket = {
  normalized: string;
  claims: Claim[];
  observations: string[];
  sources: string[];
};

export function assessClaims(input: AssessClaimsInput): Stage3Assessment {
  const groups = new Map<string, SubjectBucket>();
  const seen = new Set<string>();

  for (const claim of input.claims) {
    // §7: чужой claim не создаёт группу и не участвует в оценке.
    if (claim.businessId !== input.businessId) continue;
    if (seen.has(claim.id)) continue;
    seen.add(claim.id);

    const key = claim.subject + "\u0000" + claim.predicate;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = { subject: claim.subject, predicate: claim.predicate, claims: [] };
      groups.set(key, bucket);
    }
    bucket.claims.push(claim);
  }

  const assessed = [...groups.values()]
    .map((bucket) => assessGroup(input.businessId, bucket, input.provenance))
    .sort(compareGroups);

  return {
    businessId: input.businessId,
    observationCount: input.observationCount,
    skippedObservations: input.skippedObservations,
    claimCount: assessed.reduce((sum, group) => sum + group.claimCount, 0),
    groups: assessed,
    reason: assessed.length === 0 ? "insufficient_evidence" : null,
  };
}

function assessGroup(
  businessId: string,
  bucket: SubjectBucket,
  provenance: ReadonlyMap<string, string>,
): Stage3AssessmentGroup {
  const ordered = [...bucket.claims].sort(compareClaims);

  // §6: claim без цепочки Observation → Source в этом тенанте отбрасывается.
  const claims = ordered.filter((claim) => {
    const observationId = claim.evidence[0]?.observationId;
    return observationId !== undefined && provenance.has(observationId);
  });
  const dropped = ordered.length - claims.length;

  const observations = sortedUnique(
    claims.map((claim) => claim.evidence[0]!.observationId),
  );
  const sources = sortedUnique(
    observations.map((observationId) => provenance.get(observationId)!),
  );

  const gaps = new Set<Stage3AssessmentGap>();
  if (dropped > 0) gaps.add("missing_provenance");

  const base = {
    businessId,
    subject: bucket.subject,
    predicate: bucket.predicate,
    claimCount: claims.length,
    distinctObservationCount: observations.length,
    distinctSourceCount: sources.length,
    observations,
    sources,
    provenance: claims.map((claim) => {
      const evidenceRef = claim.evidence[0]!;
      return {
        claimId: claim.id,
        evidenceRef,
        observationId: evidenceRef.observationId,
        sourceId: provenance.get(evidenceRef.observationId)!,
      };
    }),
    independence: "unknown" as const,
  };

  if (claims.length === 0)
    return finish(base, "missing_provenance", null, [], gaps);

  const normalizer = CLAIM_COMPARISON_TABLE[bucket.predicate];
  if (!normalizer) {
    gaps.add("predicate_not_comparable");
    return finish(base, "not_assessed", null, [], gaps);
  }

  // Смесь сравнимых и несравнимых значений одного predicate — это как раз
  // та неоднозначность, которую §5 запрещает разрешать молча.
  if (
    claims.some(
      (claim) =>
        claim.value === null ||
        claim.valueKind !== "string" ||
        normalizer(claim.value).length === 0,
    )
  ) {
    gaps.add("value_not_comparable");
    return finish(base, "not_assessed", null, [], gaps);
  }

  if (observations.length < 2) {
    gaps.add("insufficient_observations");
    return finish(base, "single_observation", null, [], gaps);
  }

  if (sources.length >= 2) gaps.add("source_independence_unknown");

  const valueBuckets = buildValueBuckets(claims, normalizer, provenance);

  const conflict = hasSourceConflict(valueBuckets);

  const leading = [...valueBuckets.values()].sort(
    (a, b) =>
      b.sources.length - a.sources.length ||
      b.observations.length - a.observations.length ||
      compareText(a.normalized, b.normalized),
  )[0]!;

  const corroboration: Corroboration | null =
    leading.observations.length >= 2 && leading.sources.length >= 2
      ? {
          subject: bucket.subject,
          predicate: bucket.predicate,
          // Оригинальное значение (до нормализации) — провенанс не теряем.
          value: leading.claims[0]!.value,
          claims: leading.claims,
          distinctSourceCount: leading.sources.length,
          status: "corroborated",
          // НЕ вероятность истинности: минимальная уверенность
          // детерминированного извлечения входящих claims (§5).
          confidence: Math.min(...leading.claims.map((claim) => claim.confidence)),
        }
      : null;

  const contradictions: Contradiction[] = conflict
    ? [buildContradiction(businessId, bucket, valueBuckets, claims)]
    : [];

  if (conflict) {
    gaps.add("no_temporal_semantics");
    return finish(base, "value_mismatch", corroboration, contradictions, gaps);
  }

  const rule: Stage3AssessmentRule =
    leading.sources.length >= 2 ? "distinct_sources" : "single_source";
  return finish(base, rule, corroboration, contradictions, gaps);
}

function finish(
  base: {
    businessId: string;
    subject: string;
    predicate: string;
    claimCount: number;
    distinctObservationCount: number;
    distinctSourceCount: number;
    observations: string[];
    sources: string[];
    provenance: Stage3Provenance[];
    independence: "unknown";
  },
  rule: Stage3AssessmentRule,
  corroboration: Corroboration | null,
  contradictions: Contradiction[],
  gaps: ReadonlySet<Stage3AssessmentGap>,
): Stage3AssessmentGroup {
  return {
    ...base,
    rule,
    corroboration,
    contradictions,
    gaps: [...gaps].sort(compareText),
  };
}

function buildValueBuckets(
  claims: readonly Claim[],
  normalizer: Normalizer,
  provenance: ReadonlyMap<string, string>,
): Map<string, ValueBucket> {
  const buckets = new Map<string, ValueBucket>();

  for (const claim of claims) {
    const normalized = normalizer(claim.value!);
    const observationId = claim.evidence[0]!.observationId;
    let bucket = buckets.get(normalized);
    if (!bucket) {
      bucket = { normalized, claims: [], observations: [], sources: [] };
      buckets.set(normalized, bucket);
    }
    bucket.claims.push(claim);
    if (!bucket.observations.includes(observationId)) {
      bucket.observations.push(observationId);
      bucket.sources.push(provenance.get(observationId)!);
    }
  }

  for (const bucket of buckets.values()) {
    bucket.observations.sort(compareText);
    bucket.sources = sortedUnique(bucket.sources);
  }
  return buckets;
}

/**
 * Конфликт = есть два наблюдения, которые НЕ делят ни одного значения.
 *
 * Это сознательно консервативное правило: один source может легально
 * перечислить два телефона, и это не спор между источниками. Пока у всех
 * наблюдений есть общее значение, противоречие не заявляется.
 */
function hasSourceConflict(buckets: ReadonlyMap<string, ValueBucket>): boolean {
  const byObservation = new Map<string, Set<string>>();
  for (const bucket of buckets.values()) {
    for (const observationId of bucket.observations) {
      let set = byObservation.get(observationId);
      if (!set) {
        set = new Set();
        byObservation.set(observationId, set);
      }
      set.add(bucket.normalized);
    }
  }

  const ids = [...byObservation.keys()].sort(compareText);
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const left = byObservation.get(ids[i]!)!;
      const right = byObservation.get(ids[j]!)!;
      let shared = false;
      for (const value of left) {
        if (right.has(value)) {
          shared = true;
          break;
        }
      }
      if (!shared) return true;
    }
  }
  return false;
}

function buildContradiction(
  businessId: string,
  bucket: SubjectBucket,
  valueBuckets: ReadonlyMap<string, ValueBucket>,
  claims: readonly Claim[],
): Contradiction {
  const sides = [...valueBuckets.values()]
    .sort((a, b) => compareText(a.normalized, b.normalized))
    .map((valueBucket) => ({
      value: valueBucket.claims[0]!.value,
      claims: valueBucket.claims,
    }));

  return {
    id: stableContradictionId({
      businessId,
      subject: bucket.subject,
      predicate: bucket.predicate,
      values: [...valueBuckets.keys()].sort(compareText),
    }),
    businessId,
    subject: bucket.subject,
    predicate: bucket.predicate,
    sides,
    // §8: не `now()` — момент последнего вошедшего наблюдения, поэтому
    // повторная проекция того же входа даёт байт-в-байт тот же ответ.
    detectedAt: latestCreatedAt(claims),
    // §5: `validTo = null` у Stage 3 — temporal semantics нет, поэтому
    // «предпочесть более новое» было бы категорическим выводом без данных.
    resolution: "unresolved",
    status: "unresolved",
  };
}

function latestCreatedAt(claims: readonly Claim[]): string {
  let latest = claims[0]!;
  let latestMs = Date.parse(latest.createdAt);
  for (const claim of claims) {
    const ms = Date.parse(claim.createdAt);
    if (ms > latestMs) {
      latest = claim;
      latestMs = ms;
    }
  }
  return latest.createdAt;
}

/**
 * Стабильный id противоречия: SHA-256 от (business, subject, predicate,
 * отсортированных нормализованных значений) с выставленными version/variant
 * битами. Одинаковый вход — одинаковый id, порядок подачи не влияет.
 */
export function stableContradictionId(input: {
  businessId: string;
  subject: string;
  predicate: string;
  values: readonly string[];
}): string {
  const digest = createHash("sha256")
    .update(
      [
        input.businessId,
        input.subject,
        input.predicate,
        ...input.values,
      ].join("\u0000"),
    )
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareClaims(a: Claim, b: Claim): number {
  return (
    compareText(a.predicate, b.predicate) ||
    compareText(a.value ?? "", b.value ?? "") ||
    compareText(a.id, b.id)
  );
}

function compareGroups(a: Stage3AssessmentGroup, b: Stage3AssessmentGroup) {
  return compareText(a.subject, b.subject) || compareText(a.predicate, b.predicate);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

/** Закрытый словарь Stage 1 не должен расходиться с таблицей сравнения. */
const TABLE_KEYS: readonly string[] = Object.keys(CLAIM_COMPARISON_TABLE);
for (const key of TABLE_KEYS) {
  if (!(EXTRACTABLE_ATTRIBUTES as readonly string[]).includes(key))
    throw new Error(`claim comparison table holds unknown predicate: ${key}`);
}
