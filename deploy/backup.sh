#!/usr/bin/env bash
set -euo pipefail
umask 077
# Compose interpolates the app image even when only the db service is used.
export SREDA_IMAGE="${SREDA_IMAGE:-biznesoty:backup-placeholder}"

destination=${1:-}
if [[ -n "$destination" && "$destination" != s3://* ]]; then
  echo "Invalid backup destination" >&2
  exit 1
fi

cd /opt/biznesoty/deploy
mkdir -p /opt/biznesoty/backups

db_user="$(docker compose -f compose.yml exec -T db sh -lc 'printf "%s" "$POSTGRES_USER"')"
db_name="$(docker compose -f compose.yml exec -T db sh -lc 'printf "%s" "$POSTGRES_DB"')"
[[ -n "$db_user" && -n "$db_name" ]] || {
  echo "POSTGRES_USER/POSTGRES_DB are not configured" >&2
  exit 1
}

backup="/opt/biznesoty/backups/biznesoty-$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose -f compose.yml exec -T db pg_dump -U "$db_user" -d "$db_name" -Fc > "$backup"
docker compose -f compose.yml exec -T db pg_restore --list < "$backup" > /dev/null
sha256sum "$backup" > "$backup.sha256"

if [[ -n "$destination" ]]; then
  command -v aws >/dev/null 2>&1 || {
    echo "aws CLI is required for remote backup upload" >&2
    exit 1
  }
  aws --endpoint-url=https://storage.yandexcloud.net s3 cp "$backup" "${destination%/}/$(basename "$backup")" --only-show-errors
  aws --endpoint-url=https://storage.yandexcloud.net s3 cp "$backup.sha256" "${destination%/}/$(basename "$backup.sha256")" --only-show-errors
else
  echo "WARNING: BACKUP_S3_DESTINATION is not configured; backup is local-only." >&2
fi

printf '%s\n' "$backup"
