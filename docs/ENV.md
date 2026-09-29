# Environment variable manifest — БизнеСоты

Names only. Never put real secrets in git.

## Required (web + workers)

| Name | Notes |
|---|---|
| `APP_URL` | Exact origin. Production: `https://biznesoty.ru` |
| `DATABASE_URL` | Shared Postgres for web + workers |
| `BETTER_AUTH_SECRET` | ≥ 32 chars; same across web + workers |
| `NEXT_PUBLIC_APP_NAME` | `БизнеСоты` |
| `NEXT_PUBLIC_DATA_SOURCE` | `api` in production builds |

## Channel flags

| Name | Notes |
|---|---|
| `TELEGRAM_WEBHOOKS_ENABLED` | `true` only when telegram-worker is live |
| `TELEGRAM_WEBHOOK_BASE_URL` | Optional. Exact origin that Telegram reaches for `POST /api/telegram/<connectionId>`. Empty → `APP_URL`. Set when `APP_URL` is not routable from Telegram and a relay host proxies that path to the app. Must satisfy the same exact-HTTPS-origin rule as `APP_URL`. |
| `VK_WEBHOOKS_ENABLED` | `true` only when vk-worker is live |

## Meta (optional)

| Name |
|---|
| `META_WEBHOOKS_ENABLED` |
| `WHATSAPP_WEBHOOKS_ENABLED` |
| `INSTAGRAM_WEBHOOKS_ENABLED` |
| `META_APP_ID` |
| `META_APP_SECRET` |
| `META_WEBHOOK_VERIFY_TOKEN` |
| `META_WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID` |
| `META_INSTAGRAM_LOGIN_CONFIG_ID` |

## AI (optional)

| Name | Notes |
|---|---|
| `AI_API_TOKEN` | If missing, AI features fail gracefully (no web crash) |
| `AI_MODEL` | Model id for provider |
| `AI_DAILY_REQUEST_LIMIT` | Optional throttle (default 500) |

## Storage

| Name | Notes |
|---|---|
| `ATTACHMENT_STORAGE` | `s3` or `filesystem` |
| `S3_ENDPOINT` | |
| `S3_REGION` | |
| `S3_BUCKET` | |
| `S3_ACCESS_KEY_ID` | |
| `S3_SECRET_ACCESS_KEY` | |
| `S3_URL_STYLE` | Optional: `virtual` (default) |
| `ATTACHMENT_STORAGE_PATH` | Required when `ATTACHMENT_STORAGE=filesystem` |

## SMTP (optional — password recovery mail)

| Name |
|---|
| `SMTP_HOST` |
| `SMTP_PORT` |
| `SMTP_USER` |
| `SMTP_PASSWORD` |
| `SMTP_FROM` |

## Analytics upload limits (optional)

`ANALYTICS_MAX_FILE_BYTES`, `ANALYTICS_MAX_SHEETS`, `ANALYTICS_MAX_ROWS`,
`ANALYTICS_MAX_COLUMNS`, `ANALYTICS_MAX_CELL_CHARS`, `ANALYTICS_SAMPLE_ROWS`,
`ANALYTICS_VIEWER_PAGE_SIZE`

## Setup-draft worker (optional)

`SETUP_DRAFT_REMINDER_IDLE_MS`, `SETUP_DRAFT_CANCEL_AFTER_MS`

## CI / runtime internals

| Name | Notes |
|---|---|
| `CI_RELAX_RATE_LIMITS` | `1` only in CI |
| `NODE_ENV` | Set by runtime |
| `PORT` | Injected by the process supervisor when set — do not hardcode |
| `NEXT_TELEMETRY_DISABLED` | Set in Dockerfile |

See also `.env.example` and `deploy/app.env.example`.
