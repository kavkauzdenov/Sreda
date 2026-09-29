# Roadmap (deferred)

Items intentionally **not** required to complete Closed Beta hardening after PR #53.

| Item | Notes |
|---|---|
| **MAX messenger** | Present only as a frontend `Platform` / label. No adapter, webhook, or worker. Non-blocker for beta. |
| **Full payment provider** | Billing page is placeholder; entitlements via activation + admin override. Provider-agnostic domain planned — see [BILLING.md](BILLING.md). |
| **Production deploy** | Staging = Biznebiznesoty-staging only. Yandex/compose path exists as preparation, not the beta ship target. |
| **Admin MFA** | Platform admin console without MFA; deferred (`docs/admin/README.md`). |
| **Admin impersonation** | Explicit non-goal. |
| **Moderation solution** | Catalog entry; not in owner activatable allowlist. |
| **Meta GA** | WhatsApp/Instagram code + migration 050 present; treat as opt-in staging experiment until product sign-off. |
| **Independent encryption key** | Credential crypto still tied to auth secret lineage; dedicated key + rotation drill before production. |
| **Dual telegram-worker HA** | Single-owner loop assumed; multi-replica claim redesign deferred. |
| **Login via Telegram/VK codes** | Recovery codes cover account recovery; messenger login not shipped. |

## Beta focus instead

- Harden tenant isolation, staff notification verification, workers/health, and solution UX from PR #53.
- Keep docs and staging checks aligned with migration **052** and the current staging environment.
- Expand real-channel E2E evidence on staging without enabling live payments or production bots.

Snapshot: [BETA-STATE-2026-09-21.md](BETA-STATE-2026-09-21.md).
