import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import {
  priorityTierFor,
  TRAVERSAL_PRIORITY,
  type DiscoveryBudget,
  type TraversalPriorityTier,
} from "./config.ts";
import { readRelations } from "./relations.ts";

/**
 * Knowledge-graph traversal (§21-§25).
 *
 * Обход идёт ТОЛЬКО по уже собранным данным графа (relations, entity_sources,
 * observations). Реального HTML-fetch здесь нет (§26) — приоритет, глубина
 * и бюджеты законтрактованы заранее, чтобы коллекторы Этапов 5+ просто
 * подставились под этот же план.
 *
 * §22: обход в ширину, глубина 0..maxDepth.
 * §24: источники сортируются по приоритету — официальный сайт раньше
 *      директории, директория раньше чужого упоминания.
 * §23: жёсткие бюджеты entities/sources/observations/requests.
 */

export type TraversalStep = {
  depth: number;
  entityId: string;
  displayName: string;
  tier: TraversalPriorityTier;
  sourceIds: string[];
  observationIds: string[];
};

export type TraversalStats = {
  visited_entities: number;
  discovered_sources: number;
  scanned_observations: number;
  requests_spent: number;
  budget_hits: string[];
  max_depth_reached: number;
  steps: number;
};

export type TraversalPlan = {
  steps: TraversalStep[];
  stats: TraversalStats;
  truncated: boolean;
};

export type BuildTraversalPlanInput = {
  rootEntityId: string;
  budget: DiscoveryBudget;
  asOf?: Date;
  /** Сколько «запросов» уже потрачено до старта (для resume). */
  requestsSpent?: number;
};

const emptyStats = (): TraversalStats => ({
  visited_entities: 0,
  discovered_sources: 0,
  scanned_observations: 0,
  requests_spent: 0,
  budget_hits: [],
  max_depth_reached: 0,
  steps: 0,
});

/** Порядок tier'ов: чем меньше индекс, тем приоритетнее источник (§24). */
const tierRank = (tier: TraversalPriorityTier): number =>
  TRAVERSAL_PRIORITY.indexOf(tier);

type EntityRow = { id: string; display_name: string };

