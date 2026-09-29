import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import type { ClassifiedCandidate } from "./classifier.ts";
import { decideCandidate, scoreCandidate } from "./entity-resolution.ts";
import { ensureBusinessEntity } from "./entity-graph.ts";
import { upsertSourceContext } from "./source-context.ts";
import type { AutoAcceptRuleId, MatchThresholds, MatchWeights } from "./config.ts";
import type { DiscoveryProfile } from "./profile.ts";

/**
 * Персистентность discovery-кандидатов (§14). Дедупликация — по
 * (business_id, normalized_url): повторные run'ы не плодят строки.
 *
 * Тенант-скоуп здесь сохраняется: кандидат — состояние анализа конкретного
 * бизнеса, а не публичный факт (см. §5 в docs/OSINT_ARCHITECTURE.md).
 */

export type CandidateStatus = "candidate" | "accepted" | "rejected";

export type PersistCandidateInput = {
  businessId: string;
  runId: string | null;
  entityId: string | null;
  profile: DiscoveryProfile;
  classified: ClassifiedCandidate;
  provider: string;
  query: string | null;
  position: number | null;
  weights?: MatchWeights;
  thresholds?: MatchThresholds;
};

export type PersistCandidateResult = {
  id: string;
  status: CandidateStatus;
  score: number;
  rule: AutoAcceptRuleId | null;
  reasons: string[];
  isNew: boolean;
  duplicate: boolean;
};

const STATUS_RANK: Record<CandidateStatus, number> = {
  rejected: 0,
  candidate: 1,
  accepted: 2,
};

