# Business Intelligence — Day 1

## Existing architecture

- **Stack:** Next.js 16 (App Router), React 19, Kysely + PostgreSQL, better-auth, API routes under `/api/v1/`.
- **Tenant:** `business` row with `public_id`; membership via `business_member`; access checks via `requireBusiness(db, userId, publicId, permission)`.
- **UI shell:** `(app)` layout with `AppShell`, `BusinessSwitcher`, shared panels (`panel`, `clients-summary` cards), navigation in `src/config/navigation.ts`.
- **Dashboard:** `/dashboard` — KPIs, solutions, activity; not a dedicated “command center”.
- **Analytics (existing):** `AnalyticsService` — period KPIs, charts, file upload, optional AI analyst (`analytics.view` permission). Route: `/api/v1/businesses/:id/analytics`.
- **Domain summaries already available:**
  - Orders: `getOrderSummary`, list filters, statuses (`IN_PROGRESS_STATUSES`, `REVENUE_STATUSES`).
  - Clients: `getClientSummary` (totals, 30d active/new, open conversations).
  - Leads: `LeadService.summary`, status counts.
  - Bookings, communications, posts — via analytics slices.

## Data sources (Day 1 — internal only)

| Source | Use |
|--------|-----|
| `order` | Counts, revenue, stale/new orders |
| `client` | Inactivity (last_seen), totals |
| `lead` | Open/stale leads |
| `business` | Timezone for period boundaries |
| Existing analytics period helpers | 7d / 30d windows |

No OSINT, no external APIs, no vector DB, no Redis (optional DB cache later).

## New components

| Layer | Location |
|-------|----------|
| Types & signals | `src/server/intelligence/*` |
| Business Brain orchestrator | `BusinessBrainService.getOverview()` |
| HTTP | `src/server/http/intelligence-handler.ts` |
| API | `GET /api/v1/businesses/:publicId/intelligence/overview` |
| UI Command Center | `/intelligence` → `IntelligenceCommandCenter` |
| Client service | `src/services/intelligence.service.ts` |

Pipeline: **internal data → signals → insights → recommendations → overview DTO**.

## Database changes

- **`intelligence_audit_log`** — append-only log for overview views and action previews (avoids extending `business_audit_log` CHECK enum).
- No change to core business tables on Day 1.

## API

- `GET /api/v1/businesses/:id/intelligence/overview`
  - Auth: session required.
  - Permission: `analytics.view` (operators included).
  - Query: `demo=1` only when `INTELLIGENCE_DEMO=1` (non-production) returns labeled synthetic payload.
  - Response: `summary`, `metrics`, `signals`, `insights`, `recommendations`, `lastUpdated`, `dataMode` (`live` | `insufficient` | `demo`).

Tenant isolation: same pattern as analytics — `requireBusiness` on `:id`.

## UI

- Route: `/intelligence` (secondary nav).
- Blocks: header, hero status, key metrics (4–6 real metrics), attention (insights by severity), recommendations with action preview drawer.
- Design: reuse BizneSoty tokens; no new visual language; severity badges; evidence expandable.

## Business logic

1. **Signals** (extensible `type` enum): `overdue_order`, `overdue_lead`, `sales_drop`, `inactive_customer`, …
2. **Insights:** deterministic rules + evidence arrays (metric, current, previous, sampleSize).
3. **Recommendations:** `manual_required` / `preview`; link to `/orders`, `/leads`, `/clients`.
4. **Business status:** `critical` if any critical signal; else `attention_required` if high/medium; else `stable`.
5. **LLM:** not used on Day 1 for detection; optional later for copy only.

## Risks — not on Day 1

- Full signal catalog, forecasting, multi-agent automation, LangChain, Redis, rewriting analytics UI, changing auth/DB stack.

## Day 2+ (planned)

- External context, forecasting, delegated actions with guardrails.
