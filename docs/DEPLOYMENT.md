# Deployment — БизнеСоты (biznesoty)

## One product, three brand entry hosts

There is **one** web app, **one** auth system, **one** dashboard.
Brand domains are entry points — not separate sites.

### Canonical (APP_URL)

```
https://biznesoty.ru
```

Exact HTTPS origin, no trailing slash. This is the only production `APP_URL`
and the only Better Auth `trustedOrigins` / `baseURL` origin.

### Redirect-only aliases (308 GET/HEAD → canonical)

| Host | Role |
|---|---|
| `www.biznesoty.ru` | apex www |
| `biznesoty.online` | brand alias |
| `www.biznesoty.online` | brand alias www |
| `бизнесоты.рф` / `xn--90aifd0ahuj5f.xn--p1ai` | Cyrillic brand alias |

Behaviour (browser-safe methods only):

```
https://biznesoty.online/login?next=/orders
  → 308 https://biznesoty.ru/login?next=/orders

https://бизнесоты.рф/register
  → 308 https://biznesoty.ru/register

https://www.biznesoty.ru/dashboard
  → 308 https://biznesoty.ru/dashboard
```

Path and query are preserved. Unsafe methods (`POST`/`PUT`/`PATCH`/`DELETE`)
on alias hosts are **403** (not body-preserving redirects).

Never set as `APP_URL` and never add to Better Auth `trustedOrigins`:

- `https://biznesoty.online`
- `https://бизнесоты.рф`
- `https://www.biznesoty.ru`
- `https://www.biznesoty.online`

Implementation: `src/server/http/canonical-host.ts` + Next.js `src/proxy.ts`.

Exempt from canonical redirect (must keep working on the registered host):

- `/api/health`, `/api/health/web`, `/api/health/live`
- `/api/telegram/*`, `/api/vk/*`, `/api/meta/webhook`

### Public user journey (canonical)

```
biznesoty.ru/          → public landing
  → Войти              → /login
  → Попробовать        → /register
  → (auth success)     → /dashboard (existing app)
```

Alias hosts 308 into the same journey on `biznesoty.ru`.

**Do not set `APP_URL=https://biznesoty.ru` until DNS is verified and the TLS certificate is READY.**

Code being ready ≠ domains already attached in DNS.

## Runtime topology

```
GitHub (main)
  → host / VM
      → PostgreSQL (shared)
      → web (Docker / Next.js)
      → telegram-worker
      → vk-worker
```

### Web

- Build: Dockerfile
- Migrate: `node --import tsx scripts/db-migrate.mts` (or `npm run db:migrate`)
- Start: `npm run start -- --hostname 0.0.0.0` (respects `PORT` when set)
- Health: `/api/health/web`

### Workers

- Telegram start: `npm run worker:telegram`
- VK start: `npm run worker:vk`
- No public HTTP domain required
- Share the same `DATABASE_URL` / `APP_URL` / secrets as web
- Migrations are idempotent; a worker can start against a migrated DB

### Self-hosted / Yandex path

Authoritative compose + Caddy setup lives under `deploy/`:

- `deploy/compose.yml`
- `deploy/Caddyfile`
- `deploy/release.sh`
- Manual workflow `.github/workflows/deploy-yandex.yml`
- Install prefix examples use `/opt/biznesoty/`

See also [architecture/YANDEX-DEPLOYMENT.md](architecture/YANDEX-DEPLOYMENT.md).

## Required environment names (values never documented here)

**Core:** `APP_URL`, `DATABASE_URL`, `BETTER_AUTH_SECRET`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_DATA_SOURCE`

**Workers / channels:** `TELEGRAM_WEBHOOKS_ENABLED`, `VK_WEBHOOKS_ENABLED`

**Meta (optional):** `META_WEBHOOKS_ENABLED`, `WHATSAPP_WEBHOOKS_ENABLED`, `INSTAGRAM_WEBHOOKS_ENABLED`, `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`, `META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID`, `META_INSTAGRAM_LOGIN_CONFIG_ID`

**AI (optional):** `AI_API_TOKEN`, `AI_MODEL`

**Storage:** `ATTACHMENT_STORAGE`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, optional `ATTACHMENT_STORAGE_PATH`, `S3_URL_STYLE`

**SMTP (optional):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`

Full authoritative list: [docs/ENV.md](ENV.md).

## Pre-deploy habits

1. Merge only through CI Verify on the commit you deploy.
2. Migrate on a DB copy first when schema changes are risky.
3. Toggle webhooks off during worker cutovers if dual-process overlap is possible.
4. Keep staging bots/tokens isolated from any future production bots.
