# Backup & restore

## Staging Postgres

Staging uses a managed or self-hosted PostgreSQL instance shared by web and workers.

Recommended practice:

1. Use the provider’s snapshots / backup features for the staging database.
2. Before risky migrations: take a snapshot; record deployed git SHA and migration ledger checksums (`npm run staging:check -- --database` is read-only).
3. Keep attachment bucket separate and private; DB dump does not replace object storage backup.

## Scripted dump (self-hosted / Yandex path)

`deploy/backup.sh` (used with compose on a VM):

1. `pg_dump -Fc` from compose service `db` into `/opt/biznesoty/backups/sreda-<UTC>.dump`
2. `pg_restore --list` validates archive structure
3. Upload to Object Storage (`s3://…` via Yandex endpoint in the script)

The script validates archive listing only — **a restore drill is still required**.

## Restore checklist

- [ ] Freeze writers if production-like (disable webhooks / stop workers) before cutover restore.
- [ ] Restore into an **empty** target DB with compatible PostgreSQL major version.
- [ ] `pg_restore` custom format dump; verify table counts for `user`, `business`, `business_connection`, `lead`, outbox tables.
- [ ] Confirm migration ledger matches expected head (currently through **052**).
- [ ] Restore / re-point S3 bucket credentials; spot-check one attachment download.
- [ ] Set `APP_URL`, `BETTER_AUTH_SECRET` (same secret if decrypting existing tokens), webhook flags.
- [ ] Start web → migrate if needed → health `/api/health/web`.
- [ ] Start workers; confirm heartbeats; re-register Telegram/VK/Meta webhooks for the new origin.
- [ ] Smoke: login, open business, inbound test message, staff notify binding still valid.
- [ ] Document SHA, dump filename, and time of drill.

Never commit dumps or `.env` files. Never rewrite applied migration files to “fix” a restore.
