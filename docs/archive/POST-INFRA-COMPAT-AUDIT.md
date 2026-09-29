# Post-infrastructure compatibility audit — archived summary

**Date:** 2026-09-26  
**Status:** historical snapshot; do not use as the current source of truth.

This document intentionally omits public-server IP addresses, private routing details,
host filesystem inventory, peer addresses and other operational topology. Those details
belong in the private infrastructure runbook, not in the public repository.

## Findings retained for engineering history

- The canonical public origin is `https://biznesoty.ru`.
- Telegram required a reachable webhook origin and a dedicated worker.
- Meta/WhatsApp/Instagram server egress required a separate routing review because
  provider IPs may change over time; static provider IP lists are not a durable source of truth.
- Alias domains require TLS termination before Next.js can issue canonical redirects.
- Host Git checkout and running Docker image must never be assumed to be identical.
- Deployment health must distinguish web/database readiness from worker readiness.
- Production deployment must use immutable image tags and a validated database backup.

## Superseded findings

The original audit predated:
- Orders V2 and migration 066;
- the independent background/Telegram/Meta worker split;
- expanded worker health checks;
- atomic conversation closing;
- immutable build metadata and `/api/version`;
- mandatory pre-migration backup and guarded rollback;
- dedicated rotatable connection-encryption keys;
- current Caddy alias coverage.

For the current project state see `docs/PROJECT-STATE.md` and
`docs/architecture/YANDEX-DEPLOYMENT.md`.

Operational details (server addresses, WireGuard peers/AllowedIPs, SSH commands tied to
specific hosts and secret locations) must be maintained in a private runbook.
