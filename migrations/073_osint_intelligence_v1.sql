-- 073: OSINT Stage 4 — intelligence layer (§26): facts, changes,
-- contradictions, enrichment runs. Append-only к уже применённым миграциям
-- (checksum-guard в migrate.ts) и без точек запятой внутри комментариев
-- runner режет файл по ним. Не редактировать 072_osint_crawl_v1.sql.

-- === Fact layer: отдельный слой от observation (§26.1) =====================
-- Observation «источник сообщил X», Fact «для бизнеса наблюдалось значение X».
-- Каждая строка обязана трассироваться до observation → source (FK NOT NULL):
-- fact без provenance невозможен на уровне схемы. raw_value никогда не
-- перезаписывается значением нормализации — value канонический, raw исходный.
CREATE TABLE IF NOT EXISTS osint_intelligence_facts (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  entity_id uuid,
  fact_type text NOT NULL
    CONSTRAINT osint_intel_facts_type_check CHECK (fact_type IN (
      'business_name','brand_name','legal_name',
      'phone','email',
      'address','city','region','country','postal_code',
      'website','domain',
      'telegram','vk','instagram','facebook','youtube','tiktok','other_social',
      'category','service','product','opening_hours',
      'registration_identifier','tax_identifier','license_identifier'
    )),
  -- Канонический ключ = нормализованное значение (факт на значение).
  fact_key text NOT NULL,
  -- Каноническое значение и ровно то, что сообщил источник (§26.5).
  value text NOT NULL,
  raw_value text NOT NULL,
  -- Происхождение (§26.4): цепочка fact → observation → source читается FK'ми.
  source_id uuid NOT NULL,
  observation_id uuid NOT NULL,
  -- Жизненный цикл (§26.8): ACTIVE — подтверждён последним enrichment,
  -- RETIRED — вытеснен новым значением того же источника (есть change event),
  -- STALE — исчез из источника без замены (может вернуться → REAPPEARED).
  status text NOT NULL DEFAULT 'ACTIVE'
    CONSTRAINT osint_intel_facts_status_check CHECK (status IN ('ACTIVE','STALE','RETIRED')),
  -- Детерминированный отпечаток строки — ключ идемпотентности (§26.9).
  fingerprint text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz NOT NULL DEFAULT now(),
  extracted_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_intel_facts_key_len CHECK (char_length(fact_key) BETWEEN 1 AND 300),
  CONSTRAINT osint_intel_facts_value_len CHECK (char_length(value) BETWEEN 1 AND 1000),
  CONSTRAINT osint_intel_facts_raw_len CHECK (char_length(raw_value) BETWEEN 1 AND 2000),
  CONSTRAINT osint_intel_facts_fp_len CHECK (char_length(fingerprint) BETWEEN 1 AND 128),
  CONSTRAINT osint_intel_facts_unique UNIQUE (business_id, fingerprint),
  CONSTRAINT osint_intel_facts_business_id_id_key UNIQUE (business_id, id),
  -- Таблицы entities/sources/observations глобальные (070 убрал business_id):
  -- тенантская изоляция — тот же тенантский скоуп, что и у Stage 3 (§7),
  -- а не составной FK. Цепочка fact → observation → source читается FK'ми.
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id),
  FOREIGN KEY (source_id) REFERENCES osint_sources (id),
  FOREIGN KEY (observation_id) REFERENCES osint_observations (id)
);

CREATE INDEX IF NOT EXISTS osint_intel_facts_type_idx
  ON osint_intelligence_facts (business_id, fact_type, status);

CREATE INDEX IF NOT EXISTS osint_intel_facts_source_idx
  ON osint_intelligence_facts (business_id, source_id);

CREATE INDEX IF NOT EXISTS osint_intel_facts_seen_idx
  ON osint_intelligence_facts (business_id, last_seen_at DESC);

