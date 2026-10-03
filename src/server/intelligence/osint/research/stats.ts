/**
 * Реальная статистика исследования (§10).
 *
 * Разрыв Stage 5 был в том, что UI показывал счётчики-заглушки. Здесь они
 * считаются по фактическим данным.
 *
 * Ключевая сложность: факты НЕ имеют run_id. Факт принадлежит бизнесу
 * (osint_intelligence_facts.business_id), а не конкретному запуску. Поэтому
 * метрики запуска считаются по связям, которые действительно существуют:
 * факты бизнеса, новые сущности через мост osint_business_entities, и
 * наблюдения через источники этого бизнеса.
 *
 * Правило, которое здесь соблюдается: один факт считается ОДИН РАЗ, даже
 * если подтверждён несколькими источниками. osint_intelligence_facts имеет
 * fingerprint на (business, type, key, source), поэтому повторные извлечения
 * из того же источника не плодят строки — но разные источники порождают
 * разные fingerprint. Считаем по fingerprint, а не по строкам.
 */

import { sql, type Kysely } from "kysely";
import type { Database } from "../../../db/schema.ts";

export type ResearchStats = {
  /** Уникальные факты, различающиеся по fingerprint. */
  facts: number;
  /** Подтверждённые факты (status ACTIVE). */
  confirmedFacts: number;
  /** Факты, которые менялись во времени. */
  changedFacts: number;
  /** Наблюдения, связанные с источниками этого бизнеса. */
  observations: number;
  /** Источники, привязанные к сущностям бизнеса. */
  sources: number;
  /** Новые сущности, связанные с бизнесом. */
  entities: number;
  /** Подтверждённые (не кандидаты) сущности. */
  linkedEntities: number;
  /** Незакрытые противоречия. */
  contradictions: number;
  /** Направления, где есть подтверждённый факт. */
  confirmedAreas: string[];
};

/**
 * Считает статистику по фактическим данным бизнеса.
 *
 * Все запросы тенант-скоуплены по business_id. Глобальная source memory
 * используется только через мост osint_business_entities, поэтому факт
 * другого тенанта сюда не попадёт.
 */
export async function computeResearchStats(
  db: Kysely<Database>,
  businessId: string,
): Promise<ResearchStats> {
  const [factRow, observationRow, sourceRow, entityRow, contradictionRow, areaRow] =
    await Promise.all([
      sql<{ total: string; active: string }>`
        select
          count(distinct fingerprint)::text as total,
          count(distinct fingerprint) filter (where status = 'ACTIVE')::text as active
        from osint_intelligence_facts
        where business_id = ${businessId}
      `.execute(db),
      sql<{ n: string }>`
        select count(distinct o.id)::text as n
        from osint_observations o
        join osint_entity_sources es on es.source_id = o.source_id
        join osint_business_entities be on be.entity_id = es.entity_id
        where be.business_id = ${businessId}
          and be.status <> 'rejected'
      `.execute(db),
      sql<{ n: string }>`
        select count(distinct es.source_id)::text as n
        from osint_entity_sources es
        join osint_business_entities be on be.entity_id = es.entity_id
        where be.business_id = ${businessId}
          and be.status <> 'rejected'
      `.execute(db),
      sql<{ total: string; linked: string }>`
        select
          count(*)::text as total,
          count(*) filter (where be.status = 'linked')::text as linked
        from osint_business_entities be
        where be.business_id = ${businessId}
          and be.status <> 'rejected'
      `.execute(db),
      sql<{ n: string }>`
        select count(*)::text as n
        from osint_intelligence_contradictions
        where business_id = ${businessId}
          and status = 'unresolved'
      `.execute(db),
      sql<{ fact_type: string }>`
        select distinct fact_type
        from osint_intelligence_facts
        where business_id = ${businessId}
          and status = 'ACTIVE'
      `.execute(db),
    ]);

  const changed = await sql<{ n: string }>`
    select count(distinct fingerprint)::text as n
    from osint_fact_changes
    where business_id = ${businessId}
  `.execute(db);

  return {
    facts: Number(factRow.rows[0]?.total ?? 0),
    confirmedFacts: Number(factRow.rows[0]?.active ?? 0),
    changedFacts: Number(changed.rows[0]?.n ?? 0),
    observations: Number(observationRow.rows[0]?.n ?? 0),
    sources: Number(sourceRow.rows[0]?.n ?? 0),
    entities: Number(entityRow.rows[0]?.total ?? 0),
    linkedEntities: Number(entityRow.rows[0]?.linked ?? 0),
    contradictions: Number(contradictionRow.rows[0]?.n ?? 0),
    confirmedAreas: areaRow.rows.map((row) => String(row.fact_type)),
  };
}

/**
 * Соответствие типов фактов направлениям исследования.
 *
 * ВАЖНО: направления reviews / mentions / news / vacancies здесь
 * отсутствуют намеренно. В схеме нет типов фактов, которые свидетельствовали
 * бы об их изучении, и подставлять «название компании» вместо «найдены
 * отзывы» — значит показывать пользователю закрытое направление, которое
 * никто не проверял. Пока фактов нет, такие направления остаются
 * неизвестными и видны в `unknown`.
 *
 * (Тип `business_name` существует и относится к identity — это название
 * БИЗНЕСА, найденное как факт, а не свидетельство изученности отзывов.)
 *
 * Позволяет перевести «есть активные факты» в «направление подтверждено»
 * без выдумывания: направление считается закрытым, только если в нём есть
 * подтверждённый факт соответствующего типа.
 */
const FACT_TYPES_BY_AREA: Record<string, string[]> = {
  identity: ["business_name", "brand_name", "legal_name"],
  contact: ["phone", "email", "address"],
  website: ["website", "domain"],
  social: ["telegram", "vk", "instagram", "facebook", "youtube", "tiktok", "other_social"],
  legal: ["legal_name", "registration_identifier", "tax_identifier", "license_identifier"],
  locations: ["address", "city", "region", "postal_code"],
  services: ["service"],
  products: ["product"],
};

/**
 * Какие направления реально подтверждены находками.
 *
 * Возвращает ТОЛЬКО те направления, где есть активный подтверждённый факт.
 * Направление без находок остаётся неизвестным — успешный, но пустой запрос
 * не делает направление исследованным.
 */
export function confirmedAreasFromFacts(
  confirmedFactTypes: readonly string[],
): Set<string> {
  const available = new Set(confirmedFactTypes);
  const out = new Set<string>();
  for (const [area, types] of Object.entries(FACT_TYPES_BY_AREA)) {
    if (types.some((type) => available.has(type))) out.add(area);
  }
  return out;
}
