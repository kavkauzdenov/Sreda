import type { Kysely } from "kysely";
import type { Database } from "../../db/schema.ts";
import {
  OSINT_FACT_TYPES,
  type OsintFactType,
} from "./schema.ts";
import type {
  OsintIntelChange,
  OsintIntelContradiction,
  OsintIntelFact,
  OsintIntelLastRun,
  OsintIntelPage,
  OsintIntelProfile,
  OsintIntelResolution,
  OsintIntelSourceRef,
} from "@/lib/intelligence-types.ts";

/**
 * Read model Stage 4 (§26.12): on-read проекция без materialized view.
 *
 * Правила:
 *  - профиль собирается ТОЛЬКО из ACTIVE facts — STALE/RETIRED не участвуют;
 *  - без N+1: источники присоединяются одним join, страницы — один запрос
 *    + count; профиль — ограниченное число независимых запросов;
 *  - детерминированный порядок (ORDER BY с полным разрешением) — одинаковые
 *    данные → одинаковой ответ;
 *  - провенанс не дублируется: каждая fact несёт source + observationId,
 *    drill-down уходит в существующий Stage 3 observation slice.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;
const PROFILE_CHANGE_LIMIT = 10;

type PageOptions = { limit?: number | string | null; offset?: number | string | null };

function clampPage(options: PageOptions): { limit: number; offset: number } {
  const parsedLimit = Number(options.limit);
  const parsedOffset = Number(options.offset);
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.trunc(parsedLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0
    ? Math.min(Math.trunc(parsedOffset), MAX_OFFSET)
    : 0;
  return { limit, offset };
}

function isFactType(value: string): value is OsintFactType {
  return (OSINT_FACT_TYPES as readonly string[]).includes(value);
}

function iso(value: Date): string {
  return value.toISOString();
}

function sourceRef(id: string, name: string, url: string): OsintIntelSourceRef {
  return { id, name, url };
}

/** jsonb может прийти строкой (защита от разных драйверов) — принимаем оба. */
function parseJson<T>(value: unknown): T {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as unknown as T;
    }
  }
  return value as T;
}

/* ========================================================================
 * GET .../osint/facts
 * ====================================================================== */

export async function listFacts(
  db: Kysely<Database>,
  businessId: string,
  options: PageOptions & { factType?: string | null } = {},
): Promise<OsintIntelPage<OsintIntelFact>> {
  const { limit, offset } = clampPage(options);
  if (options.factType && !isFactType(options.factType)) {
    // Неизвестный тип — пустая страница, а не ошибка: список типов открыт.
    return { businessId, total: 0, limit, offset, items: [] };
  }
  const factType = options.factType as OsintFactType | undefined;

  let base = db
    .selectFrom("osint_intelligence_facts as f")
    .innerJoin("osint_sources as s", "s.id", "f.source_id")
    .where("f.business_id", "=", businessId);
  if (factType) base = base.where("f.fact_type", "=", factType);

  const countRow = await base
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .executeTakeFirst();

  const rows = await base
    .select([
      "f.id as id",
      "f.fact_type as fact_type",
      "f.fact_key as fact_key",
      "f.value as value",
      "f.raw_value as raw_value",
      "f.status as status",
      "f.observation_id as observation_id",
      "f.first_seen_at as first_seen_at",
      "f.last_seen_at as last_seen_at",
      "f.observed_at as observed_at",
      "f.metadata as metadata",
      "f.source_id as source_id",
      "s.name as source_name",
      "s.normalized_url as source_url",
    ])
    .orderBy("f.last_seen_at", "desc")
    .orderBy("f.fact_type")
    .orderBy("f.fact_key")
    .orderBy("f.source_id")
    .limit(limit)
    .offset(offset)
    .execute();

  return {
    businessId,
    total: Number(countRow?.n ?? 0),
    limit,
    offset,
    items: rows.map((row) => {
      const metadata = parseJson<{ origin?: string }>(row.metadata ?? {});
      return {
        id: row.id,
        factType: row.fact_type,
        factKey: row.fact_key,
        value: row.value,
        rawValue: row.raw_value,
        status: row.status,
        source: sourceRef(row.source_id, row.source_name, row.source_url),
        observationId: row.observation_id,
        origin: typeof metadata.origin === "string" ? metadata.origin : null,
        firstSeenAt: iso(row.first_seen_at),
        lastSeenAt: iso(row.last_seen_at),
        observedAt: iso(row.observed_at),
      } satisfies OsintIntelFact;
    }),
  };
}

