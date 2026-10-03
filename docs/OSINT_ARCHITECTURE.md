# OSINT-разведчик бизнеса — архитектура (Этап 1: аудит)

> **Обновлено миграцией `075_osint_research_agent_v1.sql`.** Поверх описанной
> ниже модели Research Passport добавлен автономный **Research Agent**: он сам
> строит идентичность, порождает гипотезы и запросы, оценивает следующее
> действие, обходит недоступные источники и умеет остановиться. Архитектура,
> границы безопасности, термины (source / observation / fact / inference /
> hypothesis / contradiction) и ограничения описаны в
> [`OSINT_RESEARCH_AGENT.md`](./OSINT_RESEARCH_AGENT.md).
> Миграции 069–074 при этом не тронуты — модель паспорта остаётся рабочей.

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

---

## 23. Stage 3 runtime v1 — первый вертикальный slice

Цепочка: **Stage 2 observation → Evidence → Claim → Provenance.**

### 23.1 Что реализовано

| Шаг | Модуль | Что делает |
|---|---|---|
| Tenant scope | `osint-service.ts` → `explainObservation` | `requireBusiness(…, "analytics.view")` + запрос наблюдения только через тенантский мост `osint_business_entities` (`status <> 'rejected'`) либо `osint_entity_sources` → мост. Иначе 404 `OBSERVATION_NOT_FOUND` — без утечки факта существования чужой строки |
| Evidence adapter | `osint/evidence.ts` → `toEvidence` | `osint_observations` → `Evidence` без копий: `id`, `sourceId`, `content`, `contentHash`, `observedAt`, `entityId` берутся как есть. Битые даты/хэш → 422 `MALFORMED_OBSERVATION` |
| Kind guard | `osint/evidence.ts` → `assertClaimSupportedKind` | вид вне поддерживаемого набора → 422 `UNSUPPORTED_OBSERVATION_KIND`, а не пустой «тихий» результат |
| Claim extraction | `osint/claims.ts` → `extractClaims` | детерминированная экстракция через существующий `extractDeterministic` Stage 2. Словарь предикатов — ровно `EXTRACTABLE_ATTRIBUTES`; `kind` мапится в `identity`/`contact`/`state` |
| Stable identity | `osint/claims.ts` → `stableClaimId` | UUID из SHA-256 `(business, subject, predicate, observation, value)` — повторная проекция даёт байт-в-байт тот же результат |
| Provenance | `Stage3Provenance` | `claimId`, `evidenceRef` (дословный `textSpan` + `evidenceKind` + `confidence`), `observationId`, `sourceId` — цепочка Claim → Evidence → Observation → Source |
| API | `GET …/intelligence/osint/observations/:observationId` | handler `intelligenceOsintObservationHandler` → `OsintService.explainObservation` |
| Наполнение | `osint/observations.ts` → `ensureObservation` | production writer, вставлен в существующий discovery (§23.3) — без него Stage 3 нечего объяснять |

Права — те же, что у snapshot: чтение `analytics.view` (owner/admin/operator).
Аудит на read не пишется — как и `getSnapshot` в Stage 2.

### 23.2 Что сознательно НЕ реализовано

- **persistence отсутствует намеренно**: ни одной новой таблицы, ни одной
  миграции. Stage 3 — read-model поверх Stage 2; `Claim` нигде не хранится.
  (Сами `osint_observations` пишет Stage 2 — см. §23.3; это не persistence
  Stage 3.)
- **Extraction детерминированная, LLM не вызывается.** Излечение идёт
  **только из текста самого наблюдения** — поэтому `textSpan` всегда лежит
  внутри `Evidence.content` и трассировка честна. Атрибуты, которые
  `extractDeterministic` берёт из `DiscoveryProfile` (city/address/category),
  сюда не попадают: их значение не гарантировано присутствовать в наблюдении,
  и `textSpan` для них был бы непроверяемым.
- Внешние providers, crawler, scraping, review collection, embeddings,
  vector DB, forecasting, prediction, sentiment, risk score, autonomous
  agents, очереди, workers, новые внешние API — не подключались.
- UI не менялся: slice закрыт серверным кодом + тестами.
- `Corroboration` / `Contradiction` / `IntelligenceProfile` / `Report`
  не вычисляются — это следующие слои (§21.4).
- `ClaimKind` `metric` и `relation` в v1 не порождаются: `metric` требует
  числовых показателей, `relation` — `osint_entity_relations`.

### 23.3 Какой pipeline создаёт observation (gap закрыт)

Раньше здесь был gap: в `src/**` не существовало ни одного
`insertInto("osint_observations")`, поэтому production-счётчик наблюдений был
равен нулю, хотя вся остальная цепочка Stage 2 работала. Писатель добавлен в
существующий discovery-pipeline, новый crawler/provider/очередь не заводились.

#### Фактический data flow

```
input: профиль бизнеса (name, description, contact_info, website)
  ↓ buildDiscoveryQueries(profile)
provider.search(...)                     — в production это только own_urls
  ↓ результат {url, title, snippet, position}
classifyResult(...)                      → ClassifiedCandidate
  ↓
persistCandidate(...)                    → osint_source_candidates  (тенант)
  ↓ status === "accepted"
ensureSource(...)                        → osint_sources            (глобал)
attachCandidateSource(...)               → candidates.source_id
  ↓
ensureObservation(...)                   → osint_observations       ← ДОБАВЛЕНО
```

#### Где именно выполняется writer

`src/server/intelligence/osint/observations.ts` → `ensureObservation()`,
вызов добавлен в `discovery.ts` в ветку `outcome.status === "accepted"`
(`handleOutcome`), сразу после `ensureSource` + `attachCandidateSource`.

Место выбрано не «где проще вставить INSERT», а структурно вынужденно:
`osint_observations.source_id` — `NOT NULL` (069), а единственный код,
создающий `osint_sources`, — `ensureSource()`, и вызывается он ровно оттуда.
Наблюдение без источника схема физически не принимает.

#### Какие данные являются источником

Ровно то, что провайдер вернул по URL: `title`, `snippet` и сам `url`,
склеенные переводом строки (`observationContent()`). Ничего не выдумывается —
ни значений профиля, ни содержимого страницы (discovery страницы не читает,
это делают коллекторы Этапов 5+). URL входит в content осознанно: так же
«наблюдаемым материалом» его уже считает `scoreCandidate()` Stage 2
(`entity-resolution.ts`, `title + snippet + url`), поэтому семантика не
изобретается заново.

- `kind` — `search_result`: discovery наблюдает **результат провайдера**, а не
  содержимое страницы. `page`/`review`/`post`/`listing` появятся, когда
  коллекторы начнут реально читать страницу.
- `metadata` — только глобальная лексика `{provider, discovery_method}`.
  `discovery_run_id` / `business_id` / `query` / `position` в публичный слой
  **не кладутся**: правило 070 (не светить, кто первый нашёл источник).

#### Idempotency

`content_hash = sha256(content)` (64 hex, лимит 1..128 из 069) + уже
существующий `UNIQUE (source_id, content_hash)` из 069. Вставка идёт через
`ON CONFLICT (source_id, content_hash) DO NOTHING`; при гонке двух run'ов
строка читается обратно. Повторный discovery того же профиля не плодит
наблюдений. `external_id` не заполняется: `ClassifiedCandidate` его не несёт,
а для идемпотентности он не нужен — хэша достаточно.

#### Tenant isolation

`osint_observations` глобальна (070 убрал `business_id`), поэтому граница
проверяется явно, до записи:

