# Billing domain

## Current mode

Billing has an explicit runtime policy:

- `BILLING_MODE=closed_beta` — current pilot mode. Owners may activate solutions
  without a payment-provider event. The UI must state that payment is not connected.
- `BILLING_MODE=paid` — activation is denied unless the database contains an
  active/trialing provider-backed `business_subscription` plus a matching
  `business_subscription_item`. Only real provider types (`yookassa` / `stripe`)
  satisfy this guard.

Unknown billing modes fail closed.

The production default remains `closed_beta` until merchant credentials,
receipt/tax configuration and provider webhooks are configured and accepted.

## Source of truth

| Concern | Store | Notes |
|---|---|---|
| Entitlement | `business_solution` | Runtime access: active/trial and non-expired |
| Provider subscription ledger | `business_subscription` + `business_subscription_item` | Required for new grants in paid mode |
| Catalog prices | `billing_plan` + `src/lib/productSolutions.ts` | Catalog estimate, not proof of payment |

There is no duplicate `billing_entitlement` table.

Platform admins with the appropriate permission may override solution state for
support/operations; those actions are audited and are not payment receipts.

## Domain module

`src/server/billing/`:

- `getEntitlement` — reads effective runtime entitlement.
- `assertEntitlement` — denies use when access is absent/expired/paused.
- `assertCanGrantEntitlement` — enforces `BILLING_MODE`.
- `BillingProvider` — provider boundary.
- `NoopBillingProvider` — refuses checkout with `BILLING_NOT_CONFIGURED`;
  it never fabricates successful payment.
- `MockBillingProvider` — tests/development only and blocked in production.

## Paid-mode activation contract

A redirect from a checkout page is never enough to grant access.

Before switching `BILLING_MODE=paid`, the provider integration must:
1. authenticate and verify provider callbacks;
2. process provider event IDs idempotently;
3. write/update the subscription ledger only from confirmed provider state;
4. then let `assertCanGrantEntitlement` authorize activation;
5. handle renewal, failed payment, cancellation, expiry and grace-period policy;
6. satisfy merchant receipt/tax requirements.

Until these external provider details are configured, production checkout must
continue to fail honestly rather than simulate payment.

## UI contract

- `/billing` shows active solutions and catalog estimates.
- It must not show a next-charge date or “payment succeeded” without real provider data.
- In Closed Beta it explicitly states that payment is not connected.
- Product price is an estimate/catalog value until provider billing is enabled.

## Migration

`055_billing_domain.sql` provides the provider-agnostic plan/subscription ledger.
Hardening does not fabricate payment events or merchant credentials.