export async function buildTraversalPlan(
  db: Kysely<Database>,
  input: BuildTraversalPlanInput,
): Promise<TraversalPlan> {
  const { budget } = input;
  const asOf = input.asOf ?? new Date();
  const stats = emptyStats();
  stats.requests_spent = input.requestsSpent ?? 0;

  const steps: TraversalStep[] = [];
  const visited = new Set<string>();
  const budgetHits: string[] = [];

  let frontier: { entityId: string; depth: number }[] = [
    { entityId: input.rootEntityId, depth: 0 },
  ];

  while (frontier.length) {
    const next: { entityId: string; depth: number }[] = [];

    for (const node of frontier) {
      if (visited.has(node.entityId)) continue;

      if (stats.visited_entities >= budget.maxEntities) {
        if (!budgetHits.includes("max_entities")) budgetHits.push("max_entities");
        break;
      }

      const entity = (await db
        .selectFrom("osint_entities")
        .select(["id", "display_name"])
        .where("id", "=", node.entityId)
        .executeTakeFirst()) as EntityRow | undefined;
      if (!entity) continue;

      visited.add(node.entityId);
      stats.visited_entities += 1;
      stats.max_depth_reached = Math.max(stats.max_depth_reached, node.depth);

      const sources = await db
        .selectFrom("osint_entity_sources")
        .select(["source_id", "confidence"])
        .where("entity_id", "=", node.entityId)
        .orderBy("confidence", "desc")
        .execute();

      const sourceIds: string[] = [];
      let tier: TraversalPriorityTier = "public_mentions";
      let tierRankValue = tierRank(tier);

      for (const row of sources) {
        if (stats.discovered_sources >= budget.maxSources) {
          if (!budgetHits.includes("max_sources")) budgetHits.push("max_sources");
          break;
        }
        const source = await db
          .selectFrom("osint_sources")
          .select(["id", "type", "status"])
          .where("id", "=", row.source_id)
          .executeTakeFirst();
        if (!source || source.status === "disabled") continue;

        sourceIds.push(source.id);
        stats.discovered_sources += 1;
        stats.requests_spent += 1;

        const candidateTier = priorityTierFor(source.type);
        const candidateRank = tierRank(candidateTier);
        if (candidateRank < tierRankValue) {
          tier = candidateTier;
          tierRankValue = candidateRank;
        }
        if (stats.requests_spent >= budget.maxRequests) {
          if (!budgetHits.includes("max_requests")) budgetHits.push("max_requests");
          break;
        }
      }

      const observations = await db
        .selectFrom("osint_observations")
        .select("id")
        .where("entity_id", "=", node.entityId)
        .orderBy("observed_at", "desc")
        .limit(
          Math.max(0, budget.maxObservations - stats.scanned_observations),
        )
        .execute();
      const observationIds = observations.map((row) => row.id);
      stats.scanned_observations += observationIds.length;
      if (stats.scanned_observations >= budget.maxObservations) {
        if (!budgetHits.includes("max_observations"))
          budgetHits.push("max_observations");
      }

      steps.push({
        depth: node.depth,
        entityId: node.entityId,
        displayName: entity.display_name,
        tier,
        sourceIds,
        observationIds,
      });
      stats.steps += 1;

      if (node.depth >= budget.maxDepth) {
        if (!budgetHits.includes("max_depth")) budgetHits.push("max_depth");
        continue;
      }

      const relations = await readRelations(db, node.entityId, { asOf });
      for (const relation of relations) {
        const neighbour =
          relation.from_entity_id === node.entityId
            ? relation.to_entity_id
            : relation.from_entity_id;
        if (visited.has(neighbour)) continue;
        next.push({ entityId: neighbour, depth: node.depth + 1 });
      }

      if (stats.visited_entities >= budget.maxEntities) break;
      if (stats.requests_spent >= budget.maxRequests) break;
    }

    // §24: соседи уровня сортируются по приоритету лучшего источника.
    frontier = next;
    if (stats.visited_entities >= budget.maxEntities) {
      if (!budgetHits.includes("max_entities")) budgetHits.push("max_entities");
      break;
    }
    if (stats.requests_spent >= budget.maxRequests) {
      if (!budgetHits.includes("max_requests")) budgetHits.push("max_requests");
      break;
    }
  }

  steps.sort((a, b) => a.depth - b.depth || tierRank(a.tier) - tierRank(b.tier));
  stats.budget_hits = budgetHits;

  return { steps, stats, truncated: budgetHits.length > 0 };
}

export type TraversalRunResult = {
  plan: TraversalPlan;
  depth: number;
};

/**
 * Строит план и персистит его в тенантском run (§25): depth, max_depth, stats.
 * Сетевых вызовов нет — обход читает только локальный граф.
 */
export async function runTraversal(
  db: Kysely<Database>,
  input: {
    runId: string;
    businessId: string;
    rootEntityId: string;
    budget: DiscoveryBudget;
    asOf?: Date;
  },
): Promise<TraversalRunResult> {
  const plan = await buildTraversalPlan(db, {
    rootEntityId: input.rootEntityId,
    budget: input.budget,
    asOf: input.asOf,
  });

  await db
    .updateTable("osint_discovery_runs")
    .set({
      depth: plan.stats.max_depth_reached,
      max_depth: input.budget.maxDepth,
      stats: plan.stats as unknown as Record<string, unknown>,
      root_entity_id: input.rootEntityId,
      updated_at: new Date(),
    })
    .where("id", "=", input.runId)
    .where("business_id", "=", input.businessId)
    .execute();

  return { plan, depth: plan.stats.max_depth_reached };
}
