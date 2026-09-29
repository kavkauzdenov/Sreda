# Workers

Long-running Node processes. Same Docker image as web; different start commands.

## Processes

| Name | Script | Requires |
|---|---|---|
| telegram-worker | `npm run worker:telegram` | `TELEGRAM_WEBHOOKS_ENABLED=true` |
| vk-worker | `npm run worker:vk` | `VK_WEBHOOKS_ENABLED=true` |

Both share `DATABASE_URL`, `BETTER_AUTH_SECRET`, `APP_URL`, and S3 settings with web.

## Ownership of work

**telegram-worker** (sole owner of shared scheduled work):

1. Staff notification queue (`queueNotification`)
2. Autopost: materialize recurring + queue scheduled (`posts/worker`)
3. Booking reminders + calendar entity reminders
4. `TelegramService.deliverOne()`
5. `MetaChannelService.deliverOne()` when Meta/WA/IG flags enabled
6. Heartbeats: `autopost`, `booking_reminders`, `entity_reminders`, `telegram`, optionally `meta`
7. Periodic cleanup of stale dialogs / delivered outbox rows

**vk-worker**:

1. `VKService.deliverOne()` only
2. Heartbeat `vk`
3. Cleanup of old delivered `vk_outbox` (non-post rows)

Do not run two telegram-workers against one DB without a redesign: heartbeats and claims assume a single owner loop.

## Health

- `/api/health/web` — web + DB (deploy gate for web)
- `/api/health` — also required worker heartbeats when solutions need them

Stopping a required worker should mark full health unhealthy after activation; web-only health stays deployable.

## Local

```bash
TELEGRAM_WEBHOOKS_ENABLED=true npm run worker:telegram
VK_WEBHOOKS_ENABLED=true npm run worker:vk
```