1. существует ли мост `osint_business_entities (businessId, entityId)` со
   `status <> 'rejected'` — иначе `skipped: "tenant_bridge_missing"`;
2. привязан ли источник к этой сущности через `osint_entity_sources` — иначе
   `skipped: "source_not_linked_to_entity"`.

Оба условия обязаны выполняться — запись «tenant A → observation →
entity/source tenant B» невозможна. `entityId` приходит из `ensureEntity()`
для самого тенанта, так что на практике guard ловит именно ошибочное
перекрёстное использование API.

#### Как observation становится доступен Stage 3

Без нового формата провенанса, цепочкой Stage 2:

```
observation.source_id   → osint_sources        (provider, normalized_url)
observation.entity_id   → osint_entities       → мост → бизнес
candidate.source_id     → osint_source_candidates (tenant: business_id,
                                                   discovery_run_id, query,
                                                   search_position)
```

Дальше `GET …/osint/observations/:id` → `explainObservation()` →
`Evidence` → `Claim` → `Provenance` (§23.1) — читается тем же запросом, что и
в Stage 3 v1, без правок.

#### Известное ограничение (честно)

Наблюдение появляется **только для auto-accept кандидата**, потому что
источник Stage 2 создаёт только для него. Замер на продовом провайдере
`own_urls` (детерминированный, без сети):

| Профиль | score | исход | наблюдений |
|---|---|---|---|
| имя + город + телефон + сайт | 0.444 | `accepted (domain_exact)` | **1** |
| только имя + сайт | 0.889 | `accepted (domain_exact)` | **1** |
| + соцсеть в описании | 0.400 | `accepted (domain_exact)` | **1** |
| то же + строка «ул. Ленина, 10» | 0.381 | `candidate` (порог 0.40 не взят) | **0** |
| без сайта/доменов/соцсетей | — | `own_urls` не вернул результатов | **0** |

Порог `domain_exact` (`score >= 0.40`) и веса признаков — замороженная
логика entity resolution Stage 2 (§4), она не менялась. Наблюдение без
источника создать нельзя (`source_id NOT NULL`), поэтому кандидат в ручной
очереди наблюдения не даёт. Закрытие этого ограничения — отдельное решение
(ручной accept кандидата либо скоринг), не часть gap closure.

Ни одна production-строка не создавалась вручную: наблюдения появляются
только через реальный discovery-run.

### 23.4 Тесты

`tests/osint-stage3-runtime.test.mjs` (5) — все проходят на реальных строках
Stage 2, вставленных в PGlite с настоящими ограничениями/FK:

| # | Проверка |
|---|---|
| 1 | валидное наблюдение → Evidence + Claim + provenance; `textSpan` лежит в `Evidence.content`; `provenance.sourceId === evidence.sourceId === source.id` |
| 2 | пустое содержимое → 200 с `claims: []` + `reason: "no_extractable_claims"`; наблюдение без пути до тенанта → 404 |
| 3 | cross-tenant: B не читает наблюдение A зная UUID; не-участник → `BUSINESS_NOT_FOUND` |
| 4 | три проекции подряд `deepEqual`, id уникальны; `stableClaimId` стабилен и чувствителен к value |
| 5 | вид вне набора → 422; битые данные → 422 `MALFORMED_OBSERVATION`; малформенный/несуществующий id → 404 |

Мутационная проверка (файлы восстановлены): снят тенант-скоуп → падают 2 и 3;
`createdAt = now()` → падает 4; `provenance.observationId = source_id` или
снят `textSpan` → падает 1.

`tests/osint-observation-writer.test.mjs` (5) — gap closure (§23.3); наблюдения
создаёт сам discovery, включая боевой провайдер `own_urls`:

| # | Проверка |
|---|---|
| 1 | реальный Stage 2 flow (`own_urls` → source/entity) пишет observation: `content_hash = sha256(content)`, `kind`, `url`, `metadata.provider`, в `metadata` нет `discovery_run_id`/`business_id`; плюс пиннинг ограничения — профиль со строкой адреса даёт `candidate`, не `accepted`, и наблюдения нет |
| 2 | повторный discovery не растит счётчик; прямой повторный `ensureObservation` → `created:false` + тот же id; другой материал того же источника → новая строка |
| 3 | tenant A → entity/source tenant B → `tenant_bridge_missing`; источник без связи с entity → `source_not_linked_to_entity`; строк не добавлено; B не читает наблюдение A |
| 4 | цепочка observation → source → entity → `osint_entity_sources` → мост → тенант; `candidate.discovery_run_id === run.runId` |
| 5 | `explainObservation()` над writer-наблюдением → Evidence + Claims (`website`, `phone`) + Provenance; `textSpan` подстрока `Evidence.content`; повторный вызов `deepEqual` |

Мутационная проверка writer'а (файлы восстановлены): снят tenant-guard →
падает 3; снят `ON CONFLICT` → падают 2 и 5; убран вызов `ensureObservation`
из discovery → падают 1, 2, 4, 5; из content убран URL → падают 1 и 5;
`entity_id = null` → падают все пять.

---

## 24. Stage 3 runtime v2 — corroboration / contradiction / claim assessment

Цепочка: **`Evidence[]` → `Claims[]` → grouping → оценка → объяснимый
результат.** Это закрывает пункт §23.2 («`Corroboration` / `Contradiction`
не вычисляются»).

### 24.1 Что реализовано

| Шаг | Модуль | Что делает |
|---|---|---|
| Tenant scope | `osint-service.ts` → `tenantScope` | **Один** приватный предикат, которым теперь пользуются и `explainObservation` (v1), и `assessObservations` (v2): глобальное `osint_observations` читается только через тенантский мост `osint_business_entities` (`status <> 'rejected'`), либо через `osint_entity_sources` → мост |
| Bulk чтение | `assessObservations` | одним запросом (`LEFT JOIN LATERAL`) возвращает наблюдение + субъект, выбранный **тем же ранжированием**, что и в v1 (прямая привязка → `status = 'linked'` → свежайший мост). Лимит `ASSESSMENT_LIMIT = 200` — полного скана нет |
| Сбор claims | `assessObservations` | те же `toEvidence` + `extractClaims`, что и в v1. Битая строка, неподдерживаемый `kind`, отсутствие субъекта или пустая экстракция → строка попадает в `skippedObservations`, а bulk не падает 503 |
| Оценка | `osint/assessment.ts` → `assessClaims` | **чистая функция**: ни сети, ни персистентности, ни `now()`. Группировка → нормализация → правила → `Stage3Assessment` |
| Таблица сравнения | `CLAIM_COMPARISON_TABLE` | закрытый набор predicate'ов, для которых равенство значений безопасно (§24.2); ключи сверяются с `EXTRACTABLE_ATTRIBUTES` при загрузке модуля |
| Grouping | `assessClaims` | ключ — **точный** пар `(subject, predicate)`. Нечёткого merge нет: «похожая строка» не делает два утверждения одним |
| Provenance | `Stage3Provenance[]` на группу | каждый claim трассируется до своего `observationId` и `sourceId`; контракт `intelligence-contracts.ts` **не менялся** |
| API | `GET …/intelligence/osint/assessment` | handler `intelligenceOsintAssessmentHandler` → `OsintService.assessObservations`. Права — те же, что у v1: чтение `analytics.view` |

Типы ответа (`Stage3Assessment`, `Stage3AssessmentGroup`,
`Stage3AssessmentRule`, `Stage3AssessmentGap`, `Stage3Independence`)
добавлены в `src/lib/intelligence-types.ts` — там же, где v1 держит
`Stage3ObservationSlice`. Внутри группы переиспользуются контрактные
`Corroboration` и `Contradiction` без модификаций.

