# Closed Beta — pre-hardening state

## CURRENT_MAIN_SHA
`429e21d60090671b541f41d1eb72d3a8ac503e2a` (PR #53 merged)

## HARDENING_BRANCH
`cursor/biznesoty-beta-v1-hardening-258e`

## OPEN_PRS
Draft legacy only (#6–#13, Sep 12–13). Not merge candidates for Beta.

## LATEST_MIGRATION (hardening)
`057_notification_types_product_events.sql` (after 056 AI usage)

## CURRENT_TEST_COUNT
~43 test files; 318+ passing on last full run (11 skip).

## CURRENT_SERVICES (Biznebiznesoty-staging)
web, telegram-worker, vk-worker, Postgres, S3 bucket.

## CURRENT_SOLUTIONS
leads, orders, booking, admin_messages, autopost (+ moderation catalog-only).

## CURRENT_CHANNELS
telegram, vk, whatsapp/instagram (Meta code), max (typed only).

## PR #53 RESULT
MERGED. Includes ProductEditor, BookingSetupWizard, bot nav, request_contact, customer profile, money formatter, order modal contrast, migration 052.

## HARDENING PROGRESS
- Docs + design tokens
- Request IDs, health, rate limits
- Search, client merge, settings IA, setup checklist
- Billing domain (no fake payments)
- AI usage accounting + daily limits
- Low-stock notifications (deduped)
- Inbox waiting_since + internal notes
- Entity import (clients/products)
- Reply templates
- Session management UI
- Product analytics events
- Playwright smoke scaffold

## GATE
Continue Closed Beta hardening → green CI → merge → staging deploy matching SHA.
