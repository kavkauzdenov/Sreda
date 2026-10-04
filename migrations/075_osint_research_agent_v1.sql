-- 075_osint_research_agent_v1.sql
--
-- Автономный research agent (§Research Agent). Цель: пользователь сообщает,
-- какой бизнес исследовать, а агент сам решает как. Модель Research Passport
-- (074) описывала provider-centric план, здесь появляется исполнитель.
--
-- Принципы:
--   1. Append-only. Ни одна уже применённая миграция не меняется (checksum-guard
--      в src/server/db/migrate.ts). Никаких DROP TABLE по production-данным.
--   2. Глобальная память остаётся глобальной. osint_source_access — свойство
--      САЙТА, а не тенанта: блокировка 2ГИС касается всех. Никакого business_id
--      и никаких внешних ключей на business/user (инвариант из 070).
--   3. Тенант-скоуп остаётся на действиях и гипотезах: они отвечают на вопрос
--      «что мы знаем про ЭТОТ бизнес», поэтому без business_id им нельзя.
--   4. Идемпотентность на уровне БД, а не кода: dedupe_key + UNIQUE.
--   5. Никаких file:line и внешних ссылок в комментариях — запрещён semicolon
--      внутри строковых литералов, комментарии безопасны, но держим их краткими.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. Исследовательское действие — единица работы агента
-- ─────────────────────────────────────────────────────────────────────────────
-- Действие — это «одна операция, которую агент решил выполнить»: поисковый
-- запрос, обход страницы, повторная проверка гипотезы. Действия — аудируемый
-- след: по ним можно ответить, ПОЧЕМУ система искала то, что искала.
CREATE TABLE IF NOT EXISTS osint_research_actions (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES osint_discovery_runs (id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  parent_action_id uuid REFERENCES osint_research_actions (id) ON DELETE SET NULL,
  hypothesis_id uuid,
  -- Тип операции. search — поисковый запрос, fetch — загрузка известного URL,
  -- verify — перепроверка ранее заблокированного/непроверенного источника.
  kind text NOT NULL DEFAULT 'search'
    CONSTRAINT osint_research_actions_kind_check
    CHECK (kind IN ('search','fetch','verify')),
  -- Назначение операции. Это внутреннее рассуждение агента, не пользовательский
  -- выбор: цель сообщает, ЧТО мы хотим узнать, а не КАК.
  purpose text NOT NULL DEFAULT 'identity'
    CONSTRAINT osint_research_actions_purpose_check
    CHECK (purpose IN (
      'identity','contact','website','social','reviews','maps','legal','news',
      'products','services','prices','vacancies','locations','competitors',
      'mentions','reputation','changes','verification'
    )),
  query text NOT NULL DEFAULT '',
  target_url text,
  reason text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CONSTRAINT osint_research_actions_status_check
    CHECK (status IN ('pending','running','done','failed','skipped','exhausted')),
  -- Что действие дало: 1 действие = N новых фактов. Это база метрики
  -- «полезные факты на единицу бюджета» (§69), которой нет у краулера без цели.
  outcome text NOT NULL DEFAULT 'pending'
    CONSTRAINT osint_research_actions_outcome_check
    CHECK (outcome IN ('pending','productive','empty','duplicate','blocked','error')),
  results_count integer NOT NULL DEFAULT 0,
  new_sources integer NOT NULL DEFAULT 0,
  new_facts integer NOT NULL DEFAULT 0,
  new_entities integer NOT NULL DEFAULT 0,
  error text,
  dedupe_key text NOT NULL,
  executed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_research_actions_dedupe_key_len CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  CONSTRAINT osint_research_actions_query_len CHECK (char_length(query) <= 500),
  CONSTRAINT osint_research_actions_reason_len CHECK (char_length(reason) <= 500),
  CONSTRAINT osint_research_actions_target_len CHECK (target_url IS NULL OR char_length(target_url) <= 2048),
  -- Одно действие на конкретный запрос/URL в рамках конкретного исследования.
  -- Гарантирует, что перезапуск воркера не породит дубли.
  CONSTRAINT osint_research_actions_dedupe UNIQUE (run_id, dedupe_key),
  CONSTRAINT osint_research_actions_priority_range CHECK (priority >= -1000 AND priority <= 1000),
  CONSTRAINT osint_research_actions_counts CHECK (
    results_count >= 0 AND new_sources >= 0 AND new_facts >= 0 AND new_entities >= 0
  )
);

-- Очередь действий: берём pending по убыванию приоритета. Это и есть
-- «next best action» — выбор следующей операции становится порядком строк.
CREATE INDEX IF NOT EXISTS osint_research_actions_queue_idx
  ON osint_research_actions (run_id, status, priority DESC, created_at ASC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS osint_research_actions_business_idx
  ON osint_research_actions (business_id, created_at DESC);

CREATE INDEX IF NOT EXISTS osint_research_actions_hypothesis_idx
  ON osint_research_actions (hypothesis_id)
  WHERE hypothesis_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Исследовательская гипотеза
-- ─────────────────────────────────────────────────────────────────────────────
-- Гипотеза — проверяемое утверждение о мире: «у бизнеса есть сайт»,
-- «телефон из источника A подтверждается источником B». Агент порождает их
-- из найденных фактов, а не из пользовательского чек-листа. Пользователь
-- может уточнить, но не обязан.
CREATE TABLE IF NOT EXISTS osint_research_hypotheses (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES osint_discovery_runs (id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES business (id) ON DELETE CASCADE,
  parent_hypothesis_id uuid REFERENCES osint_research_hypotheses (id) ON DELETE SET NULL,
  -- Тип проверяемого утверждения. identity — базовая связка, остальные
  -- выводятся из найденного: домен порождает website, телефон — identity.
  type text NOT NULL DEFAULT 'identity'
    CONSTRAINT osint_research_hypotheses_type_check
    CHECK (type IN (
      'identity','contact','website','social','reviews','maps','legal','news',
      'products','services','prices','vacancies','locations','competitors',
      'mentions','reputation','changes','corroboration','contradiction'
    )),
  statement text NOT NULL DEFAULT '',
  -- Человекочитаемое «почему мы это проверяем». Обязательно: гипотеза без
  -- объяснения — чёрный ящик, а объяснимость — часть продукта (§40).
  reason text NOT NULL DEFAULT '',
  priority integer NOT NULL DEFAULT 0,
  confidence numeric(4,3) NOT NULL DEFAULT 0
    CONSTRAINT osint_research_hypotheses_confidence_check
    CHECK (confidence >= 0 AND confidence <= 1),
  status text NOT NULL DEFAULT 'open'
    CONSTRAINT osint_research_hypotheses_status_check
    CHECK (status IN ('open','testing','confirmed','refuted','exhausted','skipped')),
  source_entity_id uuid REFERENCES osint_entities (id) ON DELETE SET NULL,
  -- Объект проверки: домен, телефон, адрес — то, что породило гипотезу.
  subject_key text NOT NULL DEFAULT '',
  subject_value text NOT NULL DEFAULT '',
  actions_used integer NOT NULL DEFAULT 0,
  dedupe_key text NOT NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_research_hypotheses_dedupe_key_len CHECK (char_length(dedupe_key) BETWEEN 1 AND 300),
  CONSTRAINT osint_research_hypotheses_statement_len CHECK (char_length(statement) <= 500),
  CONSTRAINT osint_research_hypotheses_reason_len CHECK (char_length(reason) <= 500),
  CONSTRAINT osint_research_hypotheses_subject_len CHECK (char_length(subject_key) <= 100),
  CONSTRAINT osint_research_hypotheses_subject_value_len CHECK (char_length(subject_value) <= 500),
  CONSTRAINT osint_research_hypotheses_priority_range CHECK (priority >= -1000 AND priority <= 1000),
  CONSTRAINT osint_research_hypotheses_actions_used CHECK (actions_used >= 0),
  CONSTRAINT osint_research_hypotheses_dedupe UNIQUE (run_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS osint_research_hypotheses_queue_idx
  ON osint_research_hypotheses (run_id, status, priority DESC, created_at ASC)
  WHERE status IN ('open','testing');

CREATE INDEX IF NOT EXISTS osint_research_hypotheses_business_idx
  ON osint_research_hypotheses (business_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Доступность источника
-- ─────────────────────────────────────────────────────────────────────────────
-- Блокировка источника — это НЕ ошибка исследования, а состояние источника.
-- Раньше 403/429/captcha/robots/timeout схлопывались в http_error, и агент не
-- мог отличить «смени маршрут» от «повтори позже». Здесь явная таксономия.
--
-- ГЛОБАЛЬНАЯ таблица: блокировка сайта касается всех тенантов. Это же
-- означает сильный дедуп — второй тенант не тратит бюджет, зная результат.
CREATE TABLE IF NOT EXISTS osint_source_access (
  source_id uuid PRIMARY KEY REFERENCES osint_sources (id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'accessible'
    CONSTRAINT osint_source_access_status_check
    CHECK (status IN (
      'accessible','blocked','robots_disallowed','captcha','rate_limited',
      'timeout','not_found','requires_auth','unsupported_content','transport_error'
    )),
  http_status integer,
  -- Человекочитаемое пояснение для пользователя. Технические коды остаются
  -- в audit/логах, здесь — только смысл для человека (§51).
  detail text NOT NULL DEFAULT '',
  -- Сколько раз подряд наблюдался один и тот же исход. Растёт монотонно и
  -- обнуляется при успехе — это и есть детектор насыщения по ветке.
  consecutive_count integer NOT NULL DEFAULT 0,
  last_status_code text,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  first_blocked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT osint_source_access_detail_len CHECK (char_length(detail) <= 500),
  CONSTRAINT osint_source_access_status_code_len CHECK (
    last_status_code IS NULL OR char_length(last_status_code) <= 100
  ),
  CONSTRAINT osint_source_access_consecutive CHECK (consecutive_count >= 0)
);

CREATE INDEX IF NOT EXISTS osint_source_access_status_idx
  ON osint_source_access (status, last_checked_at DESC);

CREATE INDEX IF NOT EXISTS osint_source_access_blocked_idx
  ON osint_source_access (source_id)
  WHERE status <> 'accessible';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Обогащение run: фаза, план, покрытие
-- ─────────────────────────────────────────────────────────────────────────────
-- Статус run'а (queued/running/completed/partial/failed) НЕ расширяем: он
-- зафиксирован контрактом и asserted в тестах. Более тонкий жизненный цикл
-- (§46) живёт в отдельной колонке phase.
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS phase text NOT NULL DEFAULT 'idle'
  CONSTRAINT osint_discovery_runs_phase_check CHECK (
    phase IN ('idle','planning','searching','discovering','extracting','resolving','enriching','evaluating','saturating')
  );

-- План исследования: какие ветки агент решил развивать и почему.
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS plan jsonb NOT NULL DEFAULT '{}';

-- Отчёт о покрытии и насыщении: что исследовано, что осталось неизвестным.
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS coverage jsonb NOT NULL DEFAULT '{}';

-- Знание run'а: подтверждённые факты и найденные идентичности, которые
-- кормят бэкендинг планировщика (fact → новая гипотеза).
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS knowledge jsonb NOT NULL DEFAULT '{}';

-- Счётчики агента для метрики «полезные факты на действие» (§69).
ALTER TABLE osint_discovery_runs ADD COLUMN IF NOT EXISTS agent_stats jsonb NOT NULL DEFAULT '{}';

-- Фаза видна в админском/пользовательском чтении: активная фаза ищется по всем
-- незавершённым run'ам независимо от статуса.
CREATE INDEX IF NOT EXISTS osint_discovery_runs_phase_idx
  ON osint_discovery_runs (phase, created_at DESC)
  WHERE phase <> 'idle';