### 24.2 Фактические predicates и что безопасно сравнивать

Словарь Stage 1 (`EXTRACTABLE_ATTRIBUTES`, 13 позиций): `name`, `phone`,
`website`, `address`, `email`, `city`, `region`, `country`, `category`,
`description`, `social_links`, `coordinates`, `working_hours`.

**Что Stage 3 v1/v2 реально создаёт.** `extractClaims` вызывает
`extractDeterministic({ text })` **без** `profile` и **без**
`knownEntityName`, поэтому ветка профиля (`deterministic.ts`,
`if (input.profile)`) не исполняется. Из текста наблюдения рождаются ровно
три predicate'а:

| predicate | как нормализуется | `valueKind` | уверенность |
|---|---|---|---|
| `phone` | `normalizePhone` → цифровая строка (`73852551010`) | `string` | 0.95 |
| `email` | `toLowerCase` | `string` | 0.95 |
| `website` | `registrableDomain(host)` | `string` | 0.9 |

`name` / `city` / `address` / `category` сегодня в Stage 3 не появляются
вообще; `description`, `social_links`, `coordinates`, `working_hours` из
текста не извлекаются.

**Таблица безопасного сравнения** (`CLAIM_COMPARISON_TABLE`):

| predicate | нормализация при сравнении | почему сравним |
|---|---|---|
| `phone` | `replace(/\D/g, "")` | цифры; `normalizePhone` уже каноничен, формат записи не важен |
| `email` | trim + схлопывание пробелов + lower | формат адреса |
| `website` | trim + lower + снятие конечных точек | домен |
| `name`, `city`, `region`, `country` | схлопывание пробелов + casefold | текст, где регистр/пробельные различия не меняют смысл |

**Сознательно `not_assessed`:**

| predicate | почему |
|---|---|
| `address` | форматы не унифицированы («ул. Ленина, 10» vs «улица Ленина, 10») — без парсера равенство врёт |
| `category` | несколько категорий одновременно не противоречат друг другу |
| `description`, `working_hours` | свободный текст; разные формулировки ≠ разные факты |
| `social_links`, `coordinates` | список и числовая точность |
| любой predicate вне таблицы | не изобретаем семантику постфактум |
| `value === null` или `valueKind !== "string"` | неизвестное значение не должно становиться подтверждением |

Смесь сравнимых и несравнимых значений в одной группе тоже даёт
`not_assessed` + gap `value_not_comparable`: молча выбрать «правильную»
часть — ровно та неоднозначность, которую §5 запрещает разрешать.

### 24.3 Правила оценки

Правила применяются по порядку, первое сработавшее и становится `rule`:

| `rule` | условие | что отдаётся |
|---|---|---|
| `missing_provenance` | ни у одного claim группы нет проверяемой цепочки Observation → Source **в этом тенанте** | `corroboration: null`, `contradictions: []`, gap `missing_provenance` |
| `not_assessed` | predicate вне таблицы сравнения, либо значения несравнимы | `corroboration: null`, `contradictions: []`, gap `predicate_not_comparable` / `value_not_comparable` |
| `single_observation` | меньше двух разных `observation_id` | `corroboration: null`, gap `insufficient_observations` |
| `value_mismatch` | есть два наблюдения с **непересекающимися** множествами значений | `Contradiction` с `resolution: "unresolved"`, `status: "unresolved"`, gap `no_temporal_semantics` |
| `single_source` | значение едино, источников один | `corroboration: null` |
| `distinct_sources` | значение едино, источников ≥ 2 | `Corroboration` |

Правила корроборации и противоречия (§4):

1. **Одно наблюдение не подтверждает само себя** — bucket требует
   ≥ 2 разных `observation_id`. Повторная проекция того же наблюдения
   счётчик не растит: claims дедуплицируются по `id`.
2. **Один source с несколькими observations ≠ несколько источников** —
   `distinctSourceCount` считает **разные** `osint_sources.id`.
   Такой случай получает `single_source`, а не `Corroboration`.
3. **`Corroboration.confidence` — не новая оценка.** Это
   `min(confidence)` входящих claims, то есть пол детерминированного
   извлечения. Вероятность истинности не вычисляется и не выдаётся.
4. **`independence` всегда `"unknown"`.** Разные `source_id` доказывают
   *разнообразие* источников, но не их независимость: владельцы могут
   совпадать, а данных об этом в Stage 1/2 нет. Пол `"established"`
   зарезервирован и сегодня намеренно не достигается; на это указывает
   gap `source_independence_unknown`.
5. **Конфликт определяется как отсутствие общего значения.** Противоречие
   объявляется, только если существуют два наблюдения, у которых нет ни
   одного общего нормализованного значения. Это сознательно
   консервативно: один source может легально перечислить два телефона, и
   это не спор между источниками — пока у всех есть общее значение,
   `Contradiction` не создаётся.
6. **Временная изменчивость не разрешается.** У Stage 3 `validTo = null`,
   то есть temporal semantics нет. Поэтому `resolution` и `status`
   всегда `"unresolved"` — «предпочесть более новое» было бы категорическим
   выводом без данных.

Детерминизм (§8):

- `Contradiction.id` — SHA-256 от `(business, subject, predicate,
  отсортированных нормализованных значений)` с выставленными
  version/variant битами;
- `Contradiction.detectedAt` — момент **последнего вошедшего наблюдения**,
  а не `now()`: повторный запуск того же входа даёт тот же ответ;
- все массивы (`groups`, `observations`, `sources`, `provenance`,
  `sides`, `gaps`) отсортированы локально-независимым сравнением
  (без `localeCompare`);
- входные `Claim` не мутируются — нормализация живёт только во внутренних
  ключах bucket'ов, отданное значение остаётся исходным.

Изоляция (§7): чужие `claim.businessId` отбрасываются до группировки и не
создают групп; `provenance`-карта строится только из строк, прошедших
тенантский scope, поэтому чужой `observation_id` в неё не попадает.

### 24.4 Что сознательно НЕ реализовано

- **Persistence отсутствует намеренно**: ни одной новой таблицы, ни одной
  миграции. Оценка — read-model, повторный вызов пересчитывает её заново.
- `intelligence-contracts.ts` **не изменялся**: `Corroboration`,
  `Contradiction`, `Claim`, `Evidence`, `EvidenceSourceRef` используются
  как есть. Объяснение к оценке живёт в группе-обёртке
  (`Stage3AssessmentGroup`), а не в виде второго набора типов.
- Числовой `confidence` оценки не вводился: у `Corroboration` это поле
  контрактное, и его значение — пол извлечения входящих claims (§24.3.3).
- LLM, embeddings, vector DB, sentiment, business risk score, прогнозы,
  автопринятие решений, crawler/scraping, новые providers, новые
  workers/очереди — не подключались.
- Запись результата в `osint_facts` / `osint_entity_relations` не
  выполняется: это отдельное решение с отдельной миграцией.
- Разрешение противоречий (`prefer_newest` / `prefer_official` /
  `manual`) не применяется — нет temporal semantics (§24.3.6).
- UI не менялся: slice закрыт серверным кодом + тестами.

### 24.5 Тесты

`tests/osint-stage3-assessment.test.mjs` (14, все проходят) — часть кейсов
на реальных строках Stage 2 в PGlite, часть на чистой функции `assessClaims`:

