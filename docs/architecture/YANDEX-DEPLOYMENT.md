# Яндекс Cloud / российский production

## Назначение

Production использует одну российскую VM для закрытого пилота:
PostgreSQL, Next.js app, Caddy и отдельные workers. Это не HA-кластер:
отказ VM останавливает приложение до восстановления/переноса.

Секреты и operational topology не публикуются в репозитории.

## Runtime-сервисы

`deploy/compose.yml`:
- `db` — PostgreSQL 17;
- `app` — web/API;
- `background-worker` — notifications, автопостинг, booking/entity reminders, setup drafts;
- `telegram-worker` — профиль `telegram`;
- `vk-worker` — профиль `vk`;
- `meta-worker` — профиль `meta`;
- `migrate` — одноразовый tools-профиль;
- `caddy` — TLS/reverse proxy.

DB healthcheck использует фактические `POSTGRES_USER` и `POSTGRES_DB` из `db.env`.
Это обязательно для совместимости с legacy production databases.

## Обязательные файлы VM

- `/opt/biznesoty/app.env`
- `/opt/biznesoty/db.env`
- `/opt/biznesoty/caddy.env`
- `/opt/biznesoty/deploy/*`

Права env: 0600 или 0400. Release прекращается до любых миграций, если файл
отсутствует или имеет небезопасные права.

Основные secrets:
- `BETTER_AUTH_SECRET` — identity/auth;
- `CONNECTION_ENCRYPTION_KEY` — новое шифрование Telegram/VK/Meta credentials; при первом hardened release автоматически создаётся на VM, если отсутствует, без вывода значения в лог;
- `CONNECTION_ENCRYPTION_PREVIOUS_KEYS` — только на период ротации ключа;
- provider/API/S3 credentials по используемым функциям.

Не менять оба security keys одновременно без плана восстановления.

## Production release

Единственный штатный путь — `.github/workflows/deploy-yandex.yml`.

Workflow:
1. запускается вручную только для `main`;
2. требует успешный Verify точного SHA;
3. собирает immutable image `cr.yandex/<registry>/sreda:<git-sha>`;
4. в image зашиваются `APP_BUILD_SHA` и `APP_BUILD_TIME`;
5. копируются deploy scripts;
6. по SSH запускается `release.sh <immutable-image>`.

На VM `release.sh`:
1. проверяет env-файлы и их права;
2. определяет нужные Telegram/VK/Meta profiles;
3. сохраняет локальный rollback tag текущего app image;
4. запускает/проверяет DB;
5. выполняет **validated backup до migrations**;
6. при настроенном `BACKUP_S3_DESTINATION` отправляет dump + SHA256 в российский Object Storage;
7. получает immutable image;
8. применяет forward-only migrations;
9. запускает app + background worker + включённые channel workers;
10. ждёт полного `/api/health`;
11. только после успеха пишет новый `deploy/.env` и `LAST_GOOD_IMAGE`.

Если healthcheck не проходит и migration ledger не изменился, выполняется автоматический
application rollback. Если migrations уже применились, автоматический rollback блокируется:
используется forward-fix либо восстановление из pre-deploy backup.

## Version verification

После релиза:

```bash
curl -fsS https://biznesoty.ru/api/version
curl -fsS https://biznesoty.ru/api/health
```

`/api/version` должен вернуть ожидаемый git commit. Не использовать host checkout или
тег `latest` как доказательство фактической версии контейнера.

## Backup

`deploy/backup.sh [s3://bucket/prefix]`:
- читает реальные DB user/name из работающего DB container;
- создаёт `pg_dump -Fc`;
- проверяет `pg_restore --list`;
- создаёт SHA256;
- при destination загружает dump + checksum.

Локальный backup — deploy gate, но **не disaster recovery**. Для production обязательно
настроить отдельный российский Object Storage через `BACKUP_S3_DESTINATION`.

## Restore drill

После настройки Object Storage и затем регулярно:

```bash
bash /opt/biznesoty/deploy/restore-drill.sh /opt/biznesoty/backups/<backup>.dump
```

Скрипт поднимает отдельный одноразовый PostgreSQL 17 container, восстанавливает dump с
`--no-owner --no-privileges`, проверяет базовые таблицы и уничтожает disposable container.
Он не пишет в production database.

## Channel enablement

Telegram/VK/Meta включаются отдельными env flags. Общий `background-worker` не зависит
ни от одного channel flag. Поэтому выключение Telegram не должно останавливать
автопостинг, notification dispatcher или reminders.

Полный health проверяет:
- web/database;
- background + notification/setup/entity heartbeats;
- Telegram/VK/Meta worker только когда соответствующий канал включён;
- autopost/booking reminder heartbeat, когда активны соответствующие решения.

## Network routing

Маршрутизация внешних API — operational concern. Не хранить в публичном репозитории
IP конкретных VPS/peers/AllowedIPs.

Для Meta нельзя считать статический DNS snapshot постоянным: перед включением канала
проверять текущий egress непосредственно на production VM. Не расширять маршруты до
`0.0.0.0/0` ради одного провайдера без отдельного архитектурного решения.

## Maintenance

До массового запуска:
- настроить внешний uptime monitor;
- подтвердить Object Storage upload;
- выполнить restore drill;
- провести проверку Meta egress;
- запланировать maintenance window для обновления ОС;
- иметь актуальный snapshot/backup перед системным upgrade.