/* ========================================================================
 * GET .../osint/changes
 * ====================================================================== */

export async function listChanges(
  db: Kysely<Database>,
  businessId: string,
  options: PageOptions = {},
): Promise<OsintIntelPage<OsintIntelChange>> {
  const { limit, offset } = clampPage(options);

  const base = db
    .selectFrom("osint_fact_changes as c")
    .leftJoin("osint_sources as s", "s.id", "c.source_id")
    .where("c.business_id", "=", businessId);

  const countRow = await base
    .select(({ fn }) => fn.countAll<number>().as("n"))
    .executeTakeFirst();

  const rows = await base
    .select([
      "c.id as id",
      "c.fact_type as fact_type",
      "c.fact_key as fact_key",
      "c.change_kind as change_kind",
      "c.old_value as old_value",
      "c.new_value as new_value",
      "c.source_id as source_id",
      "c.observation_id as observation_id",
      "c.detected_at as detected_at",
      "s.name as source_name",
      "s.normalized_url as source_url",
    ])
    .orderBy("c.detected_at", "desc")
    .orderBy("c.id")
    .limit(limit)
    .offset(offset)
    .execute();

  return {
    businessId,
    total: Number(countRow?.n ?? 0),
    limit,
    offset,
    items: rows.map((row) => ({
      id: row.id,
      factType: row.fact_type,
      factKey: row.fact_key,
      changeKind: row.change_kind,
      oldValue: row.old_value,
      newValue: row.new_value,
      source: row.source_id
        ? sourceRef(row.source_id, row.source_name ?? "", row.source_url ?? "")
        : null,
      observationId: row.observation_id,
      detectedAt: iso(row.detected_at),
    })),
  };
}

/* ========================================================================
 * GET .../osint/contradictions
 * ====================================================================== */

type SideRow = {
  value: string;
  sources?: unknown;
  observations?: unknown;
  firstSeen?: unknown;
  lastSeen?: unknown;
};

function normalizeSide(raw: unknown): OsintIntelContradiction["sides"][number] | null {
  if (!raw || typeof raw !== "object") return null;
  const side = raw as SideRow;
  const sources = Array.isArray(side.sources)
    ? (side.sources as { id?: unknown; name?: unknown; url?: unknown }[])
        .filter((source) => source && typeof source.id === "string")
        .map((source) =>
          sourceRef(
            source.id as string,
            typeof source.name === "string" ? source.name : "",
            typeof source.url === "string" ? source.url : "",
          ),
        )
    : [];
  const observations = Array.isArray(side.observations)
    ? (side.observations as unknown[]).filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return {
    value: typeof side.value === "string" ? side.value : "",
    sources,
    observations,
    firstSeen:
      typeof side.firstSeen === "string" ? side.firstSeen : new Date(0).toISOString(),
    lastSeen:
      typeof side.lastSeen === "string" ? side.lastSeen : new Date(0).toISOString(),
  };
}

export async function listContradictions(
  db: Kysely<Database>,
  businessId: string,
): Promise<{ businessId: string; contradictions: OsintIntelContradiction[] }> {
  const rows = await db
    .selectFrom("osint_intelligence_contradictions")
    .select([
      "id",
      "fact_type",
      "status",
      "value_count",
      "source_count",
      "sides",
      "detected_at",
      "updated_at",
    ])
    .where("business_id", "=", businessId)
    .orderBy("detected_at", "desc")
    .orderBy("fact_type")
    .execute();

  return {
    businessId,
    contradictions: rows.map((row) => {
      const parsed = parseJson<unknown[]>(row.sides ?? []);
      const sides = (Array.isArray(parsed) ? parsed : [])
        .map(normalizeSide)
        .filter((side): side is OsintIntelContradiction["sides"][number] =>
          side !== null,
        );
      return {
        id: row.id,
        factType: row.fact_type,
        status: row.status,
        valueCount: row.value_count,
        sourceCount: row.source_count,
        sides,
        detectedAt: iso(row.detected_at),
        updatedAt: iso(row.updated_at),
      } satisfies OsintIntelContradiction;
    }),
  };
}

/* ========================================================================
 * GET .../osint/profile
 * ====================================================================== */

