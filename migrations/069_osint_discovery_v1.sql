-- 069: OSINT discovery core (Этап 2). Additive only, no existing data dropped.
-- Внешние компании живут в osint_entities и НИКОГДА не пишутся в таблицу business.
-- Порядок создания: runs → entities → sources → candidates → связи → facts/findings.

CREATE TABLE IF NOT EXISTS osint_discovery_runs (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed')),
  profile jsonb NOT NULL DEFAULT '{}',
  budget jsonb NOT NULL DEFAULT '{}',
  providers jsonb NOT NULL DEFAULT '[]',
  queries_count integer NOT NULL DEFAULT 0,
  results_count integer NOT NULL DEFAULT 0,
  candidates_count integer NOT NULL DEFAULT 0,
  accepted_count integer NOT NULL DEFAULT 0,
  review_count integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  duplicates_count integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS osint_discovery_runs_business_idx
  ON osint_discovery_runs (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS osint_discovery_runs_business_status_idx
  ON osint_discovery_runs (business_id, status);

CREATE TABLE IF NOT EXISTS osint_entities (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'business'
    CHECK (kind IN ('business','location','organization')),
  display_name text NOT NULL,
  normalized_name text NOT NULL,
  identity_key text,
  aliases jsonb NOT NULL DEFAULT '[]',
  category text,
  city text,
  region text,
  country text,
  address text,
  phone text,
  email text,
  website text,
  social_links jsonb NOT NULL DEFAULT '{}',
  fingerprint jsonb NOT NULL DEFAULT '{}',
  latitude double precision,
  longitude double precision,
  source_kind text NOT NULL DEFAULT 'discovery'
    CHECK (source_kind IN ('discovery','manual')),
  merged_into_id uuid REFERENCES osint_entities (id) ON DELETE SET NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_entities_name_len CHECK (char_length(display_name) BETWEEN 1 AND 300),
  CONSTRAINT osint_entities_business_id_id_key UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS osint_entities_identity_idx
  ON osint_entities (business_id, identity_key)
  WHERE identity_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS osint_entities_name_idx
  ON osint_entities (business_id, normalized_name);

CREATE TABLE IF NOT EXISTS osint_sources (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  entity_id uuid,
  type text NOT NULL DEFAULT 'website'
    CHECK (type IN ('website','search','maps','review_platform','social_network','directory','news','public_registry','other')),
  provider text NOT NULL DEFAULT 'website',
  url text NOT NULL,
  normalized_url text NOT NULL,
  name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','paused','error','disabled')),
  trust_level text NOT NULL DEFAULT 'third_party'
    CHECK (trust_level IN ('official','public_directory','review_platform','search_result','third_party')),
  origin text NOT NULL DEFAULT 'manual'
    CHECK (origin IN ('discovery','manual')),
  auto_accepted boolean NOT NULL DEFAULT false,
  discovery_run_id uuid REFERENCES osint_discovery_runs (id) ON DELETE SET NULL,
  last_collected_at timestamptz,
  last_success_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  next_collection_at timestamptz,
  collection_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_sources_url_len CHECK (char_length(url) <= 2048),
  CONSTRAINT osint_sources_unique UNIQUE (business_id, normalized_url),
  CONSTRAINT osint_sources_business_id_id_key UNIQUE (business_id, id),
  FOREIGN KEY (business_id, entity_id) REFERENCES osint_entities (business_id, id)
);

CREATE INDEX IF NOT EXISTS osint_sources_business_status_idx
  ON osint_sources (business_id, status);

CREATE INDEX IF NOT EXISTS osint_sources_next_collection_idx
  ON osint_sources (next_collection_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS osint_source_candidates (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  discovery_run_id uuid REFERENCES osint_discovery_runs (id) ON DELETE SET NULL,
  entity_id uuid,
  source_id uuid,
  url text NOT NULL,
  normalized_url text NOT NULL,
  type text NOT NULL DEFAULT 'website'
    CHECK (type IN ('website','search','maps','review_platform','social_network','directory','news','public_registry','other')),
  provider text NOT NULL DEFAULT 'search',
  title text,
  snippet text,
  discovery_method text NOT NULL DEFAULT 'search'
    CHECK (discovery_method IN ('search','website_link','structured_data','social','map','manual')),
  query text,
  search_position integer,
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_candidates_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  match_reasons jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate','accepted','rejected')),
  decided_by_user_id uuid REFERENCES "user" (id) ON DELETE SET NULL,
  decided_at timestamptz,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_candidates_url_len CHECK (char_length(url) <= 2048),
  CONSTRAINT osint_candidates_unique UNIQUE (business_id, normalized_url),
  FOREIGN KEY (business_id, entity_id) REFERENCES osint_entities (business_id, id),
  FOREIGN KEY (business_id, source_id) REFERENCES osint_sources (business_id, id)
);

CREATE INDEX IF NOT EXISTS osint_candidates_business_status_idx
  ON osint_source_candidates (business_id, status, discovered_at DESC);

CREATE INDEX IF NOT EXISTS osint_candidates_run_idx
  ON osint_source_candidates (discovery_run_id)
  WHERE discovery_run_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS osint_entity_sources (
  business_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  source_id uuid NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, entity_id, source_id),
  FOREIGN KEY (business_id, entity_id) REFERENCES osint_entities (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, source_id) REFERENCES osint_sources (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS osint_observations (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  entity_id uuid,
  external_id text,
  url text,
  title text,
  content text NOT NULL DEFAULT '',
  author_name text,
  published_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  content_hash text NOT NULL,
  language text,
  kind text NOT NULL DEFAULT 'page'
    CHECK (kind IN ('page','review','search_result','post','listing')),
  rating numeric(4,2),
  rating_max numeric(4,2),
  latitude double precision,
  longitude double precision,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_observations_hash_len CHECK (char_length(content_hash) BETWEEN 1 AND 128),
  CONSTRAINT osint_observations_business_id_id_key UNIQUE (business_id, id),
  FOREIGN KEY (business_id, source_id) REFERENCES osint_sources (business_id, id),
  FOREIGN KEY (business_id, entity_id) REFERENCES osint_entities (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS osint_observations_source_external_idx
  ON osint_observations (source_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS osint_observations_source_hash_idx
  ON osint_observations (source_id, content_hash);

CREATE INDEX IF NOT EXISTS osint_observations_business_idx
  ON osint_observations (business_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS osint_facts (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  subject text NOT NULL,
  predicate text NOT NULL,
  object text,
  value jsonb,
  value_kind text,
  source_observation_id uuid NOT NULL,
  confidence numeric(4,3) NOT NULL DEFAULT 1
    CONSTRAINT osint_facts_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_facts_subject_len CHECK (char_length(subject) BETWEEN 1 AND 200),
  CONSTRAINT osint_facts_predicate_len CHECK (char_length(predicate) BETWEEN 1 AND 100),
  CONSTRAINT osint_facts_unique UNIQUE (business_id, subject, predicate, source_observation_id),
  FOREIGN KEY (business_id, source_observation_id) REFERENCES osint_observations (business_id, id)
);

CREATE INDEX IF NOT EXISTS osint_facts_lookup_idx
  ON osint_facts (business_id, subject, predicate);

CREATE TABLE IF NOT EXISTS osint_competitor_candidates (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  entity_id uuid,
  candidate_business_id uuid REFERENCES business (id) ON DELETE CASCADE,
  name text NOT NULL,
  category text,
  city text,
  address text,
  website text,
  latitude double precision,
  longitude double precision,
  match_score numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_competitor_score_range CHECK (match_score >= 0 AND match_score <= 1),
  match_reasons jsonb NOT NULL DEFAULT '[]',
  evidence jsonb NOT NULL DEFAULT '[]',
  sources jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','confirmed','rejected','watching')),
  decided_by_user_id uuid REFERENCES "user" (id) ON DELETE SET NULL,
  decided_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_competitor_name_len CHECK (char_length(name) BETWEEN 1 AND 300),
  CONSTRAINT osint_competitor_business_id_id_key UNIQUE (business_id, id),
  FOREIGN KEY (business_id, entity_id) REFERENCES osint_entities (business_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS osint_competitor_entity_idx
  ON osint_competitor_candidates (business_id, entity_id)
  WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS osint_competitor_business_status_idx
  ON osint_competitor_candidates (business_id, status);

CREATE TABLE IF NOT EXISTS osint_findings (
  id uuid PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  type text NOT NULL
    CHECK (type IN ('REPUTATION','COMPETITOR','PRICING','SERVICE','ACTIVITY','CUSTOMER_COMPLAINT','CUSTOMER_PRAISE','MARKET','CONTENT','WEBSITE','CONTACT','LOCATION','OPERATIONAL')),
  severity text NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('critical','high','medium','low')),
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_findings_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
  period_from timestamptz,
  period_to timestamptz,
  computed jsonb NOT NULL DEFAULT '{}',
  explanation text NOT NULL DEFAULT '',
  dedupe_key text NOT NULL,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','acknowledged','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_findings_title_len CHECK (char_length(title) BETWEEN 1 AND 400),
  CONSTRAINT osint_findings_unique UNIQUE (business_id, dedupe_key),
  CONSTRAINT osint_findings_business_id_id_key UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS osint_findings_business_idx
  ON osint_findings (business_id, severity, status);

CREATE TABLE IF NOT EXISTS osint_finding_evidence (
  business_id uuid NOT NULL,
  finding_id uuid NOT NULL,
  evidence_kind text NOT NULL
    CHECK (evidence_kind IN ('observation','fact','review_cluster','competitor')),
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, finding_id, evidence_kind, target_id),
  FOREIGN KEY (business_id, finding_id) REFERENCES osint_findings (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS osint_finding_evidence_target_idx
  ON osint_finding_evidence (business_id, evidence_kind, target_id);