| # | Проверка |
|---|---|
| 1 | два источника с одним значением → `distinct_sources` + `Corroboration` (`distinctSourceCount = 2`), `independence = "unknown"`, gap `source_independence_unknown`; `confidence = min(...)`; каждый claim трассируется своим `observationId`/`sourceId` |
| 2 | одно наблюдение → `single_observation`, ничего не подтверждено, gap `insufficient_observations` |
| 3 | один source с двумя observations → `single_source`, `distinctSourceCount = 1`, `corroboration: null` |
| 4 | два источника, разные значения `phone` → `value_mismatch`, `Contradiction` с двумя `sides` |
| 5 | временно изменчивый `phone` → `resolution`/`status` = `unresolved`; `detectedAt` равен максимуму `observed_at` из данных, а не текущему времени; `id` — UUID |
| 6 | один source с двумя телефонами + второй source с одним из них → **нет** противоречия (непересекающееся значения), `distinct_sources` |
| 7 | разные `subject` → две группы, `Contradiction` между ними не создаётся |
| 8 | predicate вне словаря → `not_assessed` + gap `predicate_not_comparable` |
| 9 | прямой и реверсированный порядок входа дают `deepEqual`; входные `Claim` не мутируют; `Contradiction.id` совпадает |
| 10 | cross-tenant: `observationCount = 1`, чужой source/значения не попадают; не-участник → `BUSINESS_NOT_FOUND`; claim чужого `businessId` не создаёт группу |
| 11 | бизнес без наблюдений → `reason: "insufficient_evidence"`, `groups: []` |
| 12 | claim без проверяемой цепочки → `missing_provenance`, `corroboration: null`, `claimCount = 0`; та же группа с рабочей цепочкой даёт подтверждение |
| 13 | три claim из одного observation (+ точный дубль `id`) → `claimCount` схлопнут, `distinctObservationCount = 1`, `single_observation`, `corroboration: null` |
| 14 | наблюдение с `content_hash = " "` (проходит CHECK, но `toEvidence` отвечает 422) → `skippedObservations = 1`, endpoint не падает 503, валидное наблюдение обработано |

Мутационные проверки (файлы восстановлены, каждая даёт ≥ 1 падение):

| # | Мутация | Падает |
|---|---|---|
| A | `independence: "established"` | 1 |
| B | конфликт = «≥ 2 значения» вместо непересекающихся множеств | 6 |
| C | `Corroboration` уже при одном источнике | 3 |
| D | `detectedAt = now()` | 5 |
| E | снят фильтр провенанса | 12 |
| F | `resolution: "prefer_newest"` | 5 |
| G | снят тенант-скоуп в bulk-запросе | 1, 4, 10 |
| H | grouping только по `predicate` (без `subject`) | 7 |
| I | снят фильтр чужого `businessId` | 10 |
| J | снят дедуп claim по `id` | 13 |
| K | `sortedUnique(observations)` → без уникальности | 13, 14 |
| L | снят `try/catch` вокруг `toEvidence` (bulk падает 422/503) | 14 |

### 24.6 Честно: что не проверено (Stage 3 v2)

> Пункты «Реальная PostgreSQL не проверялась» и «HTTP-ручка не покрыта
> HTTP-тестами» ниже закрыты в §24.7 (интеграционное покрытие). Остальные
> ограничения раздела действуют.

- **Реальная PostgreSQL не проверялась.** `TEST_DATABASE_URL` в этом окружении
  не задан, поэтому все тесты Stage 3 (и v1, и v2) шли на **PGlite** —
  встроенном in-process Postgres-совместимом движке. Ограничения, FK и
  CHECK у PGlite настоящие, но семантика настоящего сервера PostgreSQL
  (блокировки строк, `NULL`-уникальность, конкуренция соединений) не
  воспроизводилась.
- **11 skipped в `npm test` — не Stage 3.** Это тесты конкуренции
  (`booking`, `hardening-pre-e2e`, `identity-workspaces` и др.), которым
  нужны отдельные соединения к `TEST_DATABASE_URL`. Ни один тест Stage 3
  не пропущен: 14/14 у v2 и 5/5 у v1 выполняются.
- **HTTP-ручка не покрыта HTTP-тестами** — как и весь intelligence/osint
  (§22.6): `tests/osint-stage3-assessment.test.mjs` проверяет сервисный
  слой `OsintService.assessObservations`, а не `route.ts`.
  `tests/http/*` требует `TEST_DATABASE_URL`.
- Оценка **не устанавливает истинность claims** и не выдаёт вероятность:
  `Corroboration.confidence` — пол извлечения, `independence` — всегда
  `"unknown"`, `Contradiction` всегда `unresolved`.

### 24.7 Интеграционное покрытие и сериализация JSONB (freeze audit)

**Почему PGlite не выявил дефект сериализации.** Драйвер `pg` при записи
значения в колонку `jsonb` проходит через `prepareValue`: объект уходит в
`JSON.stringify` (`prepareObject`), а **массив — в литеральный
постгресовский массив** `{a,b}`. Пустой массив становится `{}`, непустой —
`invalid input syntax for type json` (`22P02`). PGlite использует собственную
сериализацию, где массив корректен, поэтому все Stage 2/3 тесты на PGlite
проходили, а реальная PostgreSQL 17 отказывала уже на первом
`ensureBusinessEntity` (`entity-graph.ts` → `aliases`). Локальные юниты
ловят семантику и ограничения, но не сериализацию провайдера — разрыв
закрывается только прогоном против настоящего сервера.

**Почему введён `jsonbArray()`.** Явное кодирование массива в JSON-строку до
отправки в `pg` — единственный способ корректно записать массив в `jsonb`.
Helper в `src/server/intelligence/osint/schema.ts` возвращает
`JSON.stringify(value ?? [])` с типовым приведением к `string[]`, чтобы не
менять Kysely-типы колонок: чтение не затронуто, деградации
(`null/undefined` → `[]`) нет. Это не новый паттерн, а приведение OSINT к
уже существующей конвенции проекта: вне OSINT массивы кодируются явно
(`posts/service.ts`, `bot/router.ts`, `booking/worker.ts`, `orders/service.ts`,
`leads/setup.ts` — `JSON.stringify(...)`; `analytics/files/service.ts` —
`as unknown as string`).

**Затронутые модули** (9 вызовов `jsonbArray()` + 1 ручной фикс — всего 10
затронутых мест, все в OSINT Stage 2):

| Файл | Вызовы |
|---|---|
| `entity-graph.ts` | `:85` `aliases`, `:165` `evidence` |
| `candidates.ts` | `:91` `match_reasons` (UPDATE), `:131` `match_reasons`, `:132` `evidence` |
| `source-context.ts` | `:118` `contacts`, `:119` `domains`, `:235` `changed_fields` |
| `discovery.ts` | `:151` `providers` |
| `source-context.ts` (UPDATE-путь) | `updates[field] = next` — ручная правка, helper не вызывается |

Все целевые колонки — `jsonb NOT NULL DEFAULT '[]'`
(`069`: `providers`, `aliases`, `match_reasons`, `evidence`, `sources`;
`070`: `evidence`, `contacts`, `domains`, `changed_fields`). Каждый вход
`jsonbArray()` — массив (`string[]`, `MatchSignal[]`, `[{kind,name}]`,
`unknown[]` из хоста); ни одного объекта-входа. Остальные jsonb-записи —
объекты (`social_links`, `fingerprint`, `profile`, `budget`, `stats`,
`metadata`, `snapshot`, `relations.evidence`) — идут через `prepareObject`
и не задеты.

**Существующие проверки.**

