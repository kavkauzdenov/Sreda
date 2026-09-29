# Cleanup Report — deep dead-code / legacy audit

**Branch:** `cursor/deep-cleanup-258e`  
**Base:** `main` @ `89403a3`  
**Date:** 2026-09-29  
**Rule:** delete only proven DEAD / DUPLICATE / OBSOLETE / TEMPORARY. Prefer KEEP / REVIEW on uncertainty. No destructive DB migrations. No public API / worker / auth removals without proof.

## Architecture map (current)

```
Frontend (src/app + src/components/*-v2, dashboard, leads, …)
  ↓ HTTP services (src/services/*.service.ts)
API (src/app/api/** → src/server/http/*)
  ↓ domain services (src/server/**)
Database (migrations 001…068, Kysely schema)
  ↓ outbox
Workers (background / telegram / vk / meta via deploy/compose.yml)
  ↓
External: Telegram, VK, Meta, S3, Caddy/Yandex Docker deploy
```

Canonical SoT docs: `docs/PROJECT-STATE.md`, `docs/ARCHITECTURE.md`, `docs/architecture/YANDEX-DEPLOYMENT.md`, `deploy/compose.yml`.

---

## Legend

| Cat | Meaning | Default action |
|-----|---------|----------------|
| A | CURRENT | KEEP |
| B | LEGACY BUT REQUIRED | KEEP |
| C | DEAD CODE | DELETE |
| D | DUPLICATE (unused copy) | DELETE |
| E | OBSOLETE DOCUMENTATION | ARCHIVE / DELETE |
| F | TEMPORARY / one-off | DELETE |
| G | UNCERTAIN | REVIEW (do not delete) |

---

## Candidates — DELETE / ARCHIVE (proven)

