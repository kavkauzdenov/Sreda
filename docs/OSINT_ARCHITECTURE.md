# OSINT-разведчик бизнеса — архитектура (Этап 1: аудит)

**Статус:** Этап 1 завершён (документ без изменений кода). Этапы 2 и 3 ниже
(§19, §20) описывают уже слитый в `main` код. Ремонтный пасс аудита — §22,
фундамент Этапа 3 — §21.
**Основано на:** `main` @ `89403a3` (Intelligence Day 1 уже в `main`).
**Правило документа:** все ссылки на файлы проверены в репозитории на дату аудита.

> **Расхождение нумерации этапов.** В §6 миграция этапа 1 названа
> `069_osint_core.sql`; фактическое имя — `069_osint_discovery_v1.sql`
> (этап 1) и `070_osint_knowledge_graph_v1.sql` (этап 2). §16 говорит
> «этапы 2–14» — это нумерация roadmap-этапов из §16, а не номера
> «Stage 1/Stage 2» из задачи. Номера миграций (`069`, `070`, `071`)
> — единственный надёжный ориентир.


---

## 0. Рамка задачи

OSINT-разведчик — **слой над** существующим БизнеСоты, а не отдельный продукт.

```
                    БИЗНЕС
                       │
          ┌────────────┴────────────┐
       INTERNAL                  EXTERNAL
  CRM/Leads/Orders/Booking   OSINT: websites, reviews,
  Posts/Customers/Inbox      competitors, social, search
          └────────────┬────────────┘
                       │
                  INTELLIGENCE  →  FACTS → FINDINGS → SIGNALS
                       │
                 RECOMMENDATIONS
```

Четыре вопроса, на которые отвечает система (каждый ответ — с evidence):

1. Что происходит?
2. Где это происходит?
3. Почему мы так считаем?
4. Что с этим можно сделать?

**Прогнозирование в MVP не входит.** Только объяснение текущего состояния по открытым данным.

### Юридические границы (жёсткие)

Разрешено: публичные сайты, открытые API/публичные endpoint'ы, публичные карточки и отзывы, публичные поисковые результаты, публичные каталоги, официальные API площадок.

Запрещено: обход авторизации и CAPTCHA, обход paywall и технических ограничений, доступ к закрытым профилям, приватные персональные данные, деанонимизация, поиск утечек, украденные базы, скрытый трекинг, массовый спам, автозапись аккаунтов, скрейпинг в обход запретов площадки. Если источник запрещает автоматизацию — используем официальный API/разрешённый endpoint либо оставляем источник не подключённым.

---

## 1. Что такое Intelligence сегодня (существующая архитектура)

Intelligence Day 1 — **«Business Brain»**: аналитика только по **внутренним** данным бизнеса. Внешних (OSINT) данных нет вообще.

### Pipeline

```
internal-data.ts (snapshot из order/lead/client/business)
   → signals.ts      (детерминированные правила + evidence[])
   → insights.ts     (signal → insight, confidence из sampleSize)
   → recommendations.ts (insight → recommendation, actionType)
   → status.ts       (aggregateBusinessStatus, summaryText)
   → IntelligenceOverview DTO
```

| Слой | Файл | Примечание |
|---|---|---|
| Оркестратор | `src/server/intelligence/business-brain.ts` | `BusinessBrainService.getOverview(userId, publicId, {demo})` |
| Снимок данных | `src/server/intelligence/internal-data.ts` | `loadInternalSnapshot` — 8 параллельных Kysely-запросов |
| Сигналы | `src/server/intelligence/signals.ts` | `overdue_order`, `overdue_lead`, `sales_drop`, `inactive_customer`, `revenue_change` |
| Инсайты | `src/server/intelligence/insights.ts` | confidence: sample≥20 high, ≥5 medium, иначе low |
| Рекомендации | `src/server/intelligence/recommendations.ts` | `manual_required` / `available` / `preview`, ссылки на `/orders`, `/leads`, `/clients` |
| Статус | `src/server/intelligence/status.ts` | `critical` / `attention_required` / `stable` |
| Метрики | `src/server/intelligence/metrics.ts` | до 6 метрик |
| Демо | `src/server/intelligence/demo-overview.ts` | только `INTELLIGENCE_DEMO=1` + non-production |
| Аудит | `src/server/intelligence/audit.ts` | `logIntelligenceEvent()` → `intelligence_audit_log` |
| Типы таблиц | `src/server/intelligence/schema.ts` | `IntelligenceTables` |
| DTO-типы | `src/lib/intelligence-types.ts` | `IntelligenceOverview`, `BusinessSignal`, `BusinessInsight`, `BusinessRecommendation` |

### API и безопасность

- `GET /api/v1/businesses/:publicId/intelligence/overview` → `src/app/api/v1/businesses/[id]/intelligence/overview/route.ts` → `src/server/http/intelligence-handler.ts`.
- Route: `export const dynamic = "force-dynamic"`, прокидывает `(await params).id` (это **public_id**).
- Auth: `createApplication(runtime).requireUser(headers)` (better-auth session, `requireUuid`-проверки, rate limit `limit(db, secret, "api:"+userId, 180, 60)`).
- Тенант: `requireBusiness(db, userId, publicId, "analytics.view")` → 404 для чужого/архивного бизнеса, 403 для недостаточных прав.
- Ответ: `json()` (`Cache-Control: no-store`, `Vary: Cookie`, `x-request-id`), ошибки — `AppError` через `respond()`.
- Клиентский сервис: `src/services/intelligence.service.ts` → `apiRequest()` (`src/lib/apiClient.ts`).

### БД и аудит

- Единственная таблица: **`intelligence_audit_log`** (`migrations/068_intelligence_audit.sql`):
  `id, business_id, user_id, operation, source (default 'business_brain'), reason, result, metadata jsonb, created_at`.
- Индекс: `(business_id, created_at DESC)`.
- `IntelligenceTables` **уже импортирован** в `src/server/db/schema.ts` (`import type { IntelligenceTables }`) — новые таблицы этого модуля подхватятся без правок в корне схемы.
- Логгер жёстко пишет `source: "business_brain"` — для OSINT нужна маленькая правка (см. §9).

### UI

- `/intelligence` в `SECONDARY_NAV_ITEMS` (`src/config/navigation.ts`, иконка `Brain`).
- `src/app/(app)/intelligence/page.tsx` → `src/components/intelligence/IntelligenceCommandCenter.tsx` (293 строк, `"use client"`, `useCurrentBusiness()`, `LoadingPanel`, карточки severity, `<details>` для evidence, drawer превью рекомендации).
- Стили: существующие `intelligence-card`, `button--ghost/outline/primary`, токены проекта (без визуального языка).

### Документация и тесты

- `docs/intelligence-day1.md` — источник истины Day 1; явно говорит: «No OSINT, no external APIs» и «Day 2+: external context».
- `tests/intelligence-day1.test.mjs` — 5 тестов: insufficient data, **tenant isolation**, overdue_order insight, sales_drop evidence, audit log write.

---

## 2. Что уже существует и может быть переиспользовано

| Нужно для OSINT | Что есть | Где |
|---|---|---|
| Тенант-изоляция | `requireBusiness(db, userId, publicId, permission)` | `src/server/access/permissions.ts` |
| HTTP-конвенции | `AppError`, `respond`, `json`, `readJson`, `requireOrigin` | `src/server/http/errors.ts` |
| Валидация полей | `requireUuid` + ручная валидация в сервисах | `src/server/http/validation.ts` |
| Rate limit | `limit(db, secret, subject, max, seconds)` → `request_limit` (HMAC-ключ) | `src/server/http/limits.ts` |
| Аудит (tenant) | `intelligence_audit_log` + `logIntelligenceEvent()` | `src/server/intelligence/audit.ts` |
| Аудит (mutations) | `audit(tx, businessId, actor, action, target, metadata)` | `src/server/audit/service.ts` |
| AI вызов | `completeAiDraft(system, input, {token, model, transport})` | `src/server/ai/posts.ts` |
| AI контекст бизнеса | `buildAiContext(db, businessId)` | `src/server/ai/context.ts` |
| AI учёт стоимости | `recordAiUsage(db, {businessId, feature, model, tokens…})` | `src/server/ai/usage.ts` |
| AI-защита от секретов | `SECRET_RE` reject | `src/server/ai/assist.ts` |
| Структурные логи | `log(level, code, fields)` с фильтром секретных ключей | `src/server/observability/log.ts` |
| Периоды/сравнение | `resolvePeriod`, `compareMetric`, `localYmd` | `src/server/analytics/periods.ts` |
| Структурные outbox-джобы | claim/lease: `delivery_state`, `claimed_at`, `available_at`, `attempts`, `expireClaims` | `src/server/outbox/claim.ts` |
| Паттерн «сcan + claim + idempotent update» | `processSetupDrafts()` — transaction, `select … forUpdate`, статусный guard, `notify()` | `src/server/solutions/setup-draft-worker.ts` |
| Дедуп через `event_key` | `notify()` → `onConflict(business_id, event_key).doNothing()` | `src/server/notifications/service.ts` |
| Тенант-safe FK | составные FK `(business_id, entity_id)` | `migrations/063_clients_v2.sql` (`client_tag_link`) |
| Composite unique для идемпотентности | `entity_reminder_dedupe` | `migrations/038_calendar_events.sql` |
| Outbound fetch без редиректов | `fetch(url, { cache: "no-store", redirect: "error" })` | `src/server/meta/api.ts:100` |
| Рантайм-конфиг | `runtimeConfig()` — `DATABASE_URL`, `APP_URL`, `AI_API_TOKEN`, `AI_MODEL` | `src/server/identity/config.ts` |
| Health-gate перечень heartbeat'ов | hardcoded `names[]` | `src/app/api/health/route.ts` |
| UI-конвенции | `useCurrentBusiness`, `apiRequest`, `LoadingPanel`, панели/кнопки/тест-ы | `src/services/*`, `src/components/*` |
| Тестовая инфраструктура | PGlite + `migrate()` + `node:test` | `tests/*.test.mjs` |

---

## 3. Чего **нет** (пробелы, которые надо закрыть)

> **Снимок Этапа 1** (на `89403a3`), не переписывается задним числом.
> Закрыто с тех пор: таблицы `osint_*` (069/070), SSRF-хелпер
> `osint/safe-fetch.ts`, `zod` в `dependencies`, `osint_competitor_candidates`,
> право `intelligence.manage`. Остаются: HTML-парсер, notification-типы OSINT,
> метрики-инфраструктура, кэш, `docs/WORKERS.md`.

