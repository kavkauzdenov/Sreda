# Architecture — БизнеСоты

## Model

```
User ──membership(role)──► Business
                              ├── business_solution (+ solution_config)
                              ├── business_connection (+ secrets, runtime)
                              └── business data (leads, orders, booking, CRM, posts, …)
```

- Public IDs (`usr_…`, `biz_…`) для UI; внутренние UUID в БД.
- Доступ всегда через активное `business_member` + permission, не через «знание ID».
- Архив бизнеса (`archived_at`) останавливает бот-маршрутизацию; данные не смешиваются с другими tenant.

## Layers

| Layer | Location | Rule |
|---|---|---|
| UI | `src/app`, `src/components`, `src/hooks` | Нет прямого импорта server-модулей |
| HTTP | `src/app/api/**`, `src/server/http` | Сессия / Origin / валидация → service |
| Domain | `src/server/{leads,orders,booking,posts,clients,…}` | Без React и SDK площадок |
| Bot core | `src/server/bot` | Общие сценарии клиента (`routeBot`, flows) |
| Channel adapters | `src/server/telegram`, `vk`, `meta` | Verify → persist update → domain / outbox |
| Workers | `scripts/*-worker.mts` | Доставка outbox + shared jobs |
| DB | `src/server/db`, `/migrations` | Kysely + PostgreSQL |

## Request path (web)

1. better-auth session (`/api/auth`)
2. `requireBusiness(db, userId, publicId, permission)`
3. Domain service mutation/query scoped by `business_id`
4. Audit where applicable (`business_audit_log`)

## Inbound channel path

1. Webhook `/api/telegram/[id]`, `/api/vk/[id]`, `/api/meta/webhook`
2. Provider verification (secret header / confirmation / Meta signature)
3. Deduped update row (`telegram_update` / `vk_update` / `meta_update`)
4. Shared bot or communications use case inside a transaction
5. Outbox insert (same TX as domain write when outbound reply is needed)

Workers never trust a browser `businessId`: business is derived from the verified connection.

## Solutions vs channels

- Solutions change bot menu and which domain tables are used.
- Channels are transport: one business can have Telegram + VK (+ Meta) connections.
- Activation entitlements live in `business_solution` (`active` / `trial` / `expired` / `disabled`).

## Platform admin

Separate surface `/admin` + `/api/admin/*` with `platform_admin` roles. Same web process; not a separate service. See [PERMISSIONS.md](PERMISSIONS.md) and `docs/admin/README.md`.
