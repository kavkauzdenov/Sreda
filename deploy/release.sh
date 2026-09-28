#!/usr/bin/env bash
set -euo pipefail

cd /opt/biznesoty
image=${1:?Immutable registry image is required}
[[ "$image" =~ ^cr\.yandex/[a-z0-9]+/sreda:[a-f0-9]{40}$ ]] || {
  echo "Invalid immutable image" >&2
  exit 1
}

for env_file in /opt/biznesoty/app.env /opt/biznesoty/db.env /opt/biznesoty/caddy.env; do
  [[ -f "$env_file" ]] || {
    echo "Missing required environment file: $env_file" >&2
    exit 1
  }
  mode="$(stat -c '%a' "$env_file")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || {
    echo "Unsafe permissions on $env_file: $mode (expected 600 or 400)" >&2
    exit 1
  }
done

if ! grep -Eq '^CONNECTION_ENCRYPTION_KEY=.{32,}
args=(-f /opt/biznesoty/deploy/compose.yml)

if grep -q '^TELEGRAM_WEBHOOKS_ENABLED=true$' /opt/biznesoty/app.env; then
  args+=(--profile telegram)
else
  docker compose "${args[@]}" --profile telegram stop telegram-worker || true
fi

if grep -q '^VK_WEBHOOKS_ENABLED=true$' /opt/biznesoty/app.env; then
  args+=(--profile vk)
else
  docker compose "${args[@]}" --profile vk stop vk-worker || true
fi

if grep -Eq '^(META_WEBHOOKS_ENABLED|WHATSAPP_WEBHOOKS_ENABLED|INSTAGRAM_WEBHOOKS_ENABLED)=true$' /opt/biznesoty/app.env; then
  args+=(--profile meta)
else
  docker compose "${args[@]}" --profile meta stop meta-worker || true
fi

rollback_tag="biznesoty:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
current_container="$(docker compose "${args[@]}" ps -q app 2>/dev/null || true)"
if [[ -n "$current_container" ]]; then
  current_image_id="$(docker inspect "$current_container" --format '{{.Image}}')"
  docker image tag "$current_image_id" "$rollback_tag"
fi

docker compose "${args[@]}" up -d db
db_user="$(docker compose "${args[@]}" exec -T db sh -lc 'printf "%s" "$POSTGRES_USER"')"
db_name="$(docker compose "${args[@]}" exec -T db sh -lc 'printf "%s" "$POSTGRES_DB"')"
migration_before="$(docker compose "${args[@]}" exec -T db psql -U "$db_user" -d "$db_name" -tAc 'select count(*) from sreda_migration' 2>/dev/null || printf '0')"

backup_destination="$(grep '^BACKUP_S3_DESTINATION=' /opt/biznesoty/app.env | head -n1 | cut -d= -f2- || true)"
bash /opt/biznesoty/deploy/backup.sh "$backup_destination"

yc iam create-token | docker login --username iam --password-stdin cr.yandex
docker pull "$image"

docker compose "${args[@]}" run --rm migrate
migration_after="$(docker compose "${args[@]}" exec -T db psql -U "$db_user" -d "$db_name" -tAc 'select count(*) from sreda_migration')"
docker compose "${args[@]}" up -d --remove-orphans

healthy=0
for attempt in {1..45}; do
  if docker compose "${args[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -eq 1 ]]; then
  printf 'SREDA_IMAGE=%s\n' "$image" > /opt/biznesoty/deploy/.env
  printf '%s\n' "$image" > /opt/biznesoty/deploy/LAST_GOOD_IMAGE
  docker image rm "$rollback_tag" >/dev/null 2>&1 || true
  echo "Release is healthy (web + all required workers)"
  exit 0
fi

echo "Full health check failed." >&2
if [[ "$migration_before" == "$migration_after" && -n "${current_container:-}" ]]; then
  echo "No new migrations were applied; rolling application containers back." >&2
  export SREDA_IMAGE="$rollback_tag"
  docker compose "${args[@]}" up -d --remove-orphans
  for attempt in {1..30}; do
    if docker compose "${args[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      echo "Rollback completed and is healthy." >&2
      exit 1
    fi
    sleep 2
  done
  echo "Rollback was attempted but health is still failing." >&2
  exit 1
fi