| Пробел | Факт |
|---|---|
| Внешние данные | grep `osint\|competitor\|review_platform\|2gis\|otzovik\|flamp` по `src/`, `migrations/`, `tests/` — совпадений нет (кроме упоминания в `docs/intelligence-day1.md`) |
| Таблицы источников/наблюдений/фактов/находок | отсутствуют полностью |
| SSRF-защита | **нет** ни одного хелпера. Есть только `redirect: "error"` (`meta/api.ts`) и валидация host'ов для `APP_URL` (`identity/config.ts`). Нет DNS-резолва, нет проверки приватных IP, нет `169.254.169.254`-guard'а |
| HTML-парсер | **не установлен** ни один: `cheerio`, `htmlparser2`, `parse5`, `node-html-parser`, `linkedom` — отсутствуют; в коде парсинга HTML нет вообще |
| JSON/structured AI-выход | `completeAiDraft` возвращает **только свободный текст** (`AiDraftResult = {text, status}`), нет JSON mode, нет схем-валидации ответа |
| Библиотека схем валидации | `zod`/`ajv` присутствуют в `node_modules` **только транзитивно** (не в `package.json`) → напрямую использовать нельзя без декларации; проект валидирует вручную |
| Общая таблица джоб | нет: есть только domain-специфичные (`telegram_outbox`, `entity_reminder`, `solution_setup_draft`) |
| Конкуренты/отзывы/активность | нет ни таблиц, ни сервисов, ни UI |
| Permissions для Intelligence | право ровно одно: `analytics.view`; отдельного `intelligence.*` нет |
| Notification-типы OSINT | нет; `notification.type` без CHECK, но `notification_preference_type_check` жёстко перечисляет типы (последний раз — `migrations/060_solution_lifecycle_notifications.sql`) |
| Метрики-инфраструктура | нет Prometheus/счётчиков — только структурные логи и DB |
| Кэш | нет Redis/HTTP-кэша |
| Документация WORKERS | `docs/WORKERS.md` устарел (пишет, что `queueNotification` делает telegram-worker; фактически это `background-worker`) |

---

## 4. Базовые константы аудита

| Проверка | Результат на `89403a3` |
|---|---|
| `npm run typecheck` | чисто |
| `npm run lint` | 0 ошибок |
| `npm test` | 553 tests / 542 pass / **0 fail** / 11 skipped |
| Следующий номер миграции | **069** (068 — `intelligence_audit_log`) |
| Следующий шаг после 069 | `070_*` |

---

## 5. Предлагаемая архитектура

**Главное правило:** расширяем `src/server/intelligence/`, НЕ создаём параллельный топ-уровень `src/server/osint/`.

Итоговая структура (адаптирована под реальные конвенции: домен = папка `src/server/intelligence`, схемы = `schema.ts` внутри домена, HTTP = `src/server/http/*-handler.ts`, UI = `src/components/*`):

```
src/server/intelligence/
├── schema.ts                 # (расширить) все IntelligenceTables, включая osint_*
├── business-brain.ts          # (расширить) overview + внешние блоки OSINT
├── audit.ts                   # (расширить) source как параметр
│
├── osint/                     # новая подсистема внутри того же домена
│   ├── profile.ts             # OSINT-профиль бизнеса (чтение/seed/обновление)
│   ├── sources.ts             # CRUD источников, статусы, планирование
│   ├── collection-service.ts  # оркестрация: claim job → provider → normalize → store
│   ├── observations.ts        # запись сырых наблюдений + дедупликация
│   ├── facts.ts               # извлечение фактов + provenance
│   ├── entity-resolution.ts   # кандидаты сопоставления, без авто-мерджа
│   ├── review-analysis.ts     # sentiment/topics/complaints/positive (AI)
│   ├── review-clustering.ts   # кластеры + ссылки на исходные отзывы
│   ├── competitors.ts         # competitor_candidate + разбор различий
│   ├── activity.ts            # изменения before/after по наблюдениям
│   ├── findings.ts            # findings + evidence graph + guard «нет evidence → reject»
│   ├── recommendations.ts     # (новый) recommendation поверх findings
│   ├── metrics.ts             # (расширить) OSINT-метрики из БД
│   ├── job-runner.ts          # claim/execute/retry осознанных job'ов
│   └── providers/
│       ├── types.ts           # Provider контракт
│       ├── website.ts         # WebsiteProvider (первый)
│       ├── search.ts          # SearchProvider (разрешённый endpoint)
│       ├── reviews.ts         # ReviewProvider (абстракция + первый адаптер)
│       └── registry.ts        # реестр по type/provider
│
├── safe-fetch.ts              # SSRF-безопасный fetch (DNS → IP check → redirect check)
│                              # альтернатива размещения: src/server/http/safe-fetch.ts
│
src/server/ai/
├── osint.ts                   # (новый) structured JSON output поверх существующего транспорта

src/server/http/
└── intelligence-handler.ts    # (расширить) новые endpoint'ы
```

**Почему `osint/` внутри `intelligence/`, а не рядом:** домены, владеющие таблицами, держат их в `<domain>/schema.ts` (так делают `clients`, `orders`, `posts`, `booking`, `analytics`, `notifications`, `intelligence`); `Database` уже импортирует `IntelligenceTables`, поэтому новые таблицы подхватываются автоматически; аудит, permission и overview живут там же. Это устраняет риск «второй параллельной intelligence-архитектуры».

**UI:**

```
src/components/intelligence/            # (расширить)
├── IntelligenceCommandCenter.tsx       # существующий корень
├── OsintOverviewPanel.tsx              # источники/свежесть/счётчики
├── ReputationPanel.tsx                 # рейтинг, динамика, темы
├── CompetitorsPanel.tsx
├── ActivityPanel.tsx
├── FindingsPanel.tsx                   # карточки finding + evidence drawer
└── OsintSourcesPanel.tsx               # подключение/статус источников

src/app/(app)/intelligence/page.tsx     # (расширить) табы/секции
src/services/intelligence.service.ts    # (расширить) новые вызовы API
```

---

## 6. Сущности БД (миграция `069_osint_core.sql`)

Конвенции, которые соблюдаем: `uuid` PK (через `randomUUID()`), `business_id NOT NULL REFERENCES business(id)`, составные тенант-safe FK `(business_id, id)`, `created_at/updated_at timestamptz DEFAULT now()`, `CHECK` на длину/enum, `IF NOT EXISTS` + `DROP CONSTRAINT IF ADD` для аддитивности, никаких `DROP` данных. Все таблицы регистрируются в `src/server/intelligence/schema.ts`.

> Проверено: таблицы `osint_*` сейчас не существуют → дубликатов нет.

### 6.1 `osint_profile` (1:1 бизнес)

Внешняя картинка бизнеса. **Не копирует** `business` целиком (в `business` уже есть `name`, `description`, `contact_info`, `industry`, `ai_geography` — используем как seed-источник, но храним отдельно и обновляем только внешними данными).

```
business_id PK FK business(id)
name, legal_name, description, category, subcategories (text/jsonb)
website, phone, email, address, coordinates (point/lat,lng)
working_hours jsonb, social_links jsonb
market, city, region
known_brands jsonb, competitors jsonb (кэш ссылок на osint_competitor)
seeded_from jsonb            # что было взято из business-строки
last_collected_at, observed_at
updated_at
```

### 6.2 `osint_source`

```
id uuid PK
business_id FK
type      CHECK IN ('website','search','maps','review_platform','social_network','directory','news','public_registry','other')
provider  text  -- расширяемый, без CHECK: 'website','yandex','2gis','google','vk','telegram','avito','otzovik','flamp','tripadvisor','other'
url text, name text
status    CHECK IN ('active','paused','error','disabled')  default 'active'
trust_level CHECK IN ('official','public_directory','review_platform','search_result','third_party')
last_collected_at, last_success_at, last_error_at, last_error text
next_collection_at
collection_count int default 0
created_at, updated_at
UNIQUE (business_id, provider, url)   -- идемпотентность источника
```

`trust_level` — **техническое** происхождение данных, не рейтинг.

### 6.3 `osint_observation` (сырые данные, канонический store)

```
id uuid PK
business_id FK, source_id FK osint_source(id)
external_id text null
url text, title text, content text
author_name text
published_at timestamptz null, observed_at timestamptz not null
content_hash text           -- sha256(normalized content)
language text null
rating numeric(4,2) null, rating_max numeric(4,2) null
latitude/longitude double precision null
metadata jsonb default '{}'
created_at
UNIQUE (source_id, external_id) where external_id not null
INDEX (business_id, observed_at DESC), INDEX (business_id, content_hash)
```

**Дедупликация:** первичный ключ = `(source_id, external_id)`; fallback = `(source_id, content_hash)` + `url` (проверка перед вставкой, `INSERT … ON CONFLICT DO NOTHING`).

### 6.4 `osint_review` (производный индекс отзывов)

Отзыв — **не дубль** наблюдения: `content` живёт в `osint_observation`, здесь только производные поля для фильтрации/агрегации.

```
observation_id PK FK osint_observation(id) ON DELETE CASCADE
business_id FK          -- составной FK (business_id, observation_id)
rating, published_at, author_name ( денормализация для выборок )
sentiment CHECK IN ('positive','neutral','negative','mixed')
confidence numeric(3,2)
topics jsonb            -- ['price','staff','waiting_time',…] (расширяемый словарь)
classification CHECK IN ('complaint','praise','suggestion','problem','recurring_problem')
analyzed_at
UNIQUE (observation_id)
```

### 6.5 `osint_fact` (нормализованные факты с provenance)

```
id uuid PK
business_id FK
subject text, predicate text, object text null     -- triples
value jsonb null                                   -- типизированное значение
value_kind text null                               -- 'string','number','hours','url','phone'
source_observation_id FK osint_observation(id)     -- ОБЯЗАТЕЛЬНО (provenance)
confidence numeric(3,2) default 1.0
valid_from timestamptz null, valid_to timestamptz null
created_at
INDEX (business_id, subject, predicate, valid_to)
```

Правило: **факт без `source_observation_id` невалиден**.

### 6.6 `osint_entity` + `osint_entity_match` (entity resolution)

```
osint_entity:
  id PK, business_id FK
  kind CHECK ('business','person_public','location')     -- person_public только публичные лица источника
  display_name, normalized_name
  aliases jsonb
  website, phone, address, coordinates
  fingerprint jsonb        -- нормализованные признаки для сравнения
  merged_into_id uuid null REFERENCES osint_entity(id)
  created_at, updated_at

osint_entity_match:
  id PK, business_id FK
  entity_id FK, candidate_entity_id FK
  match_score numeric(4,3)        -- 0..1
  match_reasons jsonb             -- ["name_similarity:0.93","phone_match","distance:1.8km"]
  evidence jsonb                  -- ссылки на osint_observation
  status CHECK ('proposed','confirmed','rejected') default 'proposed'
  decided_by_user_id null, decided_at null
  created_at
  UNIQUE (entity_id, candidate_entity_id)
```

**Никакого авто-мерджа при низкой уверенности.** `merged_into_id` заполняется только подтверждённым пользователем решением. Порог «предлагать» — код (например ≥0.72), «авто-подтвердить» — не предлагается в MVP вообще.

### 6.7 `osint_competitor`

```
id PK, business_id FK
candidate_business_id uuid null   -- если это бизнес внутри нашей платформы (tenant-safe FK не применим публично)
external_entity_id FK osint_entity null
name, category, address, coordinates
match_score numeric(4,3), match_reasons jsonb
sources jsonb                     -- наблюдения, из которых собран кандидат
status CHECK ('proposed','confirmed','rejected','watching') default 'proposed'
observed_at, created_at, updated_at
UNIQUE (business_id, external_entity_id)
```