-- === Change events (§26.9) ==================================================
-- Детектируются как переход stored-состояния → состояние после enrichment.
-- Одинаковый повторный enrichment даёт тот же отпечаток → UNIQUE гасит дубль.
CREATE TABLE IF NOT EXISTS osint_fact_changes (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  entity_id uuid,
  fact_type text NOT NULL
    CONSTRAINT osint_changes_type_check CHECK (fact_type IN (
      'business_name','brand_name','legal_name',
      'phone','email',
      'address','city','region','country','postal_code',
      'website','domain',
      'telegram','vk','instagram','facebook','youtube','tiktok','other_social',
      'category','service','product','opening_hours',
      'registration_identifier','tax_identifier','license_identifier'
    )),
  fact_key text NOT NULL,
  change_kind text NOT NULL
    CONSTRAINT osint_changes_kind_check
    CHECK (change_kind IN ('FIRST_SEEN','VALUE_CHANGED','VALUE_REAPPEARED','VALUE_DISAPPEARED','SOURCE_CHANGED')),
  old_value text,
  new_value text,
  source_id uuid,
  observation_id uuid,
  detected_at timestamptz NOT NULL DEFAULT now(),
  fingerprint text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_changes_key_len CHECK (char_length(fact_key) BETWEEN 1 AND 300),
  CONSTRAINT osint_changes_fp_len CHECK (char_length(fingerprint) BETWEEN 1 AND 128),
  CONSTRAINT osint_changes_unique UNIQUE (business_id, fingerprint),
  CONSTRAINT osint_changes_business_id_id_key UNIQUE (business_id, id),
  -- Глобальные целевые таблицы (070): изоляция через тенантский скоуп (§7).
  FOREIGN KEY (entity_id) REFERENCES osint_entities (id),
  FOREIGN KEY (source_id) REFERENCES osint_sources (id),
  FOREIGN KEY (observation_id) REFERENCES osint_observations (id)
);

CREATE INDEX IF NOT EXISTS osint_changes_business_idx
  ON osint_fact_changes (business_id, detected_at DESC);

CREATE INDEX IF NOT EXISTS osint_changes_type_idx
  ON osint_fact_changes (business_id, fact_type, detected_at DESC);

-- === Contradictions (§26.10) ================================================
-- Одна пересчитываемая запись на (business, fact_type): стороны хранятся как
-- jsonb-массив через jsonbArray() (top-level массив в pg иначе уходит в
-- литеральный массив и падает — §24.7). Победитель НЕ выбирается, статус
-- resolved не трогается пересчётом (заполняется только при будущем ручном
-- разрешении).
CREATE TABLE IF NOT EXISTS osint_intelligence_contradictions (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  fact_type text NOT NULL
    CONSTRAINT osint_contradictions_type_check CHECK (fact_type IN (
      'business_name','brand_name','legal_name',
      'phone','email',
      'address','city','region','country','postal_code',
      'website','domain',
      'telegram','vk','instagram','facebook','youtube','tiktok','other_social',
      'category','service','product','opening_hours',
      'registration_identifier','tax_identifier','license_identifier'
    )),
  -- [{value, sources:[{id,name,url}], observations:[id], firstSeen, lastSeen}]
  sides jsonb NOT NULL DEFAULT '[]',
  value_count integer NOT NULL DEFAULT 0,
  source_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'unresolved'
    CONSTRAINT osint_contradictions_status_check
    CHECK (status IN ('unresolved','resolved')),
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_contradictions_unique UNIQUE (business_id, fact_type),
  CONSTRAINT osint_contradictions_business_id_id_key UNIQUE (business_id, id),
  CONSTRAINT osint_contradictions_counts CHECK (value_count >= 0 AND source_count >= 0)
);

CREATE INDEX IF NOT EXISTS osint_contradictions_business_idx
  ON osint_intelligence_contradictions (business_id, detected_at DESC);

-- === Enrichment runs (§26.11) ===============================================
-- Очередь Stage 4: queued → running → completed/failed с ограниченным retry.
-- Частично активный запуск на бизнес: уникальный индекс по частичному
-- предикату запрещает два queued/running run'а на один бизнес — конкурентные
-- воркеры физически не могут выполнять enrichment одновременно.
CREATE TABLE IF NOT EXISTS osint_enrichment_runs (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  discovery_run_id uuid REFERENCES osint_discovery_runs (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT osint_enrichment_status_check
    CHECK (status IN ('queued','running','completed','failed')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  stats jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_enrichment_attempts CHECK (attempts >= 0 AND attempts < 10)
);

CREATE UNIQUE INDEX IF NOT EXISTS osint_enrichment_active_idx
  ON osint_enrichment_runs (business_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS osint_enrichment_queue_idx
  ON osint_enrichment_runs (status, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS osint_enrichment_business_idx
  ON osint_enrichment_runs (business_id, created_at DESC);
