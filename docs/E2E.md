# E2E

Automated suite ≠ full product E2E. Use both.

## Automated

| Command | Coverage |
|---|---|
| `npm test` | ~39 files under `tests/*.test.mjs` (domain, migrations, UX contracts, Meta stubs, hardening) |
| `npm run test:http` | Built-server HTTP flows (`tests/http/`) |
| CI Verify | Above + lint/typecheck/build + Docker worker import smoke |
| `npm run test:e2e` | Playwright smoke (`e2e/critical-path.spec.mjs`) against `E2E_BASE_URL` / `AUDIT_BASE_URL` |

PostgreSQL-backed race tests need `TEST_DATABASE_URL` (provided in CI). Local PGlite covers many migration/unit paths.

## Manual staging E2E (Closed Beta)

Prerequisite: isolated Telegram bot + VK community, separate DB/bucket, workers healthy. Full narrative checklist historically lives in `docs/archive/PRE-RELEASE-E2E.md`; condensed gate for beta:

1. **Auth:** register, login, logout, recovery code, password change, PIN if enabled.
2. **Tenant:** two businesses A/B; invite admin/operator; revoke operator mid-dialogue.
3. **Channels:** connect Telegram + VK with invalid then valid tokens; confirm webhook rejects bad secrets.
4. **Leads:** bot form → one CRM lead; take/close; staff notify to verified destination only.
5. **Messages:** inbox take assignment race; reply with text + attachment.
6. **Orders:** catalog/variants/stock; bot order; status changes in `/orders`.
7. **Booking:** service/specialist/schedule; concurrent slot conflict; reminder once after worker restart.
8. **Autopost:** schedule in business TZ; partial failure on one platform does not duplicate success.
9. **Meta (if flags on):** OAuth connect smoke + inbound/outbound without claiming production readiness.
10. **Isolation:** data of A invisible in B; operator cannot manage connections/secrets.

## Evidence

- Prefer staging URLs and redacted screenshots; never paste bot tokens.
- Note git SHA + migration head with the E2E run.
- Browser environments that block localhost need `AUDIT_BASE_URL` pointing at staging.