- PostgreSQL: `tests/postgres/osint-stage3-assessment.test.mjs` (10 подтестов,
  opt-in, `npm run test:pg`) — версия сервера 17; LATERAL/provenance; 404
  cross-tenant и вне членства; идемпотентность writer; битые строки →
  `skipped`, не 503; CHECK/UNIQUE/FK + `business_member_role_check`; LIMIT
  200; детерминизм. Проверяет фактическую запись **через `jsonbArray()`** на
  реальной PG: иначе сьют невозможен (падает на `22P02`).
- HTTP: `tests/http/account-flows.test.mjs` — append-блок Stage 3 v2 через
  реальные route/middleware (`next start` + HTTPS-прокси): 401/405/200 для
  owner/admin/operator, 404, пустой результат, corroboration/contradiction,
  отсутствие утечки тенанта, битая строка → 200, LIMIT 200.
- CI (`.github/workflows/verify.yml`): service `postgres:17`, шаг
  `npm run test:pg` после `npm test`, затем `test:http`.

**Что PG-проверки НЕ покрывают.** Сьют написан под один исправленный путь —
`entity-graph` (`ensureBusinessEntity` → `aliases`/`evidence`) плюс чтение
наблюдений и ограничения. `candidates`, `source-context`,
`discovery` на **реальной** PostgreSQL не прогоняются: их вызовы
`jsonbArray()` покрыты статически (тип входа + тип колонки), но не
поведенчески. Покрытие **не полное** — 10 затронутых мест охвачены
разнородно (9 статически, ~2-3 поведенчески).

**Ограничения, которые остаются.**

1. **Остатки того же класса вне OSINT — не исправлены** (вне скоупа;
   статически обоснованы, поведенчески не проверялись):
   `analytics/files/service.ts:169` (`columns_json` ← `string[]`),
   `posts/service.ts:557` (`duplicate` → `post.buttons` ← чтение массива),
   `posts/worker.ts:214` (occurrence → `post.buttons`).
2. `403` на assessment endpoint структурно недостижим (owner/admin/operator
   имеют `analytics.view`); ветка `405` с телом в хендлере мертва (Next
   отдаёт пустое тело); неподдерживаемый `kind` → `unsupported_kind` без
   уведомления.
3. **`npm test` с `TEST_DATABASE_URL` локально не идемпотентен**: тесты
   пишут прямо в базу, накопление мусора даёт `RATE_LIMITED`/
   `IDENTITY_CONFLICT` (на свежей базе — 673/673). В CI достаточно свежей
   БД: service-контейнер `postgres:17` создаётся на каждый job. Локально —
   пересоздавать базу руками.
4. `test:pg` и `test:http` требуют **уже запущенный** локальный
   PostgreSQL; сами контейнеры/сервисы не поднимают и не должны поднимать
   (`npm test` на PGlite контейнеров не требует вовсе).
5. PGlite остаётся рабочим гейтом для семантики и изоляции тенантов; она
   **не заменяет** прогон против настоящей PostgreSQL для провайдера БД.

## 25. Stage 3 full — crawl-фаза discovery и оркестрация (реализовано)

### 25.1 Поток данных

```
POST .../osint/discovery          (HTTP, без сети, 201)
  → OsintService.enqueueDiscovery   seed-валидация → 422, бюджет → кламп капов
  → createDiscoveryRun              status=queued + seed-очередь (072)
фоновый воркер (scripts/background-worker.mts, heartbeat "osint")
  → processQueuedDiscoveryRuns      releaseStale → queued по created_at
  → executeDiscoveryRun             атомарный claim queued→running
      search-фаза (§7, без изменений): провайдеры → classify → candidates
      crawl-фаза (§25): accepted-кандидаты run'а → очередь depth 0
        → runCrawl: claim FOR UPDATE SKIP LOCKED → robots → web_page
        → normalizePage → classify(method=website_link) → persistCandidate
        → ensureSource + контекст (§1) + ensureObservation(kind=page)
        → ссылки по follow-политике → очередь depth+1
      finish(status, errors, stats={crawl}) → osint_discovery_runs + audit
GET  .../osint/discovery/[runId]   OsintRunStatusInfo (счётчики очереди, failures)
```

Жизненный цикл разделён намеренно: POST отвечает `201 {runId, status:"queued",
seeds}` и не трогает сеть (`started_at = null`); исполнение — воркером или
тем же `processQueuedDiscoveryRuns` в HTTP-тестах. Синхронный
`OsintService.startDiscovery` сохранён для юнит-тестов/E2E: crawl там
**выключен по умолчанию** (`OsintServiceOptions.crawl`), старые вызовы ведут
себя ровно как на Этапе 2.

### 25.2 Очередь URL (миграция `072_osint_crawl_v1.sql`)

`osint_crawl_queue`: `run_id`/`business_id` (FK, cascade), `url`/
`normalized_url` (≤2048), `depth` (0–25), `priority`, `status`
(`queued|fetching|fetched|failed|skipped` + CHECK), `skip_reason`, `error`,
`attempts`, `http_status`, `from_url`, `fetched_at`,
`UNIQUE (run_id, normalized_url)` + 2 индекса.

- **Дедуп и циклы**: уникальность пары (run, url) делает повторные ссылки и
  петли бесплатными — строка не появляется дважды.
- **Claim**: `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) ORDER BY
  priority DESC, depth ASC, created_at ASC` — два воркера никогда не
  загружают один URL (проверено на реальной PG).
- **Resume**: перезапуск продолжает с `queued`; строка, застрявшая в
  `fetching` упавшего процесса, не переохватывается — её гасит
  `releaseStaleDiscoveryRuns` (run → `failed/stale_run_expired`, очередь →
  `skipped`).
- **Бюджеты** гасят остаток `skipped` с причиной `budget_*` (не `failed`) и
  пишутся в `stats.crawl.budgetHits`.

### 25.3 Seed'ы (`seed.ts`)

Приоритеты детерминированы: `explicit` 110 → `profile_website` 100 →
`profile_social` 95 → `profile_domain` 90 → `run_candidate` 85 →
`prior_source` 80 → `prior_candidate` 70; капы `MAX_EXPLICIT_SEEDS=20`,
`MAX_SEEDS=40`. Нормализация через общий `normalizeUrl`: невалидный явный
seed → **422 `INVALID_SEED_URL`** с перечнем (первые 3). Прежние строки
тенанта идут через мост `osint_entity_sources` → `osint_business_entities`
(≠ rejected) — источник одного владельца становится сидом следующего run'а.

### 25.4 Провайдеры (§25 расширяет §7)

| id | тип | policy | сеть | availability |
|---|---|---|---|---|
| `own_urls` | search | `structured_data` | нет | всегда (emit-once на инстанс) |
| `vk` | search | `official_api` | `api.vk.com/method/groups.search` v5.199 | токен `OSINT_VK_API_TOKEN`; без него `available:false, reason:osint_vk_token_missing` |
| `web_page` | page/crawl | `public_web` | SSRF-safe GET страниц | всегда |

Реестр (`providers/registry.ts`) держит оба вида раздельно: `select()`
фильтрует `disabled` и недоступных (недоступный vk молча выпадает из run'а,
snapshot показывает причину), `selectPage()` отдаёт crawl-провайдера,
`descriptorInfo()` — дескрипторы с динамической доступностью для UI.
Реестр создаётся **свежим на каждый вызов/run** — иначе emit-once
`own_urls` отдал бы результаты только первому run'у. VK-лимит — in-memory
`rateLimitPerMinute` (30/мин по умолчанию), `provider_rate_limited` →
ошибка провайдера → правило статуса partial/failed как у любых провайдеров.