### 6.8 `osint_finding` + evidence

```
osint_finding:
  id PK, business_id FK
  type CHECK IN ('REPUTATION','COMPETITOR','PRICING','SERVICE','ACTIVITY',
                 'CUSTOMER_COMPLAINT','CUSTOMER_PRAISE','MARKET','CONTENT',
                 'WEBSITE','CONTACT','LOCATION','OPERATIONAL')
  severity CHECK ('critical','high','medium','low')
  title, description text
  confidence numeric(3,2)
  period_from, period_to timestamptz null
  computed jsonb      -- ЧИСЛА, посчитанные кодом (counts, ratios)
  explanation text    -- формулировка AI (не источник истины)
  status CHECK ('open','acknowledged','resolved','dismissed') default 'open'
  dedupe_key text     -- UNIQ(business_id, dedupe_key) — идемпотентность повторного анализа
  created_at, updated_at, last_seen_at

osint_finding_evidence:
  business_id, finding_id, evidence_kind, observation_id / fact_id / review_cluster_id
  PK (business_id, finding_id, evidence_kind, target_id)
```

**Guard:** finding без строк в `osint_finding_evidence` → отклоняется сервисом (тестом закрепляем).

### 6.9 `osint_cluster` (clustering отзывов)

```
id PK, business_id FK
cluster_key text          -- например нормализованная тема «долгое ожидание»
title, summary
observation_count int, ratio numeric(5,4), review_count int
last_observed_at timestamptz
sample_observation_ids jsonb      -- для «Примеры: …»
UNIQUE (business_id, cluster_key)
```
+ `osint_cluster_member (business_id, cluster_id, observation_id, PK composite)` — каждый кластер обязан ссылаться на исходные отзывы.

### 6.10 `osint_activity_change`

```
id PK, business_id FK, source_id FK
field text, before_value jsonb, after_value jsonb
source_observation_id FK osint_observation
observed_at timestamptz
UNIQUE (business_id, source_id, field, observed_at)
```

### 6.11 `osint_job` (сбор)

```
id PK, business_id FK, source_id FK null
kind CHECK ('DISCOVERY','COLLECT','NORMALIZE','ANALYZE','FINDINGS')
status CHECK ('pending','running','succeeded','failed','dead') default 'pending'
priority int default 100
attempts int default 0, max_attempts int default 3
available_at timestamptz default now(), claimed_at timestamptz null
last_error text, payload jsonb, result jsonb
created_at, updated_at
INDEX (status, available_at) WHERE status='pending'
```

Паттерн — копия `outbox/claim.ts`: `UPDATE … SET status='running', claimed_at=now() WHERE id=… AND status='pending' AND available_at<=now() RETURNING id` внутри транзакции; `expireClaims`-аналог переводит застрявшие `running` старше N минут в `failed`. Backoff: `available_at = now() + (2^attempts) * interval '1 minute'`, `dead` после `max_attempts`.

### 6.12 Аудит

Без новых таблиц: `intelligence_audit_log` уже подходит. Операции: `osint_source_created`, `osint_collector_started/finished/failed`, `osint_analysis_started/finished`, `osint_finding_created/updated`, `osint_manual_refresh`, `osint_entity_confirmed/rejected`, `osint_competitor_confirmed`.

---

## 7. Provider-абстракция

Контракт в `src/server/intelligence/osint/providers/types.ts`:

```ts
export type NormalizedObservation = {
  sourceId: string;
  externalId: string | null;
  url: string | null;
  title: string | null;
  content: string;
  authorName?: string | null;
  publishedAt?: Date | null;
  observedAt: Date;
  contentHash: string;
  language?: string | null;
  rating?: number | null;
  ratingMax?: number | null;
  latitude?: number | null;
  longitude?: number | null;
  kind: "page" | "review" | "search_result" | "post" | "listing";
  metadata?: Record<string, unknown>;
};

export type OsintProvider = {
  readonly type: SourceType;           // 'website' | 'search' | 'review_platform' | …
  readonly provider: string;           // 'website' | 'yandex' | '2gis' | …
  discover(profile: OsintProfile): Promise<string[]>;          // кандидаты URL/запросы
  collect(source: OsintSourceConfig, opts: CollectLimits): Promise<NormalizedObservation[]>;
  healthCheck(source: OsintSourceConfig): Promise<{ ok: boolean; detail?: string }>;
};
```

`CollectLimits = { maxPages, maxItems, timeoutMs, rateLimitPerMinute }` — обязаны быть у каждого collector'а.

Реестр `registry.ts`: `registerProvider(p)`, `resolveProvider(type, provider)`. Конкретный провайдер **не** протягивается через систему — только через реестр.

**MVP-провайдеры:** `website` (публичный HTML), `search` (разрешённый публичный endpoint/официальный API; иначе источник остаётся неподключённым), `reviews` (абстракция + один адаптер с открытым/разрешённым доступом). Остальные (`social`, `maps`, `directory`, `news`, `public_registry`) подключаются через тот же интерфейс позже.

---

## 8. Пайплайн данных

```
providers.collect()
  → safeFetch (SSRF guard)            §10
  → NormalizedObservation[]
  → observations.ts: дедуп (external_id | content_hash) → osint_observation
  → facts.ts: детерминированный парсер → osint_fact (+ provenance)
  → entity-resolution.ts: кандидаты → osint_entity_match (proposed)
  → review-analysis.ts (AI) → osint_review sentiment/topics/complaints
  → review-clustering.ts (код + AI-метки) → osint_cluster + members
  → competitors.ts: score по коду → osint_competitor (proposed)
  → activity.ts: diff before/after → osint_activity_change
  → findings.ts (КОД считает числа) → AI-объяснение → osint_finding + evidence
  → recommendations.ts → (UI) рекомендации, без автодействий
```

Ключевые правила:

- **AI никогда не является источником истины.** Цифры («31 из 214 отзывов», «12%», «+27 за 30 дней») считает код в `findings.ts`/`metrics.ts`; AI только классифицирует/формулирует.
- Каждый AI-ответ проходит схемную валидацию (§9) — парсинга произвольного текста нет.
- Review velocity: `reviews/day|week|month` — чистая арифметика по `published_at`.
- Свежесть: `observed_at` наблюдений + `last_success_at` источника → в UI всегда выводится «Данные актуальны на: …».

---

## 9. AI-интеграция (существующий слой, без второго клиента)

**Что используем как есть:** `completeAiDraft()` (`src/server/ai/posts.ts`) — транспорт `https://api.openai.com/v1/responses`, `AI_API_TOKEN`/`AI_MODEL` из `runtimeConfig()`, `store:false`, `AbortSignal.timeout(30000)`, `max_output_tokens:2048`, `redirect:"error"`, reject секретов, `recordAiUsage()` для стоимости.

**Чего не хватает и что добавляем** в `src/server/ai/osint.ts`:

1. `completeAiJson<T>(system, input, validate, options)` — тот же транспорт, но с инструкцией вернуть **только JSON**, плюс `JSON.parse` в `try/catch`, плюс ручной `validate(value): value is T`.
   *Почему вручную:* `zod` не объявлен в `package.json` (только транзитивно), в проекте валидация ручная (`src/server/http/validation.ts`, `normalizeSummary` в `ai/interview.ts`). Добавлять транзитивную зависимость в прод-код нельзя.
2. Типовые схемы: `ReviewAnalysisSchema` (`{sentiment, topics[], summary, complaintType, evidenceIds[]}`), `EntityExtractionSchema`, `ClusterLabelSchema`, `FindingExplanationSchema`.
3. `recordAiUsage(db, {feature:"osint_review_analysis", …})` на каждый вызов — **обязательно** (cost control).
4. Кэш результатов: один и тот же `content_hash` **не отправляем в LLM повторно** (`osint_review.analyzed_at` + `metadata.aiCacheKey`).

**Чего AI в MVP не делает:** парсинг HTML (сначала parser), генерация фактов из ничего, автоматические действия, отправка сообщений.

**Стоимость:**
- не отправлять HTML в LLM (только нормализованный фрагмент ≤ N символов);
- лимит вызовов на job (`payload.maxAiCalls`);
- ограничение страниц/размера ответа у provider'а;
- `AI_API_TOKEN` не логируется (`log()` фильтрует `SECRET_KEYS`);
- при `AI_NOT_CONFIGURED` пайплайн работает детерминированно (parser-only), AI-анализ помечается «недоступен», но не роняет сбор.

---

## 10. Безопасность веб-коллектора (SSRF)

