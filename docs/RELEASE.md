# Release checklist

Use for promoting a commit to **Biznebiznesoty-staging** (`main`). Not a production go-live checklist.

## Before merge

- [ ] PR scoped; no secrets in tree
- [ ] Migrations append-only; latest expected head documented
- [ ] `npm test` and relevant new tests green locally
- [ ] GitHub **Verify** green on the merge commit (`test`, `lint`, `typecheck`, `build`, `test:http`, Docker import smoke)

## Staging deploy

- [ ] Deploy `main` SHA to staging (web + both workers)
- [ ] Pre-deploy migrate succeeds; ledger at expected migration (052+)
- [ ] `/api/health/web` OK
- [ ] With webhook flags on: `/api/health` OK (heartbeats present)
- [ ] `npm run staging:check` (and `--database` if schema changed)

## Smoke (staging)

- [ ] Register / login / recovery path still works on a throwaway account
- [ ] Create or open a business; switch businesses; operator permission still enforced
- [ ] Telegram and/or VK: inbound message → CRM / bot menu
- [ ] One solution path each that changed in the release (leads / orders / booking / messages / posts)
- [ ] Attachment upload/download if storage touched
- [ ] Admin override path only if finance/support changes shipped

## After deploy

- [ ] Record SHA, migration head, and smoke results in the release note / chat
- [ ] If failure: roll forward with fix or restore from snapshot ([BACKUP.md](BACKUP.md)); do not rewrite migrations

## Explicitly out of scope here

- Public production DNS cutover
- Live payment provider enablement
- Connecting production messenger bots