### 25.5 Загрузка и парсинг страниц

`web_page` → `safeFetch` (§16: DNS → проверка всех IP → ручной redirect)
с новым `acceptContentTypes: [text/html, application/xhtml+xml, text/plain]` —
чужой тип отклоняется `unsupported_content_type`, тело не читается.
`extraction/html.ts` — hand-written парсер без зависимостей (title/meta/
JSON-LD/anchors/`<base>`/`<link rel=canonical>`/lang/текст, лимиты
`MAX_HTML_LENGTH=2MB`, `MAX_TEXT_LENGTH=60k`, `MAX_LINKS=300`).
`extraction/page.ts` — `normalizePage` → `ParsedPage`, где **каждое поле
несёт `ExtractionOrigin`** (`html_title`, `meta_description`, `jsonld_same_as`,
`canonical_link`, `anchor`, `visible_text`, …), плюс `contentHash` (sha256
материала — изменился контент → новый hash), контакты, домены, sameAs и
text/plain-ветка.

### 25.6 Безопасность, robots, бюджеты

- **SSRF**: весь network I/O через `safeFetch`; приватные диапазоны
  запрещены, `allowPrivateNetworks` — только тесты/dev (E2E включает явно).
- **robots.txt** (`robots.ts`): группа `*` + конкретный UA, самый длинный
  паттерн выигрывает, `Allow` при равной длине, `$`-anchor и `*`; кэш на
  origin живёт один run; недоступный robots → разрешено (RFC 9309);
  запрет → строка `skipped/robots_disallowed` с паттерном в `error`.
- **Бюджеты**: `mergeDiscoveryBudget` клампит каждое поле капами
  `BUDGET_CAPS` (только ужесточение); новые поля `maxConcurrency` (≤8),
  `maxLinksPerPage` (≤200); жёсткие лимиты — страницы/запросы/длительность/
  глубина/конкурентность, исчерпание — в `stats.crawl.budgetHits`.
- **Follow-политика**: обход только registrable-доменов профиля и seed'ов
  (+ сам хост, если registrable-домена нет — IP/localhost) и **хостов**
  соцсетей профиля; чужие сайты из ссылок не запрашиваются вовсе.
- **Rate limit** POST: 5/60s на `user+business` (`429 RATE_LIMITED`).

### 25.7 Статусы run'а и статистика

Search-статусы Этапа 2 сохранены (`no_providers_available` → partial,
провайдер-ошибки → failed по правилу `queries ≤ providerFailures`,
abort → partial). Crawl добавляет: `hardFail = failed>0 && fetched==0 &&
seeds>0` → **failed**; `softFail = failed>0 || errors>0 || budgetHits>0` →
**partial**. Итог пишется в `osint_discovery_runs.stats = {crawl:
CrawlStats}` (seeds/fetched/failed/skipped/linksDiscovered/requestsUsed/
robotsFetched/candidates*/observationsCreated/depthReached/budgetHits/
errors) + в audit-метаданные. Сбой оркестрации до `finish` ловит runner →
`failed/orchestration_error`.

### 25.8 API и UI

- `POST /api/v1/businesses/[id]/intelligence/osint/discovery` — тело
  опционально `{seedUrls?, budget?}` (без content-type json — `{}`),
  ответ **201 `OsintDiscoveryEnqueued`**; ошибки: 401, 403 (нет
  `intelligence.manage`), 422 `INVALID_SEED_URL`, 429 `RATE_LIMITED`.
- `GET .../discovery/[runId]` — `OsintRunStatusInfo`: счётчики run'а,
  `queue {queued,fetching,fetched,failed,skipped,total}`, ≤10
  `recentFailures` (url/status/skipReason/error), `stats`, timestamps;
  тенант-скоуп: чужой/не-uuid → 404 `DISCOVERY_RUN_NOT_FOUND` (не-член
  бизнеса → 404 `BUSINESS_NOT_FOUND` — неотличимо).
- UI (`OsintPanel`): кнопка ставит run в очередь («В очереди»), провайдеры
  показывают `available`/`unavailableReason`; env
  `OSINT_VK_API_TOKEN=` добавлен в `deploy/app.env.example`.

### 25.9 Тесты

| Файл | Что доказывает |
|---|---|
| `tests/osint-html-page.test.mjs` | парсер, провенанс, hash, лимиты, og-fallback |
| `tests/osint-providers.test.mjs` | vk availability/ошибки/rate-limit; web_page content-type+SSRF; реестр |
| `tests/osint-safe-fetch.test.mjs` (append) | `acceptContentTypes`: reject/charset/redirect/без опции |
| `tests/osint-robots.test.mjs` | парсинг групп, longest-match/Allow tie, кэш, мёртвый robots |
| `tests/osint-crawl.test.mjs` (PGlite, 10) | follow-политика, глубина, циклы/дедуп/resume, бюджеты, robots, статусы failed/partial/completed, abort, конкурентный claim, провенанс наблюдений/контекста |
| `tests/osint-stage3-crawl-e2e.test.mjs` | полный путь на node:http-фикстуре: 201→execute→robots skip→наблюдение с телом→stats; SSRF-guard без `allowPrivateNetworks` |
| `tests/postgres/osint-stage3-crawl.test.mjs` | реальная PG17: CHECK/UNIQUE/FK 072, SKIP LOCKED двумя соединениями, атомарный claim run'а, бюджет в jsonb stats, тенант-скоуп статуса, идемпотентность миграций |
| `tests/http/account-flows.test.mjs` (append) | 401/422/201 (budget-капы в jsonb строки)/200 статус/404 тенант/исполнение runner'ом/429 rate limit |
| `tests/osint-integration.test.mjs` (правка) | snapshot: три провайдера, vk недоступен без токена |

CI (`verify.yml`, не менялся): `npm test` → `test:pg` → `lint` →
`typecheck` → `build` → `test:http` → docker build.

### 25.10 Известные ограничения

1. Crawl-кандидаты и их accepted/review счётчики пишутся в
   `stats.crawl`, **не в** итоговые колонки run'а (`candidates_count` и т.д.
   отражают search-фазу) — UI читает оба источника.
2. Follow соцсетей — по **хосту** (вся `vk.com`), не по точной ссылке
   профиля; для IP-фикстур follow тоже host-уровневый (порт в `normalizeUrl`
   отбрасывается).
3. Кэш robots на origin без TTL может выдать несколько параллельных
   загрузок robots.txt в первом batch — бюджет считает фактическое число.
4. `allowPrivateNetworks` и fixture-провайдеры — только тесты/dev; в
   production web_page всегда с SSRF-guard.
5. Токен VK не обязан быть в CI: провайдер обязан быть недоступен и не
   ронять run; `OSINT_VK_API_TOKEN=` пуст в `deploy/app.env.example`.
6. HTTP-сьют (`test:http`) исполняет run'ы `crawl: null` (search-фаза) —
   crawl через реальный Next-маршрут покрыт E2E на сервисном слое, а не на
   `next start`.

## 26. Stage 4 — intelligence layer: факты, изменения, профиль (реализовано)

### 26.1 Поток данных и факт-слой

