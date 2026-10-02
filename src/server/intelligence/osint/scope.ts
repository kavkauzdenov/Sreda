import { sql } from "kysely";

/**
 * Единый тенант-скоуп наблюдений (§7).
 *
 * Наблюдение глобально (070 убрал business_id), поэтому читается только
 * через тенантский мост `osint_business_entities` (status <> 'rejected'),
 * либо через `osint_entity_sources` → мост. Одна и та же предпосылка и у
 * объяснения одного наблюдения (v1), и у bulk-оценки (v2), и у enrichment
 * Stage 4: все читатели обязаны использовать ЭТОТ фрагмент, а не свои
 * варианты. Скоуп предполагает, что таблица наблюдений алиасирована `o`.
 */
export function tenantObservationScope(businessId: string) {
  return sql<boolean>`
    (
      EXISTS (
        SELECT 1
        FROM osint_business_entities be
        WHERE be.business_id = ${businessId}
          AND be.entity_id = o.entity_id
          AND be.status <> 'rejected'
      )
      OR EXISTS (
        SELECT 1
        FROM osint_entity_sources es
        JOIN osint_business_entities be2 ON be2.entity_id = es.entity_id
        WHERE es.source_id = o.source_id
          AND be2.business_id = ${businessId}
          AND be2.status <> 'rejected'
      )
    )
  `;
}