echo "Schema advanced from $migration_before to $migration_after; automatic rollback is intentionally blocked. Restore/forward-fix using the validated pre-deploy backup." >&2
exit 1
 /opt/biznesoty/app.env; then
  command -v openssl >/dev/null 2>&1 || {
    echo "openssl is required to bootstrap CONNECTION_ENCRYPTION_KEY" >&2
    exit 1
  }
  connection_key="$(openssl rand -hex 32)"
  printf '\nCONNECTION_ENCRYPTION_KEY=%s\n' "$connection_key" >> /opt/biznesoty/app.env
  unset connection_key
  chmod 600 /opt/biznesoty/app.env
  echo "Bootstrapped dedicated connection encryption key."
fi

export SREDA_IMAGE="$image"
args=(-f /opt/biznesoty/deploy/compose.yml)

if grep -q '^TELEGRAM_WEBHOOKS_ENABLED=true$' /opt/biznesoty/app.env; then
  args+=(--profile telegram)
else
  docker compose "${args[@]}" --profile telegram stop telegram-worker || true
fi

if grep -q '^VK_WEBHOOKS_ENABLED=true$' /opt/biznesoty/app.env; then
  args+=(--profile vk)
else
  docker compose "${args[@]}" --profile vk stop vk-worker || true
fi

if grep -Eq '^(META_WEBHOOKS_ENABLED|WHATSAPP_WEBHOOKS_ENABLED|INSTAGRAM_WEBHOOKS_ENABLED)=true$' /opt/biznesoty/app.env; then
  args+=(--profile meta)
else
  docker compose "${args[@]}" --profile meta stop meta-worker || true
fi

rollback_tag="biznesoty:rollback-$(date -u +%Y%m%dT%H%M%SZ)"
current_container="$(docker compose "${args[@]}" ps -q app 2>/dev/null || true)"
if [[ -n "$current_container" ]]; then
  current_image_id="$(docker inspect "$current_container" --format '{{.Image}}')"
  docker image tag "$current_image_id" "$rollback_tag"
fi

docker compose "${args[@]}" up -d db
db_user="$(docker compose "${args[@]}" exec -T db sh -lc 'printf "%s" "$POSTGRES_USER"')"
db_name="$(docker compose "${args[@]}" exec -T db sh -lc 'printf "%s" "$POSTGRES_DB"')"
migration_before="$(docker compose "${args[@]}" exec -T db psql -U "$db_user" -d "$db_name" -tAc 'select count(*) from sreda_migration' 2>/dev/null || printf '0')"

backup_destination="$(grep '^BACKUP_S3_DESTINATION=' /opt/biznesoty/app.env | head -n1 | cut -d= -f2- || true)"
bash /opt/biznesoty/deploy/backup.sh "$backup_destination"

yc iam create-token | docker login --username iam --password-stdin cr.yandex
docker pull "$image"

docker compose "${args[@]}" run --rm migrate
migration_after="$(docker compose "${args[@]}" exec -T db psql -U "$db_user" -d "$db_name" -tAc 'select count(*) from sreda_migration')"
docker compose "${args[@]}" up -d --remove-orphans

healthy=0
for attempt in {1..45}; do
  if docker compose "${args[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    healthy=1
    break
  fi
  sleep 2
done

if [[ "$healthy" -eq 1 ]]; then
  printf 'SREDA_IMAGE=%s\n' "$image" > /opt/biznesoty/deploy/.env
  printf '%s\n' "$image" > /opt/biznesoty/deploy/LAST_GOOD_IMAGE
  docker image rm "$rollback_tag" >/dev/null 2>&1 || true
  echo "Release is healthy (web + all required workers)"
  exit 0
fi

echo "Full health check failed." >&2
if [[ "$migration_before" == "$migration_after" && -n "${current_container:-}" ]]; then
  echo "No new migrations were applied; rolling application containers back." >&2
  export SREDA_IMAGE="$rollback_tag"
  docker compose "${args[@]}" up -d --remove-orphans
  for attempt in {1..30}; do
    if docker compose "${args[@]}" exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      echo "Rollback completed and is healthy." >&2
      exit 1
    fi
    sleep 2
  done
  echo "Rollback was attempted but health is still failing." >&2
  exit 1
fi

echo "Schema advanced from $migration_before to $migration_after; automatic rollback is intentionally blocked. Restore/forward-fix using the validated pre-deploy backup." >&2
exit 1