```
discovery run завершён (runner §25)
  → enqueueEnrichment                       один активный run на бизнес (§26.11)
фоновый воркер (background-worker, тик между discovery и heartbeat "osint")
  или runEnrichment ad-hoc (юнит/E2E/инструменты)
  → claim queued→running (attempts+1)       два воркера — ровно один winner (§26.16)
  → loadObservations: ПОСЛЕДНЕЕ наблюдение на источник
      SELECT DISTINCT ON (o.source_id) … ORDER BY o.source_id, observed_at DESC
      единый тенант-скоуп §7 (scope.ts)
  → extractFacts (§26.3) → normalizeFactValue (§26.5)
      дедуп по (source_id, fact_type, fact_key)
  → buildExtractedIdentity → resolveEntityMatch (§26.6)
  → транзакция:
      upsert по fingerprint (§26.5)         conflict → обновить seen-времена
      state-based transitions → osint_fact_changes (§26.9)
      reconcileContradictions (§26.10)
  → finishRun: stats + resolution → osint_enrichment_runs.stats (jsonb)

GET .../osint/{profile,facts,changes,contradictions}  read model (§26.12)
UI  IntelligenceProfilePanel                             четыре вопроса (§26.13)
```

**Fact ≠ Observation.** Observation — «источник сообщил X», Fact — «для
бизнеса наблюдалось значение X»: нормализованное, привязанное к строке
источника и живущее дольше одной загрузки страницы (§26.1). Каждая
fact-строка обязана трассироваться до observation → source FK'ми.

### 26.2 Что сознательно НЕ извлекается в v1

Без LLM и без эвристик «по здравому смыслу»: `brand_name`/`legal_name`
без структурированного источника, публичные идентификаторы (ИНН/ОГРН/
лицензии) из произвольного текста, `service`/`product`/`opening_hours`
без закрытого словаря, геокодирование. `category`/`city`/`address`/
`region`/`country` — только из `osint_source_context` (structured data).
Типы определены в схеме заранее; строка создаётся только когда значение
уже дано структурно или лежит в закрытом текстовом паттерне.

### 26.3 Извлечение кандидатов (`facts.ts`)

Приоритет источников: 1) structured data (`source_context`: имя,
категория, город, адрес, контакты, домены, social links); 2)
`source_url` самого источника — registrable-домен → `domain`, URL →
`website`; 3) закрытые regex текста наблюдения — телефоны
(`extractPhoneRuns`), email, URL (соцсеть → соответствующий тип, иначе
`website`); 4) имя сущности — только при явном присутствии в тексте
(`business_name`). Доменом бизнеса считается **только домен самого
источника** — anchor-домены соседних сайтов не извлекаются (§26.19).
Дедуп кандидатов по (source, type, normalized key) — уже в enrichment.

### 26.4 Провенанс (`metadata.origin`)

`origin ∈ {source_context, source_url, observation_text}` — как именно
появился кандидат; `raw_value` никогда не перезаписывается
нормализованным `value`. Цепочка fact → observation → source читается
FK'ми: `osint_intelligence_facts` FK на глобальные таблицы (070 убрал их
`business_id`), тенантская изоляция — общий SQL-скоуп §7, а не составной
FK. Drill-down из UI/API уходит в существующий Stage 3 observation slice.

### 26.5 Нормализация и fingerprint'ы (`normalize.ts`)

Два слоя: `value` — каноническое представление для показа, `key` — ключ
сравнения (там, где регистр не несёт смысла — casefold(value)). Один и
тот же вход всегда даёт один и тот же результат — иначе идемпотентность
невозможна.

| тип | правило |
|---|---|
| phone | общий с Stage 3 `normalizePhone`: 10–15 цифр, 8→7 для 11 цифр РФ; мусор → null |
| email | домен lowercase, локальная часть сохраняется (RFC 5321) |
| domain | без схемы/пути/порта, `www.` снимается, только ASCII |
| website | lowercase scheme+host, без фрагмента, tracking-параметры (utm/gclid/fbclid/…) вырезаны, параметры отсортированы; в key схема не входит → http ≡ https |
| social | `network:handle` (vk/telegram/instagram/facebook/youtube/tiktok + `other:` для остальных) |
| address | TRIM, ё→е, типовые сокращения (`ул.`→`улица`, `д.`→`дом`, …); NB: `\b` в JS не работает с кириллицей — позиция задаётся `(^|\s)` |
| free text | pretty-текст в value, `normalizeText` в key |
| прочее | `null` на непригодное значение — факт не создаётся, а не сохраняется «как есть» |

Fingerprint'ы — sha256 по полям, соединённым NUL-символом:
`(business, type, key, source)` — отпечаток fact-строки;
`(business, type, kind, old, new, source)` — отпечаток change-перехода
(`null` и `""` эквивалентны). Уникальность держит
`UNIQUE (business_id, fingerprint)` в обеих таблицах.

### 26.6 Entity resolution (`entity-match.ts`)

Классификация **процесса** сопоставления, а не оценки бизнеса: сигналы
`domain_exact` / `phone_exact` / `name_exact` / `city_match` /
`name_similar` (Sørensen–Dice по токенам, порог 0.85) → классы
`EXACT` (домен + имя/телефон), `STRONG` (ровно один из домена/телефона),
`CANDIDATE` (имя + город), `AMBIGUOUS` (сходство без точного), `NO_MATCH`.
Равные претенденты принижаются до `AMBIGUOUS` с `entityId: null` —
выбор без явного решения не делается. Мосты `osint_business_entities` при
этом не изменяются: enrichment не создаёт и не отвергает сущностей.

### 26.7 Миграция `073_osint_intelligence_v1.sql`

Четыре таблицы: `osint_intelligence_facts`, `osint_fact_changes`,
`osint_intelligence_contradictions`, `osint_enrichment_runs`. Ограничения
(проверены по именам на реальной PG): CHECK типов фактов (26 значений) и
статусов, `attempts < 10`, `UNIQUE (business_id, fingerprint)` × 2,
`UNIQUE (business_id, fact_type)` на противоречиях, частично-уникальный
индекс `osint_enrichment_active_idx … WHERE status IN ('queued','running')`,
FK на observation/source/entity. Стороны противоречия — jsonb-массив
через `jsonbArray()` (top-level массив в `pg` иначе уходит в литеральный
массив — §24.7). Append-only, идемпотентность миграции — повторный
`migrate` в тестах.

### 26.8 Жизненный цикл fact-строки

`ACTIVE` — подтверждён последним enrichment; `RETIRED` — вытеснен
заменой значения того же типа того же источника (есть change-событие
`VALUE_CHANGED`); `STALE` — исчез из источника без пары (может вернуться
→ `VALUE_REAPPEARED`). **Профиль собирается только из ACTIVE** — retired
и stale участвуют в истории и ленте, но не в «что известно сейчас».

### 26.9 State-based transitions и идемпотентность

Переходы детектируются сравнением **before** (stored ACTIVE-строки) и
**after** (извлечённые кандидаты) по composite `fact_type` + `fact_key`
(разделитель — NUL), а не по времени:

- ровно 1 исчез × 1 появился → `VALUE_CHANGED` (старые строки → `RETIRED`);
- иначе исчезнувшие → `STALE` + `VALUE_DISAPPEARED`, появившиеся →
  `FIRST_SEEN` либо `VALUE_REAPPEARED` (ключ был в beforeAll);
- новый источник у уже известного ключа → `SOURCE_CHANGED`.

Change-строки вставляются с `ON CONFLICT DO NOTHING` по fingerprint —
повторный пересчёт того же перехода не дублируется; детерминированный
`ORDER BY` везде. Повторный enrichment без изменений: `factsExtracted=0`,
`factsChanged=0`, `contradictionsDetected=0` (только `factsUpdated`
обновляет seen-времена). `stats.factsChanged` считает **вставки**
change-строк: неизменный пересчёт даёт 0.

### 26.10 Противоречия (`reconcileContradictions`)