| Path | Category | Evidence | Action |
|------|----------|----------|--------|
| `src/components/orders/OrdersView.tsx` | C / D | Zero external imports. `/orders` page mounts `orders-v2/OrdersWorkspace` only. | DELETE |
| `src/components/orders/ProductEditor.tsx` | C / D | Sole importer is dead `OrdersView`. Live editor is `orders-v2/ProductEditorWizard`. | DELETE |
| `src/components/onboarding/LeadsSetupView.tsx` | C / D | Zero app imports. Setup page uses `LeadSetupWizard`. Mention only in rename report. | DELETE |
| `src/components/leads/LeadFormFieldsPanel.tsx` | C | Zero imports. Live builder is `LeadFormBuilder`. | DELETE |
| `src/components/analytics/DashboardAnalyticsSummary.tsx` | C | Zero imports. KPIs live in `DashboardKpis`. | DELETE |
| `src/components/dashboard/ConnectionsCard.tsx` | C | Zero imports; not used by `DashboardView`. | DELETE |
| `src/components/dashboard/DashboardHeader.tsx` | C | Zero imports. | DELETE |
| `src/components/dashboard/RecentLeads.tsx` | C | Zero component imports. Hook still fetches `getRecentLeads` for `DashboardView` search/detail — keep service/hook. | DELETE |
| `src/components/dashboard/ScheduledPosts.tsx` | C | Zero component imports. Same for `getScheduledPosts`. | DELETE |
| `src/components/dashboard/SearchField.tsx` | C | Zero imports. | DELETE |
| `src/components/dashboard/SolutionWorkspace.tsx` | C | Zero imports. Dashboard uses `SolutionModule` inline. | DELETE |
| `src/components/dashboard/TariffCard.tsx` | C | Zero component imports. CSS class `.tariff-card*` still used by `BillingView` — keep CSS. | DELETE |
| `src/components/ui/PagePlaceholder.tsx` | C | Zero imports. Billing test only asserts absence of string. | DELETE |
| `src/components/ui/StatusPill.tsx` | C | Zero imports. Live chip is `LeadStatusBadge`. | DELETE |
| `src/config/assets.ts` | C | Zero TS imports. Comment marks module archival; live modules use `/assets/soty/v2` via `solutionPresentation`. | DELETE |
| `src/lib/cn.ts` | C | Only imported by dead `StatusPill` + `PagePlaceholder`. | DELETE |
| `src/services/user.service.ts` | C | `getCurrentUser` has zero callers; auth user from layout/`BusinessProvider`. | DELETE |
| `src/services/index.ts` | C | Barrel never imported (`@/services` unused; callers use `@/services/*.service`). | DELETE |
| `src/mocks/index.ts` | C | Barrel never imported; individual `@/mocks/*` used. | DELETE |
| `src/server/leads/setup.ts` → `toLegacyDraftView` | C | Exported, zero callers. V1→V2 conversion via `convertV1ToV2` remains. | DELETE export only |
| `src/config/design.ts` → `SOLUTION_MESSAGES_CSS_ALIAS` | C | Zero TS references. CSS vars remain in `globals.css`. | DELETE export only |
| `src/app/globals.css` → `.crm-segment*` | C | Only used by dead `OrdersView`. E2E notes legacy segment removed. Keep `.crm-page` / `.crm-panel`. | DELETE CSS rules |
| `scripts/visual-polish-capture.mjs` | D / F | Self-`@deprecated` spawn of `ui-audit-capture.mjs`; not in package.json/CI. | DELETE |
| `scripts/ui-polish-capture.mjs` | F / C | Hardcoded polish artifact paths; zero repo references. | DELETE |
| `scripts/corrective-shots.cjs` | C | Hardcoded localhost shots; zero references. | DELETE |
| `scripts/prep-auth-storage.mjs` | F / C | Manual Playwright helper; CI inlines equivalent; zero refs. | DELETE |
| `TRANSFER_README.md` | E | One-time Chernoviki→Biznesoty transfer note; contradicts current deploy. | ARCHIVE |
| `BRAND-RENAME-REPORT.md` | E / F | Frozen one-shot rename report. | ARCHIVE |
| `POST-INFRA-COMPAT-AUDIT.md` | E | Self-marked historical; superseded by PROJECT-STATE. | ARCHIVE |
| `FINAL-NETWORK-ROUTING-AUDIT.rtf` | E | Historical network audit RTF at repo root. | ARCHIVE |
| `docs/SAVED-WORK-2026-09-14.md` | E | Draft save note (migrations 016–018 era). | ARCHIVE |
| `docs/BETA-STATE-2026-09-21.md` | E | Snapshot (migration 057, 2 workers). | ARCHIVE |
| `docs/mvp-readiness.md` | E | Early MVP checklist / old brand framing. | ARCHIVE |
| `docs/PRE-RELEASE-E2E.md` | E | Dated 2026-09-16 PR #19 narrative; superseded by `E2E.md`. | ARCHIVE |
| `docs/UNIFIED-SOLUTIONS-REVIEW.md` | E | Frozen PR #19 review. | ARCHIVE |
| `docs/universal-bot-architecture.md` | E | Old “Среды” bot model; overlapped by ARCHITECTURE/CHANNEL_ADAPTER. | ARCHIVE |
| `docs/ROADMAP.md` | E | Anchored to post-PR#53; wrong migration 052; MFA/encryption claims superseded. | ARCHIVE |
| `docs/product/LEAD-ONBOARDING.md` | E | Stage-2 localStorage prototype narrative. | ARCHIVE |

---

## KEEP — CURRENT / LEGACY REQUIRED

