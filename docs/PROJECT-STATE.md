# БизнеСоты — текущее состояние проекта

**Обновлено:** 28 сентября 2026  
**Source of truth:** `main` + актуальный pre-release PR. Старые ветки/документы не считать текущим состоянием.

## Продукт

БизнеСоты — SaaS готовых решений для малого бизнеса. Основные рабочие области:
- единые клиенты/CRM;
- приём заявок;
- приём заказов (Orders V2: каталог, склад, fulfillment, назначение сотрудника);
- сообщения/администратор;
- онлайн-запись;
- автопостинг;
- Telegram и VK; Meta (WhatsApp/Instagram) подключается отдельным официальным контуром.

Публичная формула продукта: выбрал → подключил → настроил → работает.

## Текущее production-состояние перед hardening-релизом

- canonical origin: `https://biznesoty.ru`;
- российский production использует Docker Compose + PostgreSQL + Caddy;
- текущая production БД исторически сохранила legacy `POSTGRES_USER/POSTGRES_DB`; deploy-код обязан читать эти значения из окружения, а не хардкодить новое имя;
- migration ledger дошёл как минимум до `066_orders_v2.sql`;
- Orders V2 и фикс закрытия диалога уже были развёрнуты;
- Telegram включён; VK/autopost/booking reminders могут быть отключены конфигурацией конкретного окружения;
- staging/relay при необходимости идёт через отдельный контур на той же Docker-инфраструктуре, не через сторонние PaaS.

## Hardening 28 сентября

Pre-release hardening устраняет:
- зависимость общих background jobs от Telegram worker;
- неполный worker healthcheck;
- неправильный Meta readiness через `vk_runtime`;
- неоднозначность legacy Leads: заявки ограничены Telegram/VK;
- неатомарное закрытие диалога;
- связь шифрования интеграционных токенов с единственным auth-secret;
- несовместимый с legacy-БД backup/DB healthcheck;
- отсутствие обязательного backup gate перед migration;
- отсутствие безопасного rollback приложения;
- отсутствие build SHA в runtime;
- неполные security headers;
- отсутствие обязательного PIN для platform admin;
- отсутствие security dependency gates.

## Deployment contract

Production release:
1. только `main`;
2. Verify должен быть зелёным для точного SHA;
3. image tag immutable: `cr.yandex/<registry>/sreda:<40-char-sha>`;
4. обязательны `app.env`, `db.env`, `caddy.env` с правами 0600/0400;
5. локальный validated PostgreSQL backup выполняется **до** migrations;
6. при настроенном `BACKUP_S3_DESTINATION` backup и checksum дополнительно отправляются в российский Object Storage;
7. migrations forward-only;
8. после запуска обязателен полный `/api/health`;
9. при health failure автоматический application rollback допускается только если migration ledger не изменился;
10. `/api/version` используется для подтверждения фактического commit.

## Worker contract

- `background-worker`: notifications, autopost scheduling, booking reminders, entity reminders, setup drafts;
- `telegram-worker`: только Telegram delivery/cleanup;
- `vk-worker`: только VK delivery/cleanup;
- `meta-worker`: WhatsApp/Instagram delivery/cleanup.

Отключение Telegram не должно останавливать общие background jobs.

## Security contract

- Better Auth secret и connection encryption key — разные назначения;
- `CONNECTION_ENCRYPTION_KEY` используется для новых integration secrets;
- legacy v1 ciphertext продолжает читаться через fallback, что позволяет ротацию без массового разрыва подключений;
- platform admin обязан иметь PIN;
- CSP сначала работает в Report-Only;
- operational topology и IP-адреса не публикуются в репозитории;
- реальные секреты никогда не коммитятся.

## Перед публичным коммерческим запуском

Остаются внешние/операционные задачи, которые нельзя завершить одним изменением репозитория:
- настроить отдельный российский Object Storage destination и проверить upload;
- выполнить `deploy/restore-drill.sh` на реальном production backup;
- провести текущую проверку server-side Meta egress/routing;
- выбрать и подключить реальные merchant credentials платёжного провайдера;
- провести maintenance window для обновлений ОС VPS.

## Правила продолжения

Перед каждой задачей:
1. проверить актуальный `main` и открытые PR;
2. не использовать старые PR/ветки как source of truth;
3. не подменять реальные секреты фиктивными;
4. не считать Git checkout доказательством running image — проверять `/api/version`/image SHA;
5. не откатывать production БД автоматически;
6. изменения схемы всегда сопровождаются backup gate и миграционными тестами.