Правило: ≥2 активных значения **и** ≥2 источника **и** множества
источников у значений не идентичны (один источник с двумя номерами — не
противоречие, а его собственный список). Одна строка на
`(business, fact_type)`: `sides` (value + sources + observations +
firstSeen/lastSeen), `value_count`, `source_count`, статус. Пересчёт
вставляет **новые** строки (их число и есть
`stats.contradictionsDetected`), существующие — обновляет стороны, если
они изменились; `detected_at` и `resolved`-статус пересчёт не трогает.
Победитель не выбирается.

### 26.11 Очередь enrichment и оркестрация

`queued → running → completed|failed`, частично-уникальный индекс держит
**один активный run на бизнес** (гонка двух `enqueueEnrichment` гасится
`23505` → возвращается существующий, `created:false`). Claim — `UPDATE
… WHERE status='queued'` с `attempts+1`; воркер берёт следующий queued
через `FOR UPDATE SKIP LOCKED`. Интеграция: runner после успешного
discovery ставит enrichment в очередь; `background-worker` выполняет
`processQueuedEnrichments({limit:1})` тиком между discovery и
`heartbeat("osint")` (новых heartbeat-имён нет). Ad-hoc `runEnrichment`
без runId сам ставит в очередь и claim'ает; при занятости возвращает
`status: "in_progress"` без ошибки.

### 26.12 Read model: API, DTO, клиентский сервис

`OsintService.getIntelProfile/getIntelFacts/getIntelChanges/
getIntelContradictions` — все через `requireBusiness(…, "analytics.view")`
(чужой/не-член → 404 `BUSINESS_NOT_FOUND`, неотличим от несуществующего).
Проекция on-read без materialized view: профиль — из ACTIVE-строк
(names/phones/emails/websites/domains/socials/categories/address/city +
`counts` по статусам + `byType` + `lastRun` с `resolution` из jsonb),
факты/изменения — страницы с JOIN источников и полным тай-брейком,
противоречия — jsonb-стороны с defensive-парсингом. Клампы:
`limit ≤ 100` (по умолчанию 50), `offset ≤ 10000`; неизвестный
`factType` — **пустая страница**, а не ошибка (список типов открыт).
DTO — `src/lib/intelligence-types.ts` (даты ISO); клиент —
`intelligence.service.ts` через `apiRequest`.

### 26.13 UI: четыре вопроса (`IntelligenceProfilePanel`)

«Кто это» (имя, класс сопоставления, сигналы), «Что известно» (профиль +
факты, ленивая загрузка страницами по 20, provenance в `<details>`),
«Что изменилось» (лента переходов), «Противоречия» (стороны без выбора
победителя). Встроен в `IntelligenceCommandCenter` под `OsintPanel`;
`data-testid` на каждом блоке; синхронный `setState` в эффекте обойдён
через `queueMicrotask` (правило `react-hooks/set-state-in-effect`).

### 26.14 HTTP-контракт

Четыре `GET`-маршрута
`/api/v1/businesses/[id]/intelligence/osint/{profile,facts,changes,contradictions}`
(факты/изменения принимают `?limit=&offset=`, факты — ещё `?factType=`).
Ошибки: 401 без сессии; 405 на не-GET — **тело отдаёт сам Next (пустое,
не JSON)**, собственная ветка в хендлере недостижима (§24.7); 404
`BUSINESS_NOT_FOUND` для чужого бизнеса.

### 26.15 Тесты

| Файл | Что доказывает |
|---|---|
| `tests/osint-stage4-normalize.test.mjs` (10) | нормализация по типам, мусор → null, детерминизм и чувствительность fingerprint'ов |
| `tests/osint-stage4-entity-match.test.mjs` (8) | классы EXACT/STRONG/CANDIDATE/AMBIGUOUS/NO_MATCH, равные претенденты → AMBIGUOUS без выбора |
| `tests/osint-stage4-intelligence.test.mjs` (9, PGlite) | Runs 1–4: FIRST_SEEN → SOURCE_CHANGED+противоречие → VALUE_CHANGED+RETIRED → идемпотентный пересчёт; профиль/страницы/фильтры; тенант-изоляция; очередь (дубль enqueue, воркер-тик без изменений) |
| `tests/postgres/osint-stage4-constraints.test.mjs` (5, реальная PG17) | именованные CHECK/UNIQUE/FK; first_seen не двигается; два claim → один winner; SKIP LOCKED ×3 → ровно 2; stale-run → queued/failed; тенант read model |
| `tests/http/account-flows.test.mjs` (append) | 401 ×4, 405 (пустое тело), 200 owner со структурой профиль/факты/изменения/противоречия, 404 чужому, пустой бизнес → нули |

Прогон: `npm test` 733 (0 fail), `test:pg` 24, `test:http` 16 — локально
против запущенного `postgres:17` (контейнер тестового сервера) и в CI
(`verify.yml`, порядок шагов не менялся: test → test:pg → lint →
typecheck → build → test:http).

### 26.16 Конкурентная безопасность очереди

`partial UNIQUE` — физический запрет двух активных run'ов на бизнес;
`claimEnrichment` параллельно дважды → ровно один winner (проверено на
реальной PG через независимые соединения пула); `claimNextEnrichment` ×3
при двух queued → ровно два winner'а с разными id, третий получает null
(SKIP LOCKED не выдаёт занятое).

### 26.17 Retry и stale-recovery

Исключение в пайплайне: `attempts < ENRICHMENT_MAX_ATTEMPTS (3)` →
run снова `queued` с текстом ошибки, иначе → `failed`. Застаревший
`running` (старше 10 минут — процесс упал вместе с run'ом) при старте
тика переводится в `queued`, а при исчерпанных попытках — в `failed` с
`error: stale_run_expired`. Бессмертных ретраев нет.

### 26.18 Статусы enrichment ≠ качество данных

Противоречие — **не отказ пайплайна**: `runEnrichment` завершается
`completed` и записывает `contradictionsDetected > 0` в stats; статусы
`failed/retry` отражают только технические ошибки исполнения.
`factsChanged = 0` означает «переходов не было», а не «данные
согласованы».

### 26.19 Гарантии

Никакой сети (наблюдения уже в БД), никакого LLM, никакого
forecasting/risk/reputation — только детерминированные правила;
контент — ровно то, что Stage 3 сохранил (§25); домен извлекается только
у самого источника, не по anchor-ссылкам. Одинаковое состояние БД →
одинаковые факты, переходы и проекция.

### 26.20 Лимиты и известные ограничения

1. **Материал для извлечения — по одной (последней) строке на источник**
   (`DISTINCT ON`): выборка ограничена числом источников, весь граф в
   память не грузится; многостраничная история источника в enrichment не
   участвует (жизненный цикл отвечает «что источник сообщает сейчас»).
2. `osint_source_context` подгружается только для источников текущей
   выборки; bridge-сущностей для match — ≤50; страницы фактов ≤100;
   длины полей ограничены CHECK'ами (key ≤300, value ≤1000, raw ≤2000).
3. Имя без домена/телефона/города у сущности даёт типовой
   `AMBIGUOUS` — это классификация процесса, а не отказ в сопоставлении;
   автоматического выбора между равными сущностями нет.
4. Ручное разрешение противоречия (`status: resolved`) — слой данных
   готов, UI/метода для клика нет; пересчёт существующий статус не
   трогает.
5. Извлечение email/имени — закрытые regex и присутствие имени в тексте:
   ложные срабатывания возможны, LLM-верификации нет (по контракту §26.19).
6. Лента изменений в профиле — последние 10 переходов; полная история
   только через `GET .../changes`.
