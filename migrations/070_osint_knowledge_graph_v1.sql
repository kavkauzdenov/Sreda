-- 070: OSINT knowledge graph + source memory (Этап 2, часть 2).
-- Расширяет 069, ничего из существующего не пересоздаёт.
--
-- Правила:
--   1. Публичный evidence-слой становится глобальным - osint_entities, osint_sources,
--      osint_observations, osint_entity_sources теряют business_id.
--   2. Тенант-скоуп сохраняется на osint_discovery_runs, osint_source_candidates,
--      osint_facts, osint_competitor_candidates, osint_findings, osint_finding_evidence.
--   3. Инвариант изоляции - ни одна таблица без business_id не должна иметь
--      внешний ключ на business, user или тенантские таблицы.
--   4. Провенанс discovery остаётся только в тенантском osint_source_candidates.
--      Глобальный osint_sources намеренно НЕ хранит discovery_run_id - иначе
--      tenant B вывел бы, кто первый нашёл источник.
--
-- Порядок обязателен: сначала сбрасываем FK и ограничения, потом колонки.
-- В файлах миграций нет точек с запятой внутри строк и комментариев -
-- migrate.ts режет содержимое по этой знакам препинания.

-- === Шаг 1. Сброс композитных FK, опирающихся на business_id публичных таблиц ===
ALTER TABLE osint_sources DROP CONSTRAINT IF EXISTS osint_sources_business_id_entity_id_fkey;
ALTER TABLE osint_source_candidates DROP CONSTRAINT IF EXISTS osint_source_candidates_business_id_entity_id_fkey;
ALTER TABLE osint_source_candidates DROP CONSTRAINT IF EXISTS osint_source_candidates_business_id_source_id_fkey;
ALTER TABLE osint_entity_sources DROP CONSTRAINT IF EXISTS osint_entity_sources_business_id_entity_id_fkey;
ALTER TABLE osint_entity_sources DROP CONSTRAINT IF EXISTS osint_entity_sources_business_id_source_id_fkey;
ALTER TABLE osint_observations DROP CONSTRAINT IF EXISTS osint_observations_business_id_source_id_fkey;
ALTER TABLE osint_observations DROP CONSTRAINT IF EXISTS osint_observations_business_id_entity_id_fkey;
ALTER TABLE osint_facts DROP CONSTRAINT IF EXISTS osint_facts_business_id_source_observation_id_fkey;
ALTER TABLE osint_competitor_candidates DROP CONSTRAINT IF EXISTS osint_competitor_candidates_business_id_entity_id_fkey;

-- === Шаг 2. Сброс PK, уникальных ограничений и индексов по business_id ===
ALTER TABLE osint_entity_sources DROP CONSTRAINT IF EXISTS osint_entity_sources_pkey;
ALTER TABLE osint_entities DROP CONSTRAINT IF EXISTS osint_entities_business_id_id_key;
ALTER TABLE osint_sources DROP CONSTRAINT IF EXISTS osint_sources_unique;
ALTER TABLE osint_sources DROP CONSTRAINT IF EXISTS osint_sources_business_id_id_key;
ALTER TABLE osint_observations DROP CONSTRAINT IF EXISTS osint_observations_business_id_id_key;
DROP INDEX IF EXISTS osint_entities_identity_idx;
DROP INDEX IF EXISTS osint_entities_name_idx;
DROP INDEX IF EXISTS osint_sources_business_status_idx;
DROP INDEX IF EXISTS osint_observations_business_idx;

-- === Шаг 3. Отделение публичного слоя от тенанта ===
ALTER TABLE osint_entities DROP COLUMN IF EXISTS business_id;
ALTER TABLE osint_sources DROP COLUMN IF EXISTS business_id;
ALTER TABLE osint_sources DROP COLUMN IF EXISTS entity_id;
ALTER TABLE osint_sources DROP COLUMN IF EXISTS discovery_run_id;
ALTER TABLE osint_observations DROP COLUMN IF EXISTS business_id;
ALTER TABLE osint_entity_sources DROP COLUMN IF EXISTS business_id;

-- === Шаг 4. Новые плоские FK ===
ALTER TABLE osint_source_candidates
  ADD CONSTRAINT osint_source_candidates_entity_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id) ON DELETE SET NULL;
ALTER TABLE osint_source_candidates
  ADD CONSTRAINT osint_source_candidates_source_fkey
  FOREIGN KEY (source_id) REFERENCES osint_sources (id) ON DELETE SET NULL;
ALTER TABLE osint_observations
  ADD CONSTRAINT osint_observations_source_fkey
  FOREIGN KEY (source_id) REFERENCES osint_sources (id) ON DELETE CASCADE;
