-- 074: OSINT «Паспорт исследования» — конфигурация запуска Stage 4 (§26):
-- паспорт бизнеса, append-only ревизии и запуски с snapshot'ом плана.
-- Append-only к уже применённым миграциям (checksum-guard в migrate.ts) и
-- без точек запятой внутри комментариев — runner режет файл по ним.
-- Не редактировать 073_osint_intelligence_v1.sql.

-- === Passport: одна конфигурация исследования на бизнес ==================
CREATE TABLE IF NOT EXISTS osint_research_passports (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 1
    CONSTRAINT osint_research_passports_revision_check CHECK (revision >= 1),
  format_version integer NOT NULL DEFAULT 1
    CONSTRAINT osint_research_passports_format_check CHECK (format_version >= 1),
  content jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_research_passports_business_key UNIQUE (business_id)
);

-- История ревизий паспорта — только добавление строк.
CREATE TABLE IF NOT EXISTS osint_research_passport_revisions (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  passport_id uuid NOT NULL REFERENCES osint_research_passports (id) ON DELETE CASCADE,
  revision integer NOT NULL
    CONSTRAINT osint_research_passport_revisions_revision_check CHECK (revision >= 1),
  format_version integer NOT NULL,
  content jsonb NOT NULL,
  created_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_research_passport_revisions_key UNIQUE (passport_id, revision)
);

CREATE INDEX IF NOT EXISTS osint_research_passport_revisions_recent_idx
  ON osint_research_passport_revisions (passport_id, created_at DESC);

-- Запуск исследования: паспорт и план фиксируются snapshot'ом на момент
-- запуска — результат читается так же, как его планировали.
CREATE TABLE IF NOT EXISTS osint_research_launches (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  passport_id uuid REFERENCES osint_research_passports (id) ON DELETE SET NULL,
  passport_revision integer,
  passport_snapshot jsonb NOT NULL,
  plan jsonb NOT NULL,
  run_id uuid REFERENCES osint_discovery_runs (id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued'
    CONSTRAINT osint_research_launches_status_check
    CHECK (status IN ('queued','running','completed','failed')),
  error text,
  created_by uuid REFERENCES "user" (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Один активный запуск на бизнес — параллельные запуски запрещены
-- на уровне схемы, а не только в приложении.
CREATE UNIQUE INDEX IF NOT EXISTS osint_research_launches_active_idx
  ON osint_research_launches (business_id)
  WHERE status IN ('queued','running');

CREATE INDEX IF NOT EXISTS osint_research_launches_business_idx
  ON osint_research_launches (business_id, created_at DESC);

-- D5: очередь enrichment уважает available_at — быстрые падения уходят в
-- backoff и не крутятся в tight-loop между тиками воркера.
ALTER TABLE osint_enrichment_runs
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now();

-- D12: выборка queued discovery run'ов — индекс под предикат status='queued'.
CREATE INDEX IF NOT EXISTS osint_discovery_runs_queued_created_idx
  ON osint_discovery_runs (created_at)
  WHERE status = 'queued';

-- Фразы паспорта — детерминированные запросы, добавляемые в начало списка
-- задачи run'а (executeDiscoveryRun: extra-запросы, затем шаблоны, общий cap).
ALTER TABLE osint_discovery_runs
  ADD COLUMN IF NOT EXISTS extra_queries jsonb NOT NULL DEFAULT '[]';
