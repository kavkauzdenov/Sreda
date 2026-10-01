-- 071: OSINT repair pass (аудит Stage 1/2). Только новые объекты и уточнение
-- семантики удаления на границе тенант/глобал - применённые миграции не правятся
-- (checksum-guard в src/server/db/migrate.ts).
--
-- Правило удаления:
--   глобальный слой каскадится внутри себя.
--   граница «тенант <- глобальная сущность/наблюдение» никогда не удаляет
--   тенантские строки молча. NOT NULL ссылка -> RESTRICT, NULLable -> SET NULL.
--   удаление одного бизнеса не трогает строки другого тенанта.
--
-- Итоговое состояние FK проверено на PGlite после применения: у каждой
-- исправленной колонки ровно один внешний ключ (дублей нет).
--
-- В файлах миграций нет точек запятой внутри строк и комментариев -
-- migrate.ts режет содержимое по этим знакам препинания.

-- === Шаг 1. Индекс под releaseStaleDiscoveryRuns ===
-- Запрос: status IN ('queued','running') AND started_at < cutoff, без business_id.
-- Оба существующих индекса ведут с business_id - без этого сканируется вся таблица.
CREATE INDEX IF NOT EXISTS osint_discovery_runs_status_started_idx
  ON osint_discovery_runs (status, started_at)
  WHERE started_at IS NOT NULL;

-- === Шаг 2. Факт тенанта не исчезает из-за чужого глобального наблюдения ===
ALTER TABLE osint_facts DROP CONSTRAINT IF EXISTS osint_facts_observation_fkey;
ALTER TABLE osint_facts
  ADD CONSTRAINT osint_facts_observation_fkey
  FOREIGN KEY (source_observation_id) REFERENCES osint_observations (id)
  ON DELETE RESTRICT;

-- === Шаг 3. Мост тенанта не исчезает из-за удаления глобальной сущности ===
ALTER TABLE osint_business_entities DROP CONSTRAINT IF EXISTS osint_business_entities_entity_id_fkey;
ALTER TABLE osint_business_entities DROP CONSTRAINT IF EXISTS osint_business_entities_entity_fkey;
ALTER TABLE osint_business_entities
  ADD CONSTRAINT osint_business_entities_entity_id_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id)
  ON DELETE RESTRICT;

-- === Шаг 4. Явное закрепление правила для entity_id конкурента ===
-- 070 уже задал SET NULL на этом FK - блок повторяет правило, чтобы оно было
-- видно в одном месте вместе с остальными границами удаления. DROP + ADD
-- идемпотентны.
ALTER TABLE osint_competitor_candidates DROP CONSTRAINT IF EXISTS osint_competitor_entity_fkey;
ALTER TABLE osint_competitor_candidates
  ADD CONSTRAINT osint_competitor_entity_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id)
  ON DELETE SET NULL;

-- === Шаг 5. Удаление одного бизнеса не трогает чужие строки ===
-- osint_competitor_candidates принадлежит тенанту business_id, а ссылается
-- на второй бизнес candidate_business_id. CASCADE тут удалял бы запись
-- тенанта A, потому что удалили бизнес B. NULLable ссылка -> SET NULL.
ALTER TABLE osint_competitor_candidates DROP CONSTRAINT IF EXISTS osint_competitor_candidates_candidate_business_id_fkey;
ALTER TABLE osint_competitor_candidates
  ADD CONSTRAINT osint_competitor_candidates_candidate_business_id_fkey
  FOREIGN KEY (candidate_business_id) REFERENCES business (id)
  ON DELETE SET NULL;