ALTER TABLE osint_observations
  ADD CONSTRAINT osint_observations_entity_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id) ON DELETE SET NULL;
ALTER TABLE osint_entity_sources
  ADD CONSTRAINT osint_entity_sources_pkey
  PRIMARY KEY (entity_id, source_id);
ALTER TABLE osint_entity_sources
  ADD CONSTRAINT osint_entity_sources_entity_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id) ON DELETE CASCADE;
ALTER TABLE osint_entity_sources
  ADD CONSTRAINT osint_entity_sources_source_fkey
  FOREIGN KEY (source_id) REFERENCES osint_sources (id) ON DELETE CASCADE;
ALTER TABLE osint_facts
  ADD CONSTRAINT osint_facts_observation_fkey
  FOREIGN KEY (source_observation_id) REFERENCES osint_observations (id) ON DELETE CASCADE;
ALTER TABLE osint_competitor_candidates
  ADD CONSTRAINT osint_competitor_entity_fkey
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id) ON DELETE SET NULL;

-- === Шаг 5. Трассировка traversal в тенантском run (глобальная entity - допустимое направление) ===
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS depth integer NOT NULL DEFAULT 0;
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS max_depth integer NOT NULL DEFAULT 2;
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS stats jsonb NOT NULL DEFAULT '{}';
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS root_entity_id uuid
  REFERENCES osint_entities (id) ON DELETE SET NULL;

-- === Шаг 6. Глобальные индексы и уникальность публичного слоя ===
CREATE UNIQUE INDEX IF NOT EXISTS osint_entities_identity_global_idx
  ON osint_entities (identity_key)
  WHERE identity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS osint_entities_name_global_idx
  ON osint_entities (normalized_name);

ALTER TABLE osint_sources
  ADD CONSTRAINT osint_sources_normalized_url_key UNIQUE (normalized_url);

CREATE INDEX IF NOT EXISTS osint_observations_observed_at_idx
  ON osint_observations (observed_at DESC);

CREATE INDEX IF NOT EXISTS osint_observations_entity_idx
  ON osint_observations (entity_id)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS osint_entity_sources_source_idx
  ON osint_entity_sources (source_id);

-- === Шаг 7. Мост тенант -> глобальная сущность (§4) ===
CREATE TABLE IF NOT EXISTS osint_business_entities (
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES osint_entities (id) ON DELETE CASCADE,
  relationship text NOT NULL DEFAULT 'ABOUT'
    CONSTRAINT osint_business_entities_relationship_check
    CHECK (relationship IN ('OWNER','PUBLISHED_BY','MENTIONS','ABOUT','PARTNER','CLIENT','COMPETITOR','LOCATION','EMPLOYER','SPONSOR','SUPPLIER','CUSTOMER','RELATED_TO')),
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_business_entities_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'candidate'
    CONSTRAINT osint_business_entities_status_check
    CHECK (status IN ('candidate','linked','rejected')),
  evidence jsonb NOT NULL DEFAULT '[]',
  decided_by_user_id uuid REFERENCES "user" (id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, entity_id, relationship)
);

CREATE INDEX IF NOT EXISTS osint_business_entities_entity_idx
  ON osint_business_entities (entity_id);

CREATE INDEX IF NOT EXISTS osint_business_entities_status_idx
  ON osint_business_entities (business_id, status);