Новый модуль `src/server/intelligence/safe-fetch.ts` (используется **всеми** provider'ами):

| Угроза | Защита |
|---|---|
| `127.0.0.1`, `localhost`, `0.0.0.0` | reject по hostname и по резолву |
| приватные IPv4 (`10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `100.64/10`, `127/8`) | проверка **каждого** A/AAAA-ответа (не только hostname) |
| metadata endpoint `169.254.169.254`, `metadata.google.internal` | explicit deny-list + deny всего link-local |
| приватный/ULA IPv6 (`fc00::/7`, `fe80::/10`, `::1`) | проверка всех AAAA |
| DNS rebinding | резолвим → проверяем IP → **дёргаем по IP с Host-заголовком** либо кэшируем IP на время запроса |
| редиректы на внутренности | `redirect: "manual"`, до 3 hop'ов, каждый hop повторно проходит тот же IP-check |
| непубличные схемы | allow-list только `http:`/`https:` (запрет `file:`, `ftp:`, `gopher:`, `data:`) |
| огромный ответ | лимит байт (например 2 МБ) + `AbortSignal.timeout` (например 15 c) + обрыв чтения по лимиту |
| MIME | allow-list `text/html`, `application/xhtml+xml`, `application/json` (для API) |
| парсинг | парсер без исполнения скриптов; никаких inline JS/eval; текст вырезается из `<script>/<style>` |
| ссылки из ответа | любой относительный URL резолвится и снова проходит проверку |

**Запрещено:** проксировать произвольный пользовательский URL без этих проверок, делать «открыть по ссылке» фичу без guard'а.

Дополнительно: `limit()` на `POST /intelligence/collect` (например 10/60 c на пользователя), общий дневной лимит `osint_job` на бизнес (payload budget), и выключение источника в `error` не должно останавливать пайплайн (**failure is normal**: `one source failed → status='error'`, остальное продолжает работать).

---

## 11. Workers и фоновые джобы

**Не создаём вторую систему очередей.** Используем `background-worker` (`scripts/background-worker.mts`):

1. Добавляем цикл `processOsintJobs(db)` в тот же `while (!stopping)` блок (как `processSetupDrafts`).
2. Heartbeat: имя `osint` в список `heartbeatNames` + в `delete from worker_heartbeat where name in (…)` при shutdown.
3. **Обязательная правка:** `src/app/api/health/route.ts` — хардкод-массив `names[]` не знает про `osint`, поэтому новый heartbeat был бы невидим health'у. Добавить `"osint"` в `names[]` и (рекомендую) в `required` при `backgroundEnabled`.
4. Идемпотентность: `status='pending'` claim, уникальные ключи на уровне данных (`content_hash`, `dedupe_key`, `UNIQUE (business_id, source_id, field, observed_at)`).
5. Rate limit/timeout/backoff/maxPages/maxItems — в `CollectLimits` + `osint_job.attempts`.
6. Логи: `log("info"|"warn"|"error", "OSINT_COLLECT_STARTED"|"OSINT_COLLECT_FAILED", {businessId, sourceId, provider, durationMs})` — без тела ответа и без PII.
7. Аудит: `logIntelligenceEvent()` на start/finish/fail/finding_created.

Отдельный `osint-worker` в MVP **не нужен** (нет собственной инфраструктуры); при росте объёмов — отдельный процесс того же образа по образцу сплита web/background/telegram.

**Health-gate:** если сбор запущен вручную и захочем, чтобы health показывал состояние — только после добавления в `names[]`.

---

## 12. API

> **План Этапа 1**, а не факт. Фактически в репозитории три ручки:
> `GET /intelligence/overview`, `GET /intelligence/osint`,
> `POST /intelligence/osint/discovery` (§22.4). Остальные строки таблицы
> (`/profile`, `/sources`, `/observations`, `/findings`, `/competitors`,
> `/reviews`, `/collect`, `/entity-matches`) **не реализованы** — §20.16, §22.6.

Конвенция: `src/app/api/v1/businesses/[id]/…/route.ts` → `intelligenceHandler(request, publicId, subresource)` в `src/server/http/intelligence-handler.ts`; `export const dynamic = "force-dynamic"`; `requireUser` → `requireBusiness` → сервис; мутации — `requireOrigin` (как в `application.ts` для POST) и `readJson()`.

| Метод | Путь | Permission | Замечание |
|---|---|---|---|
| GET | `/intelligence/overview` | `analytics.view` | **существует** — расширить блоками OSINT |
| GET | `/intelligence/profile` | `analytics.view` | внешняя картина бизнеса |
| GET/POST/PATCH | `/intelligence/sources` | `analytics.view` / `intelligence.manage` | ручная настройка источников |
| GET | `/intelligence/observations` | `analytics.view` | фильтр по source/type/date, пагинация |
| GET | `/intelligence/findings` | `analytics.view` | фильтр severity/type/status |
| GET | `/intelligence/findings/:id` | `analytics.view` | включая evidence graph |
| PATCH | `/intelligence/findings/:id` | `intelligence.manage` | ack/dismiss (вручную) |
| GET | `/intelligence/competitors` | `analytics.view` | кандидаты + reasons |
| PATCH | `/intelligence/competitors/:id` | `intelligence.manage` | confirm/reject |
| GET | `/intelligence/reviews` | `analytics.view` | sentiment/topics/velocity |
| POST | `/intelligence/collect` | `intelligence.manage` | `limit()` + enqueue job, 202 |
| GET | `/intelligence/entity-matches` | `analytics.view` | proposed matches |
| PATCH | `/intelligence/entity-matches/:id` | `intelligence.manage` | confirm/reject (нет авто-мерджа) |

**Permissions:** чтение наследуем от `analytics.view` (уже разрешён операторам — как в Day 1). Запись/сбор — **новое** право `intelligence.manage` в union `Permission` (`src/server/access/permissions.ts`), доступно `owner`/`admin` (операторам — нет). Сопутствующие правки: таблица в `docs/PERMISSIONS.md`.

**Энтайтмент:** OSINT в MVP **не** завязан на `business_solution` (не новый платный product solution). Если монетизировать — добавить код в `src/lib/productSolutions.ts` + `solutions/catalog.ts` + гейт через `getEntitlement()`. Решение зафиксировать в Stage 2.

**Ответы:** всегда `lastUpdated` (свежесть) и `dataMode`; ошибки — `AppError` с кодом (`OSINT_SOURCE_DISABLED`, `AI_NOT_CONFIGURED`, `OSINT_URL_INVALID`, …).

---

## 13. UI

Расширяем `/intelligence`, **не создаём второй раздел** и не ломаем существующий `IntelligenceCommandCenter`.

Блоки (по приоритету):

1. **OSINT OVERVIEW** — источники (активны/ошибки), «Данные актуальны на: …», счётчики: наблюдений, фактов, проблем, сигналов.
2. **REPUTATION** — средний рейтинг, кол-во отзывов, динамика, основные позитивные/негативные темы.
3. **COMPETITORS** — рейтинг, отзывы, активность, «почему система считает конкурентом» (список причин, не субъективная оценка).
4. **ACTIVITY** — новые публикации/отзывы, изменения сайта и контактов (before → after).
5. **FINDINGS** — критичные/важные/информационные, severity badges, `<details>` «Показать доказательства» → ссылки на отзывы/источники/URL.
6. **RECOMMENDATIONS** — поверх findings, без автодействий (`actionType`, `status`).

Правила UI: карточка finding показывает **цифры** («31 отзыв за 90 дней»), источники (`2GIS · Яндекс`), confidence, «Почему:»-список и открываемые доказательства; все даты локализованы; тема — существующие токены, паттерн `panel`/`intelligence-card`/`button`, `data-testid` для e2e.

---

## 14. Наблюдаемость и стоимость

Метрик-инфраструктуры в проекте нет → считаем **из БД** в overview (никаких новых систем):

```
sources_total, sources_active, sources_error
collections_total, collections_failed        (osint_job по kind/status)
observations_total, observations_new_24h     (osint_observation)
facts_total, findings_open, findings_by_severity
ai_requests, ai_failures                     (ai_usage_event по feature='osint_*')
```

Логи — через `log()` (`OSINT_*` коды), аудит — через `intelligence_audit_log`. Health — только после добавления `osint` в `names[]` (`src/app/api/health/route.ts`).

---

## 15. Тестовый план (Этап 13)

Инфраструктура готова: PGlite + `migrate()` + `node:test` (`tests/*.test.mjs`, включая `tests/http/*` для HTTP-контрактов). Базовый прогон: **553 / 542 pass / 0 fail / 11 skipped**.

| Область | Тесты |
|---|---|
| Entity resolution | одна сущность (разные написания), разные сущности, неоднозначный матч → `proposed`, не подтверждён; **авто-мерджа нет** |
| Дедупликация | одно и то же наблюдение дважды → 1 строка; один контент с разным URL → дедуп по `content_hash`; `external_id` uniqueness |
| Отзывы | positive/negative/mixed/neutral; topics; complaint/praise detection; velocity-арифметика |
| Findings | finding **с** evidence создаётся; finding **без** evidence → отклоняется; числа совпадают с fixture-данными (код, не AI) |
| Tenant isolation | Business A не читает sources/observations/findings/competitors Business B (по образцу `tests/intelligence-day1.test.mjs`) |
| API permissions | аноним → 401; чужой business → 404; оператор на `POST /sources` → 403; `intelligence.manage` → 201 |
| SSRF | `127.0.0.1`, `localhost`, `10.0.0.1`, `169.254.169.254`, `::1`, `fc00::` → reject; редирект на приватный IP → reject; `file://` → reject; превышение лимита байт/таймаут → error source, пайплайн жив |
| Jobs | повторный запуск не создаёт дублей; `attempts`/backoff/`dead`; застрявший `running` → `expireClaims`-аналог |
| Идемпотентность findings | повторный анализ → обновление `last_seen_at`, не дубль (`dedupe_key`) |
| Audit | каждый collector-событие пишется в `intelligence_audit_log` |

E2E (по образцу `e2e/clients-v2.spec.mjs`): открыть `/intelligence`, увидеть OSINT-блоки, раскрыть evidence, подключить источник, запустить сбор, получить finding.

---

## 16. Маппинг на этапы 2–14

| Этап | Артефакт | Зависимости |
|---|---|---|
| 2 ✅ | `migrations/069_osint_discovery_v1.sql` (§19) + `intelligence/osint/*` | решение по permissions/энтайтменту (принято, §17) |
| 3 | `osint/profile.ts`, `sources.ts`, `observations.ts`, `facts.ts`, `findings.ts` (domain services) | — |
| 4 | `providers/types.ts` + `registry.ts` + `safe-fetch.ts` (SSRF) | — |
| 5 | `providers/website.ts`, `providers/search.ts` (первые collectors) | 4 |
| 6 | normalization + dedup + `entity-resolution.ts` | 3 |
| 7 | `review-analysis.ts` + `src/server/ai/osint.ts` (structured AI) | 3, 9 |
| 8 | `competitors.ts` + `activity.ts` | 6 |
| 9 | `findings.ts` + evidence + `recommendations.ts` | 3, 7, 8 |
| 10 | `job-runner.ts` + вставка в `background-worker` + health `names[]` | 5 |
| 11 | `intelligence-handler.ts` endpoint'ы + permissions | 3–10 |
| 12 | UI-панели `/intelligence` | 11 |
| 13 | tests (§15) + security audit SSRF | всё |
| 14 | `npm run typecheck && npm run lint && npm test && npm run build` + финальный аудит | — |

---

## 17. Риски и открытые решения (нужны перед Этапом 2)

1. **Источники отзывов/поиска.** Нужен легальный доступ: официальный API или разрешённый публичный endpoint. Если источника нет — адаптер остаётся заглушкой со статусом `disabled`, пайплайн не блокируется.
2. **HTML-парсер.** В проекте нет ни одного → потребуется **явно добавить** зависимость (рекомендую `node-html-parser`: маленькая, без транзитивных зависимостей) в `package.json`, либо ограничиться целевыми regex-извлечениями (хрупко). Решение на Этапе 4/5.
3. **`intelligence.manage`** — добавить новое право или использовать `settings.manage`? Рекомендация: новое право (семантика точнее, матрица в `docs/PERMISSIONS.md` обновляется одной строкой).
4. **Notification-типы OSINT.** `notification.type` без CHECK, но `notification_preference_type_check` жёстко перечисляет типы (060). Добавление типа = DROP+ADD CHECK в той же миграции + union `NotificationType`. Рекомендация MVP: **без** уведомлений (findings видны в дашборде) → меньше миграционного риска.
5. **Энтайтмент** (`business_solution`) — MVP без платного гейта (см. §12).
6. **Частота сбора** — предложение: ручной запуск + `next_collection_at` не чаще 1 раза/источник/24 ч в фоне, лимит страниц/байт на источник.

---

## 18. Definition of Done → текущий статус

```
[x] Intelligence architecture изучена          [x] OSINT schema implemented (Этап 2)
[x] Existing intelligence code reused (план)  [x] migrations created (069–071)
[x] provider abstraction implemented (эт. 2)  [ ] website collector implemented
[x] discovery collector implemented (эт. 2)   [ ] observation storage implemented
[x] deduplication implemented (discovery)     [~] entity resolution: scoring+rules (эт. 2), merge — эт. 4
[ ] review analysis implemented               [ ] competitor detection implemented
[ ] findings implemented                      [ ] evidence implemented
[ ] AI integration uses existing AI layer     [x] audit implemented (source=osint)
[ ] background jobs implemented               [x] API implemented (intelligence/osint)
[x] UI implemented (OsintPanel)               [x] tenant isolation verified (эт. 2)
[x] SSRF protection implemented (safe-fetch)  [x] tests implemented (+43 OSINT)
[x] typecheck passes                          [x] lint passes (0 ошибок)
[x] tests pass (649 / 0 fail / 11 skipped)    [x] build passes (этап 2 gate)
[x] permission intelligence.manage            [x] Stage 3 contracts only (§21, без runtime)
```

Базовые проверки на `89403a3` выполнены **до** любых изменений: `typecheck` чисто, `lint` 0 ошибок, `npm test` 553/0 fail. После Этапа 2: `typecheck` чисто, `lint` 0 ошибок, `npm test` 596 tests / 585 pass / 0 fail / 11 skipped, `npm run build` exit 0. На Этапе 14 — тот же финальный гейт.

---

## 19. Этап 2 — реализовано: discovery (фактическая архитектура)

> Факт Этапа 2 (вместо первичных черновиков §6/§7). Имена таблиц и файлов
> ниже — те, что реально в репозитории.

### 19.1 Discovery architecture

```
migrations/069_osint_discovery_v1.sql        10 таблиц (additive only)
src/server/intelligence/schema.ts             IntelligenceTables extends OsintTables
src/server/intelligence/osint/
  schema.ts        типы osint_* таблиц (Kysely) + статусы/CHECK-энумы
  config.ts        веса, пороги, бюджеты, шаблоны запросов (все тюнинги)
  text.ts          нормализация, bigram-Dice, стем-матчинг, телефонные раны
  url.ts           normalizeUrl / registrableDomain / hostMatches (SSRF-помощник)
  profile.ts       DiscoveryProfile + buildDiscoveryProfile (mining из business)
  queries.ts       buildDiscoveryQueries (детерминированные шаблоны)
  classifier.ts    host-правила → тип/уровень доверия источника
  entity-resolution.ts  scoreCandidate / decideCandidate / identity key
  providers/
    types.ts       OsintProvider + descriptor + policy
    registry.ts    ProviderRegistry.select(requested, intents)
    mock.ts        детерминированный тестовый провайдер (без сети)
  candidates.ts    persistCandidate / ensureEntity / ensureSource / связи
  discovery.ts     runDiscovery (оркестратор) + loadDiscoveryProfile + stale-release
  safe-fetch.ts    SSRF-safe fetch (DNS → IP → redirect-проверка)
```

Поток: `business`-строка → `buildDiscoveryProfile` → `buildDiscoveryQueries`
→ `registry.select` → `provider.search` → `classifyResult` →
`scoreCandidate` + `decideCandidate` → `persistCandidate` (dedup) →
при `accepted`: `ensureSource` + `osint_entity_sources` → счётчики в
`osint_discovery_runs` → `logIntelligenceEvent(source: "osint")`.

### 19.2 Source discovery lifecycle

Источник появляется **только** из авто-принятого кандидата (или вручную —
Этап 11, `origin='manual'`):

```
result провайдера → classify → candidate (status: rejected | candidate | accepted)
  rejected   → строка хранится для аудита/антидребезга, источник НЕ создаётся
  candidate  → ручная очередь ревью (Этап 11), источник НЕ создаётся
  accepted   → ensureSource(origin='discovery', status='active',
                            auto_accepted=правило) + osint_entity_sources
```

- `osint_sources.status`: `active|paused|error|disabled`; `trust_level` из
  classifier'а (`official|public_directory|review_platform|third_party`).
- Коллекция (глубокая загрузка, `last_collected_at`, `next_collection_at`) —
  Этапы 4–5; в Этапе 2 источники создаются со всеми timestamp'ами `NULL`.

### 19.3 Entity resolution

`score = matchedWeight / applicableWeight` (нормализация 0..1):

- **applicable** — признак, где профиль содержит значение **и** у candidate
  есть текст/URL для проверки; неприменимые признаки исключены из
  знаменателя (иначе score занижен «за грехи» профиля).
- **Веса** (`DEFAULT_MATCH_WEIGHTS`): phone 0.4, domain 0.3, address 0.15,
  name 0.1 (вклад `weight * nameRatio`), category 0.05, city 0.05, social 0.1.
- **Правила** (явные, порядок = приоритет):
  1. `score < 0.1` → `rejected`;
  2. `domain_exact` — registrable-домен URL ∈ knownDomains **и** score ≥ 0.4;
  3. `phone_plus_identity` — телефон найден в тексте **и**
     (nameRatio ≥ 0.7 **иЛИ** город найден);
  4. иначе → `candidate` (только ручное подтверждение).
- Телефоны сравниваются по нормализации (11 цифр РФ `8…` → `7…`),
  extraction профиля — строгий, matching по телефонным «ранам» текста.
- `identity_key`: `domain:<registrable>` иначе `phone:<digits>` —
  partial unique index `(business_id, identity_key)` дедуплицирует сущность;
  `fingerprint` готовит merge (Этап 4).

### 19.4 Candidate states

| Состояние | Кто выставляет | Что дальше |
|---|---|---|
| `candidate` | scoring (порог пройден, правила не сработали) | ревью в UI (Этап 11) |
| `accepted` | авто-правило → позже пользователь | источник создан/подтверждён |
| `rejected` | `score < 0.1` | хранится; не мешает повторным run'ам |

- Дедупликация: `UNIQUE (business_id, normalized_url)`; повторный run
  возвращает существующую строку и **никогда не понижает** статус
  (порядок `rejected < candidate < accepted`).
- `evidence` = сигналы scoring'а (применимые признаки с вкладами),
  `match_reasons` — списочные метки для UI/аудита.

### 19.5 Discovery runs

`osint_discovery_runs`: `queued → running → completed|partial|failed`.

- **Claim**: `UPDATE … WHERE status='queued'` (lease-паттерн проекта);
  **stale-release**: `releaseStaleDiscoveryRuns` переводит `queued/running`
  старше 15 мин в `failed` (`stale_run_expired`).
- **Счётчики**: `queries_count` (попытки), `results_count` (сырые результаты),
  `candidates_count` (новые строки), `duplicates_count` (dedup-попадания),
  `accepted_count`/`review_count`/`rejected_count` (по новым строкам).
- **Статусы**: `completed` — без ошибок; `partial` — бюджет/аборт/нет
  провайдеров/нет запросов/часть провайдеров упала; `failed` — все вызовы
  провайдеров упали. Ошибки → `error` (2000 символов).
- **Бюджеты** (`DEFAULT_DISCOVERY_BUDGET`): 12 запросов, 50 результатов,
  30 кандидатов, 5 страниц, 2 МБ, 30 с; проверка между вызовами.
- Профиль run'а → `profile jsonb`, бюджет → `budget jsonb`,
  участвовавшие провайдеры → `providers jsonb`.

### 19.6 Provider architecture

- `OsintProvider = { descriptor, search({query, profile, limit, signal}) }`:
  возвращает **сырые** результаты; нормализация/классификация/scoring — на
  вызывающей стороне (провайдер не принимает решений).
- `descriptor.policy`: `official_api | search_api | structured_data | disabled`;
  `disabled` никогда не участвует в run'е; `enabledByDefault=false` — только
  по явному списку.
- `ProviderRegistry.select(requested, intents)`: `requested=null` →
  включённые по умолчанию; иначе — пересечение с зарегистрированными;
  неизвестный id молча выпадает (run уйдёт в partial/failed сам).
- Этап 2 поставляет только `mock.ts` (тесты, без сети). Первые реальные
  провайдеры — Этапы 4–5 и только с легальным доступом (§17.1).

### 19.7 SSRF security model (`safe-fetch.ts`)

```
1. new URL → только http/https, без credentials в URL
2. dns.lookup(hostname, all) → ВСЕ адреса
3. если ХОТЯ БЫ ОДИН адрес приватный → reject private_address
   (loopback, RFC1918, CGNAT 100.64/10, link-local 169.254/16 включая
    169.254.169.254, 0/8, multicast/reserved ≥224, ::1, ::, fc00::/7,
    fe80::/10, ff00::/8, NAT64, IPv4-mapped ::ffff:x.x.x.x)
4. transport с redirect:'manual' → 3xx читаем сами:
   каждый hop заново проходит шаги 1–3, ≤ maxRedirects (default 3)
5. лимиты: maxBytes (default 2 МБ, pre-check по content-length + потоковая
   обрезка), timeoutMs (default 10 с, AbortSignal), GET/HEAD
6. ошибки возвращаются как {ok:false, reason} — без throw'а в оркестратор
```

- `lookup`/`transport` внедряются → модуль покрыт тестами **без сети**.
- `allowPrivateNetworks` только для тестов/dev.
- Глубокая загрузка (Этап 5) обязана идти **только** через `safeFetch`.

### 19.8 Вне рамок Этапа 2 (перенесено)

Наблюдения/факты/находки (таблицы созданы, сервисов нет), глубинная
загрузка страниц, реальные провайдеры, AI-классификация (`src/server/ai/osint.ts`),
конкуренты, уведомления, background worker (`processOsintJobs`),
health-heartbeat `osint`.

> Обновлено при ремонте (§22): `intelligence.manage` + endpoint'ы + UI **вошли**
> в область реализации и сделаны — см. §22.5. Остальное по-прежнему вне рамок.

### 19.9 Тесты и гейт Этапа 2

| Файл | Что покрывает |
|---|---|
| `tests/osint-url-normalize.test.mjs` | tracking-параметры, порядок, схемы, registrableDomain, hostMatches |
| `tests/osint-queries.test.mjs` | профиль (город/адрес/телефон/сайт), шаблоны, бюджет, пропуски |
| `tests/osint-classifier.test.mjs` | host-правила, reject SERP/вакансий, типы/доверие, метод |
| `tests/osint-entity-resolution.test.mjs` | формула score, 3 правила решения, identity key, 0..1 |
| `tests/osint-safe-fetch.test.mjs` | приватные диапазоны, mixed A, redirect-хопы, лимиты, ошибки |
| `tests/osint-discovery.test.mjs` (PGlite) | полный run, дедуп, авто-accept→источник, tenant isolation, partial/failed, stale-release, аудит |

Гейт: `typecheck` ✅ · `lint` ✅ · `npm test` 596/0 fail/11 skipped ✅ · `build` ✅.

---

## 20. Этап 2 — реализовано: knowledge graph + source memory

Миграции: `069_osint_discovery_v1.sql` (discovery-фундамент) и
`070_osint_knowledge_graph_v1.sql` (глобализация публичного слоя + новые
таблицы графа). 070 — расширение 069, ничего из существующего не пересоздаёт.

Код: `src/server/intelligence/osint/**`.

### 20.1 ER-модель

```
                    ТЕНАНТ-СКОП (business_id обязателен)
  ┌──────────────────────────────────────────────────────────────────┐
  │  business ──< osint_discovery_runs   (status, depth, stats)      │
  │           ──< osint_source_candidates (candidate|accepted|...)   │
  │           ──< osint_business_entities ─┐                         │
  │           ──< osint_facts             │  мост §4                │
  │           ──< osint_competitor_candidates                        │
  │           ──< osint_findings ──< osint_finding_evidence          │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  entity_id / source_id (плоские FK)
                              ▼
                    ПУБЛИЧНЫЙ СЛОЙ (business_id отсутствует)
  ┌──────────────────────────────────────────────────────────────────┐
  │  osint_entities ──< osint_entity_sources >── osint_sources      │
  │        │  ^                    │                    │            │
  │        │  │                    │                    └─ osint_source_context
  │        │  │                    │                         │      │
  │        │  │                    │                    osint_source_history
  │        │  │                    ▼                              │
  │        │  └────── osint_entity_relations                      │
  │        │                    ▲                                 │
  │        │  osint_entity_mentions ──> osint_observations ────────┘
  │        └─── osint_entity_attributes ──> osint_observations     │
  └──────────────────────────────────────────────────────────────────┘

  Стрелка «──>» = FK на таблицу-источник evidence.
  Ни одна таблица верхнего блока не ссылается на business/user.
```

### 20.2 Entity graph

Граф — `osint_entities` + три ребра:

| Ребро | Таблица | evidence |
|---|---|---|
| entity → source | `osint_entity_sources` (PK `entity_id, source_id`) | `confidence` |
| entity → entity | `osint_entity_relations` | `source_observation_id NOT NULL` |
| entity → attribute | `osint_entity_attributes` | `source_observation_id` (nullable) |

Упоминание entity в тексте — `osint_entity_mentions`, привязано к
наблюдению, а не к ребру.

Ребро не может существовать без доказательства: `osint_entity_relations.source_observation_id`
`NOT NULL` + `CHECK (from_entity_id <> to_entity_id)`.

Код: `entity-graph.ts`, `relations.ts`, `mentions.ts`, `attributes.ts`.

### 20.3 Глобальная (public) модель сущности

`osint_entities` **не содержит** `business_id` — сущность принадлежит всему
графу. Следствия:

1. Дедупликация глобально — **только по `identity_key`**
   (`domain:…` / `phone:…`), частичный `UNIQUE`-индекс.
2. Сопоставление по одному `normalized_name` **запрещено** (§12): имя
   коллизионно, поэтому обычный индекс по имени — не уникальный.
3. Принадлежность конкретному бизнесу живёт исключительно в
   `osint_business_entities` (§4).

`identity_key` строится из `buildIdentityKey(profile)`: сначала домен, потом
телефон, иначе `null` — и сущность тогда не дедуплицируется глобально.

Код: `entity-graph.ts` (`ensureGlobalEntity`, `findGlobalEntity`,
`ensureBusinessEntity`, `findOwnBusinessEntity`).

### 20.4 Маппинг tenant → business

`osint_business_entities` с PK `(business_id, entity_id, relationship)`:

| Колонка | Назначение |
|---|---|
| `relationship` | единый словарь 13 типов (см. §20.9) |
| `confidence` | никогда не понижается при повторном link |
| `status` | `candidate` → `linked` / `rejected` |
| `evidence` | почему связь считается установленной |
| `decided_by_user_id`, `decided_at` | кто принял решение |

Это **единственная** таблица, где тенант указывает, какая public entity
относится именно к нему. Функция `linkBusinessEntity` идемпотентна: при
повторе берётся максимум `confidence`, строк не плодится.

### 20.5 Source memory

`osint_sources` — глобальный реестр (`UNIQUE (normalized_url)`), без
`business_id`, без `entity_id`, без `discovery_run_id`.

Структурированный контекст — `osint_source_context` (1:1):

- **плоские колонки** для скалярных полей: `canonical_name`, `description`,
  `category`, `language`, `city`, `region`, `country`, `address`;
- `jsonb` только для действительно списочных/свободных полей: `contacts`,
  `domains`, `social_links`, `metadata`;
- `known_owner_entity_id` — владелец-источник (§1), `ON DELETE SET NULL`.

Перезапись не теряется: `upsertSourceContext` сравнивает patch со старым
значением и пишет изменения в `osint_source_history` со снапшотом
`{ from, to }`, закрывая предыдущий интервал `valid_to`. Повтор того же
значения историю не плодит.

Код: `source-context.ts` (`upsertSourceContext`, `readSourceHistory`).

### 20.6 Модель наблюдений

`osint_observations` — **глобальная** сырая запись «что было на странице»:

- `source_id NOT NULL` → `osint_sources` (каскад);
- `entity_id` — nullable, `ON DELETE SET NULL`;
- `content_hash` + `external_id` — уникальность внутри источника
  (`UNIQUE (source_id, content_hash)`, частичный по `external_id`);
- `metadata jsonb` — колонка под модель (§7), а не вся модель целиком;
- `kind`: `page | review | search_result | post | listing`;
- `rating`/`rating_max` — производная оценка, `numeric` читается строкой.

`content_hash` не вычисляется в миграции — его кладёт сервис сбора
(Этапы 5+), поэтому здесь он задаётся тестами/вызывающим кодом.

### 20.7 Извлечение сущностей (entity extraction)

Три слоя, все в `osint/extraction/`:

| Слой | Файл | Роль |
|---|---|---|
| Контракт | `contract.ts` | zod-схема `ExtractionResult` — единственная точка приёма AI-ответа |
| Deterministic | `deterministic.ts` | телефоны, email, URL→домены, город/адрес/категория из профиля. Работает всегда, без сети |
| AI-адаптер | `ai.ts` | промпт + разбор JSON + `safeParse`; **выключен по умолчанию** (§26) |
| Применение | `apply.ts` | кладёт атрибуты и mention'ы в граф |

Правила `apply.ts`:

- атрибуты применяются к **целевой** сущности наблюдения;
- mention с совпадающим `normalized_name` цепляится к ней;
- любое другое имя уходит в `unresolved` — `osint_entities` **никогда**
  не создаётся по одному имени из текста (§12);
- `OWNER`/`PUBLISHED_BY` без явного evidence отбрасывается guard'ом.

`zod` — прямая зависимость `package.json` (был только транзитивным).

### 20.8 Entity resolution

Существующая формула не менялась (§12):

```
score = matchedWeight / applicableWeight   // 0..1, объяснимо
applicable = признаки, где профиль содержит значение И у candidate есть
             текст/URL для проверки
```

Веса/пороги — только в `config.ts` (`DEFAULT_MATCH_WEIGHTS`,
`DEFAULT_MATCH_THRESHOLDS`).

Правила auto-accept (`AUTO_ACCEPT_RULES`, порядок = приоритет):

1. `domain_exact` — регистрируемый домен совпал и `score >= 0.4`;
2. `phone_plus_identity` — телефон совпал **и** (название ≥ 0.7 **или** город).

Всё остальное → `candidate` (ручная очередь). Ниже `candidateMinScore` →
`rejected`. Слабые совпадения автоматически не принимаются.

Cross-source linking — `strongSignalsMatch(a, b)` в `entity-graph.ts`:
сравниваются `phone`, `domain`, `address`, `coordinates`. **Имя в сравнении
не участвует вообще.**

### 20.9 Модель evidence

| Уровень | Таблица | Обязательное доказательство |
|---|---|---|
| Упоминание в тексте | `osint_entity_mentions` | `text_span` (фрагмент источника) + `context` |
| Связь двух сущностей | `osint_entity_relations` | `source_observation_id NOT NULL` + `evidence jsonb` |
| Атрибут | `osint_entity_attributes` | `source_observation_id` (nullable, `SET NULL`) |
| Факт тенанта | `osint_facts` | `source_observation_id` |
| Находка | `osint_findings` + `osint_finding_evidence` | `dedupe_key` + привязка к observation/fact/competitor |

Уникальность mention: `(observation_id, entity_id, mention_type, text_span)` —
одно и то же доказательство не плодит строк.

**Правило OWNERSHIP VS MENTION (§6).** Единый словарь из 13 типов:

```
OWNER, PUBLISHED_BY, MENTIONS, ABOUT, PARTNER, CLIENT, COMPETITOR,
LOCATION, EMPLOYER, SPONSOR, SUPPLIER, CUSTOMER, RELATED_TO
```

`MENTIONS` **никогда** не интерпретируется как `OWNER`/`PUBLISHED_BY`.
Обе ownership-типы требуют явного evidence вида
`sameAs | rel_author | explicit_claim` — проверяет `assertMentionEvidence`
(`mentions.ts`), его же дублирует `.refine` в zod-контракте и guard в
`apply.ts`. Нарушение → `MentionEvidenceError`, строка не пишется.

### 20.10 Темпоральная модель

Три независимых временных слоя, все с `valid_from` / `valid_to`:

**1. Атрибуты (`osint_entity_attributes`).** Частичный
`UNIQUE (entity_id, attribute) WHERE valid_to IS NULL` — ровно одно открытое
значение на атрибут. `setAttribute`:

- значение не изменилось → открытая строка не трогается (кроме роста
  `confidence` максимумом);
- значение изменилось → старое получает `valid_to = validFrom`, новое
  открывается с `valid_from`.

Чтение: `readAttributes(db, id)` — только открытые;
`readAttributes(db, id, { asOf })` — срез на дату. Тест: «телефон на июнь
2026» возвращает старый номер, хотя сейчас в графе уже новый.

**2. Контекст источника (`osint_source_history`).** Каждая перезапись
`osint_source_context` закрывает предыдущий интервал и открывает новый со
снапшотом `{ field: { from, to } }`.

**3. Связи (`osint_entity_relations`).** `valid_from`/`valid_to`;
`closeRelation` закрывает открытую связь, `readRelations(..., { asOf })`
фильтрует по срезу.

`osint_facts` тоже хранит `valid_from`/`valid_to` — это тенант-скоуп-слой
нормализованных утверждений, а не глобальная временная истина.

### 20.11 Discovery traversal

`traversal.ts` — обход в ширину (§22) **только по локальным данным графа**:
`osint_entity_relations` → соседи, `osint_entity_sources` → источники,
`osint_observations` → наблюдения. Прямых `fetch(` в модуле нет —
проверяется тестом (§26).

```
frontier = [root]
while frontier:
    для каждого узла уровня:
        если visited >= maxEntities  → budget hit, стоп
        взять источники, выбрать наилучший tier (§24)
        взять наблюдения (лимит maxObservations)
        если depth < maxDepth: добавить соседей из relations в next
    frontier = next
```

Приоритет источников (`config.ts`, `TRAVERSAL_PRIORITY`), §24:

```
official_website → official_social → maps_and_directories → reviews → public_mentions
```

`priorityTierFor(type)` маппит тип источника на tier; шаг получает
наилучший tier среди своих источников, фронт сортируется по глубине, затем
по tier. Фиксирован конфигом, не разбросан по коду.

Персист в тенантский run: `runTraversal` пишет `depth`, `max_depth`,
`stats`, `root_entity_id` в `osint_discovery_runs`.

### 20.12 Бюджеты

`DEFAULT_DISCOVERY_BUDGET` (`config.ts`) — единый источник лимитов:

| Ключ | Значение | Область |
|---|---|---|
| `maxQueries` | 12 | discovery |
| `maxSearchResults` | 50 | discovery |
| `maxCandidates` | 30 | discovery |
| `maxPages` | 5 | discovery |
| `maxTotalBytes` | 2 000 000 | safe-fetch |
| `maxDurationMs` | 30 000 | discovery |
| **`maxDepth`** | **2** | **traversal (§21)** |
| **`maxEntities`** | **50** | **traversal (§23)** |
| **`maxSources`** | **40** | **traversal (§23)** |
| **`maxObservations`** | **200** | **traversal (§23)** |
| **`maxRequests`** | **40** | **traversal (§23)** |

Превышение фиксируется в `stats.budget_hits[]`
(`max_depth`, `max_entities`, `max_sources`, `max_observations`,
`max_requests`) — не выбрасывается молча, а видно в run'е.

### 20.13 Безопасность и SSRF

Единственная точка сетевого выхода OSINT-слоя — `safe-fetch.ts`:

1. DNS-резолв через инжектируемый `lookup` (в тестах подменяется);
2. проверка **всех** полученных IP: loopback, private (`10/8`, `172.16/12`,
   `192.168/16`), link-local `169.254/16` (включая cloud metadata
   `169.254.169.254`), IPv6 private/link-local, `localhost`;
3. запрет mixed-content (приватный + публичный IP в одном ответе);
4. **ручной** редирект: каждый хоп перепроверяется заново,
   `redirect: "error"` в самом fetch;
5. лимиты `maxTotalBytes` / `maxDurationMs`.

В `src/server/intelligence/osint/**` нет ни одного голого `fetch(`.

Юридические границы (§ «Юридические границы» документа) сохраняются: при
запрете автоматизации источник остаётся `disabled` или обслуживается через
официальный API.

### 20.14 Изоляция тенантов

**Инвариант:** *ни одна таблица без `business_id` не имеет FK на
`business`, `user` или тенантские таблицы.*

Доказательство — `tests/osint-tenant-isolation.test.mjs`:

- `information_schema.columns` — в публичном слое нет
  `business_id` / `candidate_business_id` / `decided_by_user_id` / `user_id`;
- `pg_constraint` — ни одного FK из публичного слоя в тенантский;
- каждая тенантская таблица обязана иметь `business_id`;
- private-поля (`client`, `lead`, `note`, `password`, `billing`,
  `telegram_user_id`) в OSINT-слое отсутствуют;
- прямой тест: run'ы, candidates, facts, findings двух тенантов не
  пересекаются, при этом оба ссылаются на одну и ту же публичную строку.

Распределение слоёв:

| Слой | Таблицы |
|---|---|
| **публичный** | `osint_entities`, `osint_sources`, `osint_observations`, `osint_entity_sources`, `osint_source_context`, `osint_source_history`, `osint_entity_mentions`, `osint_entity_relations`, `osint_entity_attributes` |
| **тенантский** | `osint_discovery_runs`, `osint_source_candidates`, `osint_business_entities`, `osint_facts`, `osint_competitor_candidates`, `osint_findings`, `osint_finding_evidence` |

Почему `osint_sources` **без** `discovery_run_id`: иначе глобальная таблица
получила бы FK на тенантский run, и tenant B вывел бы, кто первый нашёл
источник. Провенанс discovery остаётся в тенантском
`osint_source_candidates.discovery_run_id`.

### 20.15 Lifecycle

**Candidate** (тенант-скоуп):

```
          ┌──────────────► rejected  (score < candidateMinScore)
          │
 discovered ─► candidate  (ручная очередь, слабые совпадения)
          │
          └──────────────► accepted  (domain_exact | phone_plus_identity)
                                │
                                └─► osint_sources + osint_entity_sources
```

Статус монотонный: `persistCandidate` повышает статус только вперёд по
`rejected < candidate < accepted`.

**Discovery run:** `queued → running → completed | partial | failed`.
Захват — `WHERE status = 'queued'` с проверкой `numUpdatedRows` (антигонок).
«Зависшие» релизит `releaseStaleDiscoveryRuns` (`STALE_DISCOVERY_RUN_MS` =
15 мин).

**Source:** `active | paused | error | disabled` + `trust_level`
(`official | public_directory | review_platform | search_result | third_party`)
+ `origin` (`discovery | manual`).

**Business→entity bridge:** `candidate → linked | rejected`.

### 20.16 Future collectors (Этапы 5+)

Что уже законтрактовано и ждёт подключения:

| Что | Готово | Осталось |
|---|---|---|
| План обхода, глубина, бюджеты, приоритет | `traversal.ts` | вызов из runtime (сейчас только тесты), реальный fetch страниц |
| SSRF-защита и лимиты | `safe-fetch.ts` | — |
| Разбор HTML | — | **HTML-парсер** (§26: не добавлялся) |
| Наблюдения | таблица + `content_hash` | сервис сбора, парсер контента |
| Mentions/attributes из текста | `apply.ts` + deterministic | вызов из runtime (сейчас только тесты), выдача собранного текста в apply |
| AI-извлечение | контракт + заглушка | включить `enabled: true` + транспорт |
| Фоновый worker | — | `processOsintJobs` |
| Health-heartbeat `osint` | — | появится вместе с worker'ом |
| API/UI | `GET/POST .../intelligence/osint` + `OsintPanel` (§22.4) | отчёт Этапа 3 (§21) |
| Permissions `intelligence.manage` | union прав + `OsintService` (owner/admin) | — |

### 20.17 Решения: что и почему сделано иначе

| Решение | Причина |
|---|---|
| `070`, а не правка `069` | `migrate.ts:17` запрещает менять уже применённую миграцию; правильнее расширять последовательность ALTER'ами |
| Публичный слой без `business_id` | общий evidence для всех тенантов (§5); единственный мост — `osint_business_entities` |
| Дедуп **только** по `identity_key` | §12: имя коллизионно, мерж по нему создавал бы ложные сущности |
| `osint_sources` без `entity_id` и `discovery_run_id` | владение → `osint_source_context.known_owner_entity_id`, связи → `osint_entity_sources`, провенанс → тенантский candidate. Иначе — утечка тенанта в публичную таблицу |
| HTML-парсер **не добавлен** | §26: реального HTML-фетча на этом этапе нет, парсер без потребителя — мёртвый код |
| Health `names[]` **не трогался** | фонового OSINT-воркера нет; добавление имени дало бы `unavailable` и сломало health |
| `RELATED_TO`, а не `RELATED` | §6 даёт полный словарь из 13 типов; §8 использует сокращение — зафиксировано единое значение |
| AI — контракт + заглушка | §26: живые вызовы отключены (`enabled` по умолчанию `false`), транспорт инжектируется снаружи |
| `zod` в `dependencies` | контракт AI-ответа — часть runtime, транзитивной версии недостаточно |
| `osint_facts` остался тенантским | производные утверждения конкретного анализа; глобальная временная истина — `osint_entity_attributes` |
| Строки кодируются перед записью в `jsonb` | драйвер отдаёт примитивы как есть: строка `"73852551010"` уехала бы в базу числом и сломала сравнение значений |

### 20.18 Тесты и гейт Этапа 2 (knowledge graph)

| Файл | Что покрывает |
|---|---|
| `tests/osint-knowledge-graph.test.mjs` | общий entity между тенантами, запрет дедупа по имени, source memory + history, mention evidence + ownership guard, relation evidence + self-loop, temporal attributes с as-of, strong signals |
| `tests/osint-traversal.test.mjs` | остановка по `maxDepth`, бюджет `maxEntities`/`maxSources`, приоритет `official_website`, персист depth/stats в run, отсутствие `fetch` |
| `tests/osint-extraction.test.mjs` | zod-контракт (в т.ч. отказ на OWNER без явного evidence), deterministic-извлечение, AI-заглушка (off по умолчанию, битый JSON, transport error), `applyExtraction` |
| `tests/osint-tenant-isolation.test.mjs` | инвариант: нет тенантских колонок/FK в публичном слое, раздельность run/candidates/facts/findings, общий public evidence, отсутствие приватных полей |
| `tests/osint-discovery.test.mjs` | обновлён под глобальную модель: entity/source читаются через bridge и `entity_sources`, общий entity между тенантами при раздельных candidates |

Гейт: `typecheck` ✅ · `lint` ✅ · `npm test` 623/0 fail/11 skipped ✅ ·
`build` ✅ · `npm audit --omit=dev --audit-level=high` 0 vulnerabilities ✅.

---

## 21. Этап 3 — фундамент: evidence & intelligence (только контракты)

Контракты лежат в `src/lib/intelligence-contracts.ts` — **только типы**:
нет рантайма, нет HTTP-ручек, нет миграций, нет новых таблиц. Цель файла —
зафиксировать маппинг до того, как кто-нибудь начнёт реализацию.

### 21.1 Рамка этапа

Цепочка, которую закрывает Этап 3:

```
Observation → Evidence → Claim → Corroboration / Contradiction
                                   → Intelligence Profile → Report
```

Сознательно **не** входит в Этап 3: crawler, скрейпинг, LLM-агенты,
prediction / forecasting / sentiment / risk score, внешние провайдеры,
дорогие фоновые job'ы.

### 21.2 Маппинг контрактов на существующие таблицы

| Контракт | Таблица (уже существует) | Комментарий |
|---|---|---|
| `Evidence` | `osint_observations` + `osint_sources` | `source_id` NOT NULL (069) — провенанс на уровне схемы |
| `EvidenceSourceRef` | `osint_entity_mentions` / `osint_entity_attributes` / `osint_entity_relations.evidence` | хранится как ссылка + `evidence_kind` |
| `Claim` (state/metric/contact/identity) | `osint_facts` | `subject`, `predicate`, `value`, `source_observation_id` |
| `Claim` (relation) | `osint_entity_relations` | `from_entity_id`, `to_entity_id`, `relation_type`, `source_observation_id` |
| `Corroboration` | производный — group by `(subject, predicate, value)` | считается на чтение, не хранится |
| `Contradiction` | производный — group by `(subject, predicate)` с разным `value` | считается на чтение, не хранится |
| `IntelligenceProfile` | `osint_business_entities` (мост) + `osint_entities` + `osint_facts` | глобальный слой читается только через bridge |
| `Report` | read-only проекция | **не** хранится: копия данных = второй источник истины |

### 21.3 Инварианты, обязательные при реализации

1. Ни одного `Claim` без хотя бы одной `EvidenceSourceRef`.
2. `Evidence` всегда указывает на `source_id` — NULL запрещён схемой (069).
3. Fuzzy-совпадение **не** даёт права `auto-accept` (правило §12/§20.8).
4. `OWNER` / `PUBLISHED_BY` — только через `sameAs | rel_author | explicit_claim`.
5. Глобальные таблицы (`osint_entities`, `osint_sources`, `osint_observations`,
   `osint_entity_sources`, `osint_entity_attributes`, `osint_entity_relations`,
   `osint_entity_mentions`) не получают `business_id` и не читаются тенантом
   в обход `osint_business_entities`.
6. Дедуп сущностей — только по `identity_key`.
7. `Corroboration` / `Contradiction` считаются по числу **разных**
   `osint_sources.id`, а не наблюдений.
8. `Report.mode` наследует `IntelligenceDataMode` Day 1
   (`live | insufficient | demo`) — отчёт не выдаёт демо за живое.
9. Разрешение противоречий наследует словарь Stage 1
   (`prefer_newest | prefer_official | manual`), не «самое свежее выиграло».
10. Любое новое хранилище Claim/Contradiction обязано пройти тот же гейт:
    `schema → migration → service → integration → consumer → audit → tests`.

### 21.4 Сознательно не сделано (backlog перед полноценным Этапом 3)

- Никаких новых таблиц под Claim/Evidence/Contradiction/Report.
- Нет вычислителя `corroborationRatio` / `contradictionRatio` (нужен сервисный слой).
- Нет HTTP-ручек под Report.
- Нет worker'а, который бы пересчитывал профиль.
- `osint_facts`, `osint_findings`, `osint_finding_evidence`,
  `osint_competitor_candidates`, `osint_entity_attributes` по-прежнему
  **без** application-кода потребления (таблицы есть, читателей нет).

---

## 22. Ремонтный пасс аудита Stage 1/2

Гейт после пасса: `typecheck` ✅ · `lint` ✅ ·
`npm test` **649 / 638 pass / 0 fail / 11 skipped** ✅ · `build` ✅ ·
`npm audit --omit=dev --audit-level=high` **0 vulnerabilities** ✅.

Правило гейта capability: `schema → migration → service → integration →
consumer → audit → tests`. Ниже — только то, что не проходило.

### 22.1 Найденные дефекты

| # | Уровень | Место | Дефект | Статус |
|---|---|---|---|---|
| 1 | HIGH | `osint_sources.url_len` CHECK 2048 | `candidates.ts` вставлял необрезанный URL из SERP → reachable unique/CHECK violation | исправлено |
| 2 | MED | `releaseStaleDiscoveryRuns` | нет индекса `(status, started_at)` — оба существующих ведут с `business_id` → полный скан | исправлено (071) |
| 3 | HIGH | `persistCandidate` | `INSERT` без `onConflict` → `unique_violation` при параллельных run'ах | исправлено |
| 4 | HIGH | `osint_competitor_candidates.candidate_business_id` | `ON DELETE CASCADE` → удаление бизнеса B стирало строку тенанта A | исправлено (071) |
| 5 | HIGH | `osint_facts.source_observation_id` | `ON DELETE CASCADE` → удаление глобального наблюдения удаляло тенантский факт | исправлено (071 → `RESTRICT`) |
| 6 | HIGH | `osint_business_entities.entity_id` | `ON DELETE CASCADE` → удаление глобальной сущности удаляло тенантский мост | исправлено (071 → `RESTRICT`) |
| 7 | MED | `osint_competitor_candidates.entity_id` | `ON DELETE CASCADE` на глобальную сущность | исправлено (071 → `SET NULL`) |
| 8 | LOW | `osint_source_candidates.confidence` | Kysely-тип `string` вместо `Generated<string>` | исправлено |
| 9 | LOW | `osint_entity_attributes.value` | Kysely-тип `unknown` вместо `Generated<unknown>` | исправлено |
| 10 | HIGH | runtime | `runDiscovery` вызывался **только из тестов** — подсистема не была подключена к приложению | исправлено (§22.4) |
| 11 | MED | `permissions.ts` | `intelligence.manage` не существовало | исправлено |
| 12 | MED | UI | `/intelligence` был только в `SECONDARY_NAV_ITEMS`; desktop-пользователь не мог попасть на страницу; панели OSINT не было | исправлено |
| 13 | LOW | тесты | из 11 инвариантов 2 отсутствовали полностью, 0 тестов на отклонение DB-ограничений, 0 HTTP-тестов intelligence/osint | закрыто частично (§22.6) |
| 14 | LOW | runtime | `buildTraversalPlan` / `runTraversal` / `applyExtraction` — runtime готов и покрыт тестами, но production-потребителя по-прежнему нет | **не исправлено** — категория C (§22.6); подключить их = новое поведение, а не ремонт |

### 22.2 Изменённые файлы

| Файл | Изменение |
|---|---|
| `migrations/071_osint_repair_v1.sql` | **новый** — индекс + 4 FK-семантики удаления; без `;` в строках/комментариях (`migrate.ts:21` режет по `;`), без правки применённых миграций (`migrate.ts:17` checksum-guard) |
| `src/server/access/permissions.ts` | `intelligence.manage` в union прав; **не** в `operatorPermissions` → owner/admin |
| `src/server/intelligence/osint/classifier.ts` | `classifyResult` отклоняет `normalized.url.length > 2048` → `{ok:false, reason:"url_too_long"}` |
| `src/server/intelligence/osint/candidates.ts` | хелперы `readExisting()`/`reuse()`, `onConflict((oc) => oc.columns(["business_id","normalized_url"]).doNothing())` + re-select по `numInsertedOrUpdatedRows`, `url.slice(0, 2048)` |
| `src/server/intelligence/osint/schema.ts` | `confidence` и `value` → `Generated<>` |
| `src/server/intelligence/osint/providers/own-urls.ts` | **новый** провайдер `own_urls`: `requiresNetwork:false`, `policy:"structured_data"`, `enabledByDefault:true`; эмитит `profile.website`, `https://<domain>/` и `knownSocialLinks` ровно один раз за run |
| `src/server/intelligence/osint-service.ts` | **новый** сервисный слой: `getSnapshot` (право `analytics.view`), `startDiscovery` (право `intelligence.manage`, `releaseStaleDiscoveryRuns` перед стартом) |
| `src/server/http/intelligence-handler.ts` | `intelligenceOsintSnapshotHandler`, `intelligenceOsintDiscoveryHandler` (`requireOrigin` + `limit(db, secret, …, 5, 60)`) |
| `src/app/api/v1/businesses/[id]/intelligence/osint/route.ts` | **новый** `GET` |
| `src/app/api/v1/businesses/[id]/intelligence/osint/discovery/route.ts` | **новый** `POST` |
| `src/services/intelligence.service.ts` | `getOsintSnapshot`, `startOsintDiscovery` |
| `src/lib/intelligence-types.ts` | wire-типы `OsintProviderInfo`, `OsintRunInfo`, `OsintCandidateInfo`, `OsintEntityInfo`, `OsintSourceInfo`, `OsintSnapshot`, `OsintDiscoveryRunOutcome` |
| `src/lib/intelligence-contracts.ts` | **новый** — контракты Этапа 3 (§21) |
| `src/components/intelligence/OsintPanel.tsx` | **новый** — счётчики, запуски, кандидаты, сущности, источники, кнопка «Запустить сбор» |
| `src/components/intelligence/IntelligenceCommandCenter.tsx` | `<OsintPanel businessId={…}/>` после блока `overview` |
| `src/components/layout/AppShell.tsx` | иконка `Brain` → `/intelligence` рядом с `/analytics` в desktop topbar |

### 22.3 Миграция 071

Шаги: (1) `osint_discovery_runs_status_started_idx (status, started_at) WHERE started_at IS NOT NULL`;
(2) `osint_facts.source_observation_id` → `RESTRICT`;
(3) `osint_business_entities.entity_id` → `RESTRICT`;
(4) `osint_competitor_candidates.entity_id` → `SET NULL`;
(5) `osint_competitor_candidates.candidate_business_id` → `SET NULL`.

Принятое правило удаления: глобальный слой каскадится внутри себя;
граница «тенант ← глобал» — `NOT NULL` → `RESTRICT`, NULLable → `SET NULL`;
удаление одного бизнеса не должно трогать строки другого тенанта.

### 22.4 Runtime-цепочка

```
POST /api/v1/businesses/:publicId/intelligence/osint/discovery
  → requireUser (session + rate limit)  → requireOrigin + limit(5, 60)
  → OsintService.startDiscovery(userId, publicId)
      → requireBusiness(…, "intelligence.manage")   404 чужой / 403 нет прав
      → releaseStaleDiscoveryRuns(db)
      → runDiscovery(db, { businessId, userId, registry })
          → buildDiscoveryProfile / buildDiscoveryQueries
          → providers (own_urls — без сети)
          → classifyResult → persistCandidate (onConflict) → ensureEntity (мост)
          → intelligence_audit_log (operation "osint.discovery.run")
  → OsintDiscoveryRunOutcome (201)

GET  /api/v1/businesses/:publicId/intelligence/osint
  → requireBusiness(…, "analytics.view") → OsintSnapshot
```

Права: чтение — `analytics.view` (owner/admin/operator/…), запуск —
`intelligence.manage` (только owner/admin). UI: `OsintPanel` на
`/intelligence`, вход через desktop topbar (`AppShell`).

### 22.5 Новые тесты (+24)

| Файл | Покрытие |
|---|---|
| `tests/osint-repair-invariants.test.mjs` (10) | провенанс observation→source + `NOT NULL` rejection; остановка traversal на цикле `A→B→C→A` без повторов; budget hits `max_requests`/`max_observations`; `maxSearchResults` → `partial`; abort → `aborted_by_caller`; упавший run → `intelligence_audit_log` с `result="failed"`; read-back провенанса relation + запрет NULL; дедуп по `identity_key` при одинаковом имени; ownership-guard `PUBLISHED_BY`; `url_too_long` в `classifyResult` |
| `tests/osint-constraints.test.mjs` (10) | отклонения БД: дубль `osint_sources.normalized_url`, дубль `osint_entities.identity_key`, дубль `osint_observations (source_id, content_hash)`, неизвестный `source_id` (FK), self-relation `CHECK`, дубль relation `UNIQUE`, дубль `osint_entity_mentions` span, дубль `osint_facts`, тенантские строки переживают удаление глобального источника, удаление бизнеса B не трогает строку тенанта A |
| `tests/osint-integration.test.mjs` (5) | `own_urls` эмитит URL один раз за instance; owner запускает сбор и читает snapshot (`providers`, counts, root entity); snapshot бизнеса B не утекает данные A; operator читает, но не запускает (`FORBIDDEN` 403), `allowed("operator","intelligence.manage") === false`; не-участник получает `BUSINESS_NOT_FOUND` 404 |

Было 624 теста (613 pass / 0 fail / 11 skipped) → стало 649
(638 pass / 0 fail / 11 skipped).

### 22.6 Честно: что осталось закрытым

- **HTTP-тестов intelligence/osint нет** — `tests/osint-integration.test.mjs`
  покрывает сервисный слой, не `route.ts`. `tests/http/*` требует
  `TEST_DATABASE_URL` и в этот гейт не входит.
- `osint_facts`, `osint_findings`, `osint_finding_evidence`,
  `osint_entity_attributes`, `osint_competitor_candidates` — таблицы есть,
  application-кода потребления по-прежнему нет.
- `buildTraversalPlan` / `runTraversal` / `applyExtraction` — модули рабочие и
  покрыты тестами, но их не вызывает ни один production-код (единственный
  runtime-вход в OSINT — `runDiscovery` через `OsintService`). Подключить их =
  новое поведение, поэтому это категория C, а не ремонт (§22.1, дефект 14).
- `processOsintJobs` (background worker) и health-heartbeat `osint` не делались.
- Deep fetch, реальные провайдеры, AI-классификация (`src/server/ai/osint.ts`)
  остаются отключёнными (`enabled:false` по умолчанию).
- Кросс-тенантного read-only пути в `OsintService` нет: глобальный слой
  читается только через `osint_business_entities`.
