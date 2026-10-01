# Permissions

Two separate RBAC systems: **tenant** (business members) and **platform admin**.

## Tenant roles (`business_member.role`)

Source: `src/server/access/permissions.ts`.

| Permission | owner | admin | operator |
|---|---|---|---|
| `clients.read` / `clients.write` | ✓ | ✓ | ✓ |
| `leads.write` | ✓ | ✓ | ✓ |
| `messages.write` | ✓ | ✓ | ✓ |
| `booking.write` | ✓ | ✓ | ✓ |
| `orders.write` | ✓ | ✓ | ✓ |
| `notifications.read` | ✓ | ✓ | ✓ |
| `analytics.view` | ✓ | ✓ | ✓ |
| `posts.manage` | ✓ | ✓ | ✗ |
| `settings.manage` | ✓ | ✓ | ✗ |
| `connections.manage` | ✓ | ✓ | ✗ |
| `solutions.manage` | ✓ | ✓ | ✗ |
| `analytics.export` / `upload` / `ai` | ✓ | ✓ | ✗ |
| `intelligence.manage` | ✓ | ✓ | ✗ |

`requireBusiness` returns 404 for missing/foreign business (same as not found) and 403 when membership exists but permission is denied.

Invitations: owner/admin invite `admin` or `operator`. Last owner cannot be demoted/removed (enforced in workspace services).

## Platform admin (`platform_admin`)

Source: `src/server/admin/permissions.ts`. Roles: `SUPER_ADMIN`, `SUPPORT`, `MODERATOR`, `FINANCE`.

Notable capabilities:

- Subscriptions read/manage → admin override of `business_solution` (not a payment provider).
- Support outbox retry, moderation, user/business suspend, audit read.
- Bootstrap first `SUPER_ADMIN` via CLI only: `npm run admin:bootstrap`.

Non-goals: user impersonation; MFA for admins (deferred). Details: `docs/admin/README.md`.
