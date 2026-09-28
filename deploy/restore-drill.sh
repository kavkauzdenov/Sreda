#!/usr/bin/env bash
set -euo pipefail
umask 077

backup=${1:?Usage: restore-drill.sh /path/to/backup.dump}
[[ -r "$backup" ]] || { echo "Backup is not readable: $backup" >&2; exit 1; }

name="biznesoty-restore-drill-$$"
password="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --rm   --name "$name"   -e POSTGRES_USER=restore   -e POSTGRES_PASSWORD="$password"   -e POSTGRES_DB=restore_test   postgres:17-bookworm >/dev/null

for attempt in {1..30}; do
  if docker exec "$name" pg_isready -U restore -d restore_test >/dev/null 2>&1; then
    break
  fi
  [[ "$attempt" -lt 30 ]] || { echo "Disposable PostgreSQL did not become ready" >&2; exit 1; }
  sleep 1
done

docker exec -i "$name" pg_restore   -U restore   -d restore_test   --no-owner   --no-privileges   < "$backup"

docker exec "$name" psql -U restore -d restore_test -v ON_ERROR_STOP=1 -tAc "
  select case
    when to_regclass('public.business') is not null
     and to_regclass('public.user') is not null
     and to_regclass('public.sreda_migration') is not null
    then 'RESTORE_OK'
    else 'RESTORE_INVALID'
  end;
" | grep -qx 'RESTORE_OK'

echo "Restore drill passed: $backup"
