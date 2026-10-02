-- 072: OSINT crawl queue (Stage 3 full, §25).
-- Очередь URL одного discovery run — состояния, приоритет, дедуп, бюджеты.
-- append-only к уже применённым миграциям (checksum-guard в migrate.ts)
-- и без точек запятой внутри комментариев - runner режет файл по ним

CREATE TABLE IF NOT EXISTS osint_crawl_queue (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES osint_discovery_runs (id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  url text NOT NULL,
  normalized_url text NOT NULL,
  depth integer NOT NULL DEFAULT 0,
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','fetching','fetched','failed','skipped')),
  skip_reason text,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  http_status integer,
  from_url text,
  fetched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_crawl_queue_unique UNIQUE (run_id, normalized_url),
  CONSTRAINT osint_crawl_queue_depth_range CHECK (depth >= 0 AND depth <= 25),
  CONSTRAINT osint_crawl_queue_url_len CHECK (char_length(url) <= 2048),
  CONSTRAINT osint_crawl_queue_norm_len CHECK (char_length(normalized_url) <= 2048),
  CONSTRAINT osint_crawl_queue_from_len CHECK (from_url IS NULL OR char_length(from_url) <= 2048)
);

-- Выборка следующего к обработке: run, статус, приоритет, глубина.
CREATE INDEX IF NOT EXISTS osint_crawl_queue_run_status_idx
  ON osint_crawl_queue (run_id, status, priority DESC, depth, created_at);

-- Отчёт по run для тенанта.
CREATE INDEX IF NOT EXISTS osint_crawl_queue_business_idx
  ON osint_crawl_queue (business_id, created_at DESC);