const SOCIAL_TYPES = new Set<string>([
  "telegram",
  "vk",
  "instagram",
  "facebook",
  "youtube",
  "tiktok",
  "other_social",
]);

function toLastRun(row: {
  id: string;
  status: OsintIntelLastRun["status"];
  attempts: number;
  error: string | null;
  created_at: Date;
  finished_at: Date | null;
  stats: unknown;
} | undefined): OsintIntelLastRun | null {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    error: row.error,
    createdAt: iso(row.created_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    stats: row.stats && typeof row.stats === "object"
      ? parseJson<Record<string, unknown>>(row.stats)
      : null,
  };
}

export async function buildProfile(
  db: Kysely<Database>,
  businessId: string,
): Promise<OsintIntelProfile> {
  const [activeRows, statusRows, changesPage, contradictionList, runRow] =
    await Promise.all([
      db
        .selectFrom("osint_intelligence_facts")
        .select([
          "fact_type",
          "fact_key",
          "value",
          "first_seen_at",
          "last_seen_at",
        ])
        .where("business_id", "=", businessId)
        .where("status", "=", "ACTIVE")
        .orderBy("fact_type")
        .orderBy("value")
        .orderBy("fact_key")
        .execute(),
      db
        .selectFrom("osint_intelligence_facts")
        .select(["status"])
        .select(({ fn }) => fn.countAll<number>().as("n"))
        .where("business_id", "=", businessId)
        .groupBy("status")
        .execute(),
      listChanges(db, businessId, { limit: PROFILE_CHANGE_LIMIT, offset: 0 }),
      listContradictions(db, businessId),
      db
        .selectFrom("osint_enrichment_runs")
        .select([
          "id",
          "status",
          "attempts",
          "error",
          "created_at",
          "finished_at",
          "stats",
        ])
        .where("business_id", "=", businessId)
        .orderBy("created_at", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);

  const statusCounts = new Map<string, number>();
  for (const row of statusRows) {
    statusCounts.set(row.status, Number(row.n));
  }

  const names: string[] = [];
  const phones: string[] = [];
  const emails: string[] = [];
  const websites: string[] = [];
  const domains: string[] = [];
  const socials: { factType: OsintFactType; value: string }[] = [];
  const categories: string[] = [];
  let address: string | null = null;
  let city: string | null = null;
  let region: string | null = null;
  let country: string | null = null;
  const byTypeMap = new Map<OsintFactType, number>();

  for (const row of activeRows) {
    byTypeMap.set(row.fact_type, (byTypeMap.get(row.fact_type) ?? 0) + 1);
    switch (row.fact_type) {
      case "business_name":
        if (!names.includes(row.value)) names.push(row.value);
        break;
      case "phone":
        if (!phones.includes(row.value)) phones.push(row.value);
        break;
      case "email":
        if (!emails.includes(row.value)) emails.push(row.value);
        break;
      case "website":
        if (!websites.includes(row.value)) websites.push(row.value);
        break;
      case "domain":
        if (!domains.includes(row.value)) domains.push(row.value);
        break;
      case "category":
        if (!categories.includes(row.value)) categories.push(row.value);
        break;
      case "address":
        address ??= row.value;
        break;
      case "city":
        city ??= row.value;
        break;
      case "region":
        region ??= row.value;
        break;
      case "country":
        country ??= row.value;
        break;
      default:
        if (SOCIAL_TYPES.has(row.fact_type)) {
          socials.push({ factType: row.fact_type, value: row.value });
        }
        break;
    }
  }

  const run = toLastRun(runRow);
  const statsResolution = run?.stats?.resolution;
  const resolution =
    statsResolution && typeof statsResolution === "object"
      ? (parseJson<OsintIntelResolution>(statsResolution) ?? null)
      : null;

  const byType = [...byTypeMap.entries()]
    .map(([factType, count]) => ({ factType, count }))
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.factType < b.factType
          ? -1
          : 1,
    );

  return {
    businessId,
    resolution,
    names,
    phones,
    emails,
    websites,
    domains,
    socials,
    categories,
    address,
    city,
    region,
    country,
    counts: {
      active: statusCounts.get("ACTIVE") ?? 0,
      stale: statusCounts.get("STALE") ?? 0,
      retired: statusCounts.get("RETIRED") ?? 0,
      changes: changesPage.total,
      contradictions: contradictionList.contradictions.length,
    },
    byType,
    lastRun: run,
  };
}
