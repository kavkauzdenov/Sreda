# Clients V2

CRM foundation for «БизнеСоты». The `client` table remains the Source of Truth.

## Architecture

Backend modules under `src/server/clients/`:

| Module | Responsibility |
|--------|----------------|
| `service.ts` | Legacy API + `matchClient` / `clientActivity` / create-update |
| `list.ts` | V2 list with filters, keyset pagination, batched enrichment |
| `summary.ts` | KPI cards |
| `detail.ts` | V2 overview payload + lazy tab loaders |
| `timeline.ts` | Unified activity + notes stream |
| `tags.ts` | Tags, profile note, assignment |
| `duplicates.ts` | Strong-signal candidates + decisions |
| `merge.ts` | Owner/admin merge with entity remapping |
| `types.ts` | DTOs, cursors, activity labels |

Frontend under `src/components/clients-v2/` (workspace split mirroring Leads V2).

## Entities (additive migration `063_clients_v2.sql`)

- `client.assigned_user_id` / `assigned_at` / `profile_note`
- `client_tag` / `client_tag_link`
- `client_duplicate_decision` (`separate` | `merged`)

No DROP / TRUNCATE / destructive rewrite of existing clients.

## API

Base: `/api/v1/businesses/:id/clients`

| Request | Purpose |
|---------|---------|
| `GET ?view=summary` | KPI |
| `GET ?view=v2&…` | Keyset list |
| `GET ?view=tags` / `assignees` | Lookups |
| `GET /:clientId?view=v2` | Overview detail |
| `GET /:clientId?view=timeline\|leads\|orders\|bookings\|conversations\|notes` | Lazy tabs |
| `POST /` | Create client |
| `PATCH /:clientId` | Update |
| `POST /:clientId` `{text}` | Internal note |
| `POST /:clientId` `{action: assign\|attach_tag\|detach_tag\|profile_note\|duplicate_decision}` | Mutations |
| `POST /merge` | Merge (owner/admin) |

Legacy list/detail without `view=v2` remain for callers.

### List filters

`search`, `channel`, `activity`, `hasLeads`, `hasOrders`, `hasBookings`, `hasOpenConversation`, `hasNotes`, `tagId`, `assignedUserId`, `newOnly`, `cursor`, `limit` (default 50, max 100).

Cursor: opaque `base64url(JSON({t,id}))` over `last_seen_at DESC, id DESC`.

## Permissions

| Action | owner | admin | operator |
|--------|-------|-------|----------|
| read / list / timeline | ✓ | ✓ | ✓ |
| write / notes / tags | ✓ | ✓ | ✓ |
| claim unassigned | ✓ | ✓ | ✓ (self only) |
| assign other member | ✓ | ✓ | ✗ |
| merge | ✓ | ✓ | ✗ |

All queries scoped by `business_id`.

## Duplicate rules

Candidates only on strong signals: normalized phone, case-insensitive email, platform identity. **Never** name-only.

«Это разные клиенты» stores `decision=separate` for the canonical pair and hides the suggestion.

## Merge rules

- Target wins for non-empty contacts; source fills blanks.
- Tags: UNION.
- Assignment: keep target if set, else inherit source.
- Profile notes: keep target; if both set, source note becomes an internal `client_note`.
- Remap: identities, leads, bookings, orders, carts, notes, activity, conversations, calendar events, tag links.
- Source: `archived_at=now`, `merged_into_id=target`.

## Timeline

Sources: `client_activity` + `client_note` (as `client.note_added`). Keyset by `created_at DESC, id DESC`. Human titles via `ACTIVITY_LABELS`.

## Testing

- `tests/clients-v2.test.mjs` — domain coverage
- Existing `tests/clients.test.mjs` / `search-merge.test.mjs` — regression
- HTTP / Playwright audits cover UI + multi-tenant paths

## Known constraints

- WhatsApp/Instagram channels appear when identities/conversations exist; Meta connect remains separate.
- Staff CRM edits do not bump `last_seen_at` (client-facing events do).
- Legacy UUID `after=` pagination remains for old callers; V2 UI uses keyset cursors only.
