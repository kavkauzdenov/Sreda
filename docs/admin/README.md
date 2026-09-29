# Biznesoty Admin Panel

Platform staff console served by the **same web service** at path `/admin` (not a separate process).

## Architecture

- Routes under `src/app/admin/` — **outside** `src/app/(app)/` so business-membership layout does not apply.
- API: `/api/admin/*` (cookie session + Origin check on mutations).
- Server gate for console pages: `requireAdminPage` from `@/server/admin/page-admin`.
- Login at `/admin/login` is ungated; after sign-in it checks `/api/admin/me`.

## RBAC

Roles (distinct from tenant `business_member` roles):

| Role | Typical access |
|------|----------------|
| `SUPER_ADMIN` | Full platform admin |
| `SUPPORT` | Read + support/outbox retry |
| `MODERATOR` | Moderation + limited read |
| `FINANCE` | Subscriptions manage + read |

Permissions are defined in `src/server/admin/permissions.ts`. Nav is filtered by role.

## Bootstrap

First `SUPER_ADMIN` is created via **CLI only** (no public HTTP endpoint):

```bash
PLATFORM_ADMIN_BOOTSTRAP_USERNAME=<existing-username> \
PLATFORM_ADMIN_BOOTSTRAP_TOKEN=<secret-at-least-32-chars> \
PLATFORM_ADMIN_BOOTSTRAP_CONFIRM=YES \
npm run admin:bootstrap
```

The bootstrap marker in `platform_admin_bootstrap` prevents accidental reuse.
Further roles are assigned from **Admin → Пользователи → карточка** (requires `admin.admins.manage`).

## Explicit non-goals

- **No impersonation** of end users.
- **MFA for admins** — deferred.
- **No secrets in API responses** — only `configured` / `not_configured` flags.
- **No fake metrics** — empty/loading/error states only.