-- === Шаг 8. Structured source context (§1) - глобально, без business_id ===
CREATE TABLE IF NOT EXISTS osint_source_context (
  source_id uuid PRIMARY KEY REFERENCES osint_sources (id) ON DELETE CASCADE,
  canonical_name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  category text,
  language text,
  city text,
  region text,
  country text,
  address text,
  contacts jsonb NOT NULL DEFAULT '[]',
  domains jsonb NOT NULL DEFAULT '[]',
  social_links jsonb NOT NULL DEFAULT '{}',
  known_owner_entity_id uuid REFERENCES osint_entities (id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  first_observed_at timestamptz NOT NULL DEFAULT now(),
  last_observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_source_context_name_len CHECK (char_length(canonical_name) <= 300),
  CONSTRAINT osint_source_context_desc_len CHECK (char_length(description) <= 4000)
);

CREATE INDEX IF NOT EXISTS osint_source_context_owner_idx
  ON osint_source_context (known_owner_entity_id)
  WHERE known_owner_entity_id IS NOT NULL;

-- === Шаг 9. History перезаписей контекста (§19) - не затираем историю ===
CREATE TABLE IF NOT EXISTS osint_source_history (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES osint_sources (id) ON DELETE CASCADE,
  change_kind text NOT NULL DEFAULT 'update'
    CONSTRAINT osint_source_history_kind_check
    CHECK (change_kind IN ('create','update','auto_collect','manual_edit','merge')),
  changed_fields jsonb NOT NULL DEFAULT '[]',
  snapshot jsonb NOT NULL DEFAULT '{}',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS osint_source_history_source_idx
  ON osint_source_history (source_id, valid_from DESC);

-- === Шаг 10. Mentions из наблюдений (§8, §9) - evidence обязателен ===
CREATE TABLE IF NOT EXISTS osint_entity_mentions (
  id uuid PRIMARY KEY,
  observation_id uuid NOT NULL REFERENCES osint_observations (id) ON DELETE CASCADE,
  entity_id uuid NOT NULL REFERENCES osint_entities (id) ON DELETE CASCADE,
  mention_type text NOT NULL DEFAULT 'MENTIONS'
    CONSTRAINT osint_entity_mentions_type_check
    CHECK (mention_type IN ('OWNER','PUBLISHED_BY','MENTIONS','ABOUT','PARTNER','CLIENT','COMPETITOR','LOCATION','EMPLOYER','SPONSOR','SUPPLIER','CUSTOMER','RELATED_TO')),
  text_span text NOT NULL DEFAULT ''
    CONSTRAINT osint_entity_mentions_span_len CHECK (char_length(text_span) BETWEEN 0 AND 500),
  context text NOT NULL DEFAULT '',
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_entity_mentions_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_entity_mentions_span_unique UNIQUE (observation_id, entity_id, mention_type, text_span)
);

CREATE INDEX IF NOT EXISTS osint_entity_mentions_entity_idx
  ON osint_entity_mentions (entity_id, created_at DESC);

CREATE INDEX IF NOT EXISTS osint_entity_mentions_observation_idx
  ON osint_entity_mentions (observation_id);

-- === Шаг 11. Relations между сущностями (§15) - evidence обязателен ===
CREATE TABLE IF NOT EXISTS osint_entity_relations (
  id uuid PRIMARY KEY,
  from_entity_id uuid NOT NULL REFERENCES osint_entities (id) ON DELETE CASCADE,
  to_entity_id uuid NOT NULL REFERENCES osint_entities (id) ON DELETE CASCADE,
  relation_type text NOT NULL
    CONSTRAINT osint_entity_relations_type_check
    CHECK (relation_type IN ('OWNER','PUBLISHED_BY','MENTIONS','ABOUT','PARTNER','CLIENT','COMPETITOR','LOCATION','EMPLOYER','SPONSOR','SUPPLIER','CUSTOMER','RELATED_TO')),
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_entity_relations_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  source_observation_id uuid NOT NULL REFERENCES osint_observations (id) ON DELETE CASCADE,
  evidence jsonb NOT NULL DEFAULT '{}',
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_entity_relations_no_self CHECK (from_entity_id <> to_entity_id),
  CONSTRAINT osint_entity_relations_dedupe UNIQUE (from_entity_id, to_entity_id, relation_type, source_observation_id)
);

CREATE INDEX IF NOT EXISTS osint_entity_relations_from_idx
  ON osint_entity_relations (from_entity_id, relation_type);

CREATE INDEX IF NOT EXISTS osint_entity_relations_to_idx
  ON osint_entity_relations (to_entity_id, relation_type);

CREATE INDEX IF NOT EXISTS osint_entity_relations_open_idx
  ON osint_entity_relations (from_entity_id, to_entity_id)
  WHERE valid_to IS NULL;

-- === Шаг 12. Temporal attributes (§18) - одно открытое значение на атрибут ===
CREATE TABLE IF NOT EXISTS osint_entity_attributes (
  id uuid PRIMARY KEY,
  entity_id uuid NOT NULL REFERENCES osint_entities (id) ON DELETE CASCADE,
  attribute text NOT NULL
    CONSTRAINT osint_entity_attributes_kind_check
    CHECK (attribute IN ('name','phone','website','address','email','city','region','country','category','description','social_links','coordinates','working_hours')),
  value jsonb NOT NULL DEFAULT 'null',
  confidence numeric(4,3) NOT NULL DEFAULT 1
    CONSTRAINT osint_entity_attributes_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  source_observation_id uuid REFERENCES osint_observations (id) ON DELETE SET NULL,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS osint_entity_attributes_open_idx
  ON osint_entity_attributes (entity_id, attribute)
  WHERE valid_to IS NULL;

CREATE INDEX IF NOT EXISTS osint_entity_attributes_entity_idx
  ON osint_entity_attributes (entity_id, attribute, valid_from DESC);