export async function persistCandidate(
  db: Kysely<Database>,
  input: PersistCandidateInput,
): Promise<PersistCandidateResult> {
  const { classified, profile } = input;
  const scored = scoreCandidate(
    {
      url: classified.normalizedUrl,
      title: classified.title,
      snippet: classified.snippet,
    },
    profile,
    input.weights,
    input.thresholds,
  );
  const decision = decideCandidate(scored, profile, input.thresholds);

  const existing = await db
    .selectFrom("osint_source_candidates")
    .select(["id", "status", "confidence"])
    .where("business_id", "=", input.businessId)
    .where("normalized_url", "=", classified.normalizedUrl)
    .executeTakeFirst();

  if (existing) {
    const existingStatus = existing.status as CandidateStatus;
    if (STATUS_RANK[decision.status] > STATUS_RANK[existingStatus]) {
      await db
        .updateTable("osint_source_candidates")
        .set({
          status: decision.status,
          confidence: String(scored.score),
          match_reasons: scored.reasons,
          discovered_at: new Date(),
          updated_at: new Date(),
        })
        .where("id", "=", existing.id)
        .execute();
    }
    return {
      id: existing.id,
      status:
        STATUS_RANK[decision.status] > STATUS_RANK[existingStatus]
          ? decision.status
          : existingStatus,
      score: scored.score,
      rule: decision.rule,
      reasons: scored.reasons,
      isNew: false,
      duplicate: true,
    };
  }

  const id = randomUUID();
  await db
    .insertInto("osint_source_candidates")
    .values({
      id,
      business_id: input.businessId,
      discovery_run_id: input.runId,
      entity_id: input.entityId,
      source_id: null,
      url: classified.normalizedUrl.slice(0, 2048),
      normalized_url: classified.normalizedUrl,
      type: classified.type,
      provider: input.provider,
      title: classified.title,
      snippet: classified.snippet,
      discovery_method: classified.method,
      query: input.query,
      search_position: input.position,
      confidence: String(scored.score),
      match_reasons: scored.reasons,
      evidence: scored.signals,
      status: decision.status,
      decided_by_user_id: null,
      decided_at: null,
      discovered_at: new Date(),
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();

  return {
    id,
    status: decision.status,
    score: scored.score,
    rule: decision.rule,
    reasons: scored.reasons,
    isNew: true,
    duplicate: false,
  };
}

/**
 * Находит или создаёт сущность «наш бизнес» (§3, §4).
 *
 * Глобальная сущность дедуплицируется ТОЛЬКО по identity_key — по одному
 * имени никогда (§12). Принадлежность тенанту закрепляется мостом
 * osint_business_entities, а не колонкой в самой сущности.
 */
export async function ensureEntity(
  db: Kysely<Database>,
  input: {
    businessId: string;
    profile: DiscoveryProfile;
    sourceKind?: "discovery" | "manual";
  },
): Promise<string> {
  return ensureBusinessEntity(db, {
    businessId: input.businessId,
    profile: input.profile,
    relationship: "OWNER",
    confidence: 1,
    sourceKind: input.sourceKind,
  });
}

/**
 * Создаёт глобальный источник из принятого кандидата (авто-accept) или
 * возвращает уже существующий — UNIQUE (normalized_url) защищает от гонок.
 *
 * Владение источником не хранится в самой строке: связи entity↔source —
 * в osint_entity_sources, structured context — в osint_source_context.
 */
export async function ensureSource(
  db: Kysely<Database>,
  input: {
    entityId: string;
    classified: ClassifiedCandidate;
    provider: string;
    autoAccepted: boolean;
    confidence: number;
  },
): Promise<string> {
  const { classified } = input;

  const existing = await db
    .selectFrom("osint_sources")
    .select("id")
    .where("normalized_url", "=", classified.normalizedUrl)
    .executeTakeFirst();
  if (existing) {
    await linkEntitySource(db, {
      entityId: input.entityId,
      sourceId: existing.id,
      confidence: input.confidence,
    });
    return existing.id;
  }

  const id = randomUUID();
  try {
    await db
      .insertInto("osint_sources")
      .values({
        id,
        type: classified.type,
        provider: input.provider,
        url: classified.normalizedUrl,
        normalized_url: classified.normalizedUrl,
        name: (classified.title ?? classified.host).slice(0, 300),
        status: "active",
        trust_level: classified.trustLevel,
        origin: "discovery",
        auto_accepted: input.autoAccepted,
        last_collected_at: null,
        last_success_at: null,
        last_error_at: null,
        last_error: null,
        next_collection_at: null,
        collection_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      })
      .execute();
  } catch (error) {
    const raced = await db
      .selectFrom("osint_sources")
      .select("id")
      .where("normalized_url", "=", classified.normalizedUrl)
      .executeTakeFirst();
    if (!raced) throw error;
    await linkEntitySource(db, {
      entityId: input.entityId,
      sourceId: raced.id,
      confidence: input.confidence,
    });
    return raced.id;
  }

  // Structured source memory (§1) — контекст заводим сразу при создании.
  await upsertSourceContext(db, {
    sourceId: id,
    patch: {
      canonical_name: (classified.title ?? classified.host).slice(0, 300),
      category: null,
      domains: [classified.host],
    },
    changeKind: "create",
  });

  await linkEntitySource(db, {
    entityId: input.entityId,
    sourceId: id,
    confidence: input.confidence,
  });
  return id;
}

/**
 * Связь entity↔source — глобальная (§6). business_id здесь намеренно нет:
 * источник и сущность принадлежат всему графу.
 */
export async function linkEntitySource(
  db: Kysely<Database>,
  input: {
    entityId: string;
    sourceId: string;
    confidence: number;
  },
): Promise<void> {
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: input.entityId,
      source_id: input.sourceId,
      confidence: String(input.confidence),
      created_at: new Date(),
    })
    .onConflict((oc) => oc.columns(["entity_id", "source_id"]).doNothing())
    .execute();
}

/** Обновляет связь кандидата с созданным источником/сущностью. */
export async function attachCandidateSource(
  db: Kysely<Database>,
  input: { candidateId: string; sourceId: string; entityId: string },
): Promise<void> {
  await db
    .updateTable("osint_source_candidates")
    .set({
      source_id: input.sourceId,
      entity_id: input.entityId,
      updated_at: new Date(),
    })
    .where("id", "=", input.candidateId)
    .execute();
}