| Path | Category | Evidence | Action |
|------|----------|----------|--------|
| `src/components/orders-v2/**` | A | Mounted by `/orders` page. | KEEP |
| `src/components/clients-v2/**` | A | Mounted by clients pages. | KEEP |
| `src/lib/leadSetupV2.ts`, `leadSetupDraft.ts`, `convertV1ToV2` | B / A | Persisted v1 metadata still converted on read; bot/API/UI use v2. | KEEP |
| `src/server/connections/crypto.ts` v1 decrypt | B | Must read pre-keyring secrets. | KEEP |
| `normalizeSolutionCode` / `sales`→`orders` | B | DB may store `sales` activations. | KEEP |
| Brand localStorage shims (`sreda.*`, `soty.theme`) | B | One-time key migration for existing browsers. | KEEP |
| `src/server/http/crm-handler.ts` legacy list (no `view=v2`) | B | `BookingsView` still calls without `view=v2`. | KEEP |
| `src/server/http/orders-handler.ts` default list | B | `ActivityFeed` still hits legacy list shape. | KEEP |
| `src/server/clients/service.ts` | B / A | Still SoT for create/update/merge despite “legacy API” docs label. | KEEP |
| All `migrations/**` | A / B | Forward-only ledger through `068_intelligence_audit.sql`. | KEEP |
| `scripts/{background,telegram,vk,meta}-worker.mts` | A | Wired in `deploy/compose.yml`. | KEEP |
| `scripts/db-migrate.mts`, `staging-check.mts`, `bootstrap-super-admin.mts`, audit scripts | A | package.json / CI / compose. | KEEP |
| `deploy/**` | A | Yandex Docker + Caddy production topology. | KEEP |
| `docs/PROJECT-STATE.md`, `ARCHITECTURE.md`, `ENV.md`, … | A | Current operational docs (some need light refresh — separate from DELETE). | KEEP |
| Webhooks `/api/telegram`, `/api/vk`, `/api/meta/webhook`, health/version | A | External + deploy probes. | KEEP |
| `/api/v1/**` versioned surface | A | Not a dead “v1 leftover”. | KEEP |
| `src/config/scene.ts` | A | Imported by `config/solutions.ts` (`MODULE_DOCKS`). | KEEP |
| `.tariff-card*` CSS | A | Used by `BillingView`. | KEEP |

---

## UNCERTAIN — REVIEW (do not delete this pass)

| Path | Category | Evidence | Action |
|------|----------|----------|--------|
| `src/app/(app)/leads/concept/**` + `LeadsConceptView` | G | Route exists; used by audit scripts; not in main nav. Product decision needed. | REVIEW |
| `public/assets/sreda/**` (platform/solutions/decor/icons/ui/status/v2) | G | No live TS imports after deleting `assets.ts` + dead dashboard widgets; still design/history + telegram checklist avatar path. Large binaries. | REVIEW |
| `scripts/s3-smoke.mts` | G | Manual S3 smoke; not in package.json/CI but useful ops. | KEEP / REVIEW |
| `/api/v1/.../reply-templates` | G | Route + service; no UI client found. May be intentional API surface. | REVIEW |
| `/api/v1/.../analytics/.../mapping`, `/sections/[section]` | G | No frontend string match; may be future/partial UI. | REVIEW |
| `/api/v1/.../import`, `/cart` | G | HTTP surface; bot may use domain services directly. | REVIEW |
| `docs/WORKERS.md`, `CHANNEL_ADAPTER.md`, `DATABASE.md`, `DEPLOYMENT.md`, `README.md` worker list | E-ish / A | CURRENT docs with stale worker topology / migration numbers. Prefer rewrite over delete. | REVIEW (light fix later) |
| `docs/architecture/CORE.md`, `STAGE4.md`, `DECISIONS.md` | G / B | Historical “why”; may still explain decisions. | REVIEW |
| `docs/design/**` approved references | B | Design SoT for geometry; not runtime. | KEEP |
| Stale env vars in `.env.example` | G | Needs per-var audit against code; none proven obsolete in this pass (Railway already removed). | REVIEW |
| Feature flags / webhook env gates | A / F | Env-driven, not stuck dead flags. | KEEP |

---

## Explicitly out of scope

- No DROP TABLE / DROP COLUMN / migration rewrite.
- No auth, billing, outbox, worker, webhook, tenant, encryption changes.
- No “rename v2 folders to drop v2 from name” refactor (orders-v2/clients-v2 are CURRENT).
- No mass rewrite of stale-but-CURRENT docs beyond archival of proven obsolete snapshots.

---

## Planned verification after cleanup

1. `npm run typecheck`
2. `npm run lint`
3. `npm run test`
4. `npm run build`
5. Re-grep for orphaned imports / `.crm-segment` / deleted basenames
6. E2E / audit if environment allows (shared DB may flake — record SKIPPED if blocked)

---

## Execution status

- [x] Audit complete (this file)
- [ ] Proven DELETE / ARCHIVE applied
- [ ] Gates run
- [ ] Final summary updated
