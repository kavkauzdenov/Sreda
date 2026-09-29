# Biznesoty: единые бизнес-решения — проверка перед выпуском

Дата: 16 сентября 2026. Рабочая ветка: `codex/unified-business-foundation`. Draft PR: https://github.com/9wwnmw2szc-hue/Biznesoty/pull/19 . Merge и production deploy не выполнялись.

## Исходное состояние и совместимость

Работа продолжает main `19fea9c0404f9c8237156d5c159472d708183db5`. Commit `dd2ae1a` и утраченные незапушенные изменения не были доступны в восстановленной истории. Реализация восстановлена поверх доступного main; существующие Business, business_member, Connections, connection_secret, business_solution, solution_config, lead_setup, коммуникации, Telegram/VK runtimes и outbox переиспользованы. Каталог сохраняет `leads`, `autopost`, `booking`, `admin_messages`. Один бот бизнеса маршрутизирует активные решения.

Сохранены Next.js App Router, TypeScript, Kysely/PostgreSQL, существующие регистрация, вход, PIN, восстановление, приглашения и роли. Миграции 001–018 не изменены. Утверждённые изображения сохранены в GitHub. Оплата не реализована и не является условием использования новых функций.

## Что реализовано

| Подсистема | Результат |
| --- | --- |
| CRM | Один Client в рамках бизнеса; подтверждённые platform/phone/email identities, защита от небезопасного объединения по имени. Поиск, фильтры, контакты, заявки, записи, диалоги, внутренние заметки, timeline, загрузка старой истории. Исторические заявки и диалоги перенесены миграцией. |
| Бизнес | Внутреннее и публичное название, приветствие, описание, контакты, IANA timezone. Клиентские сценарии используют название бизнеса. |
| Заявки | Настройка вопросов, подписей и обязательности, приветствия и финального текста; проверка ответов перед отправкой, изменение/отмена. Client и Lead сохраняются атомарно. Статусы, сотрудник, время взятия в работу, поиск/фильтры, ответы клиента, уведомления. FSM возвращается в меню; повторный update не создаёт новую заявку. |
| Администрация | Существующие conversation/message расширены: inbox, клиент, последнее сообщение, unread на сотрудника, атомарное взятие в работу, ответ через outbox, delivery status, закрытие и возобновление, вложения. Обновление без F5 через polling. История и список имеют страницы. |
| Онлайн-запись | Услуги, специалисты, many-to-many, длительности/буферы/цены, недельное расписание с перерывами, исключения по датам, notice/horizon/interval. Слоты учитывают timezone/DST. Бот и ручная запись используют один сервис. Создание/перенос сериализуются транзакционными блокировками. Отмена, завершение, no_show, история, режимы день/неделя/список, детали, уведомления, напоминания 24ч/2ч с действиями переноса/отмены. |
| Автопостинг | Проверка Telegram channel admin и VK wall/group permissions. Текст, фото/альбомы, видео, ссылки и кнопки; несколько целей, сейчас/по расписанию, черновики, редактирование, дублирование, отмена, архивное удаление. Отдельные результаты площадок, partial, retry и история. Daily/weekdays/weekly/monthly recurrence в timezone бизнеса. |
| AI | Серверный OpenAI Responses API, генерация и редакторские действия, timeout, rate limit, безопасная ошибка. Результат только черновик; публикация требует действия сотрудника. |
| Уведомления | Общие события для заявок, сообщений, записи/переноса/отмены и ошибок постов; web-центр и badge, отдельное прочтение, выбор получателей. Telegram сотрудников привязывается одноразовым кодом к существующему боту бизнеса. |
| Надёжность | Business-scoped permissions, аудит, idempotency входящих событий и пользовательских запросов, committed delivery claims, outbox, bounded retries, health/heartbeat общих workers, ограничения запросов, серверное шифрование токенов. |
| Вложения | Общий storage abstraction, приватный S3-compatible storage или общий локальный каталог для разработки. PostgreSQL хранит метаданные, не бинарные файлы. Проверяются размер, MIME/signature и business scope. |

## Изменённые подсистемы и UI

Основные каталоги: `src/server/{access,ai,attachments,audit,booking,bot,clients,communications,connections,http,leads,notifications,posts,solutions,telegram,vk,db}`, `src/components/{attachments,booking,clients,messages,notifications,posts}`, существующие компоненты connections/settings/leads/solutions, App Router API, workers и тесты.

Рабочие разделы: `/clients`, `/leads`, `/messages`, `/bookings`, `/posts`, настройки бизнеса/уведомлений, подключения и `/solutions/leads/setup`. Новые экраны используют существующие стили и адаптивную раскладку. Для опасных операций используются диалоги подтверждения, ошибки показываются внутри интерфейса. Длинные списки и истории имеют пагинацию.

## Миграции и схема

| Миграция | Таблицы/изменения |
| --- | --- |
| 019_shared_clients | client, client_identity, client_activity, client_note, notification, notification_recipient; business public_name/greeting/description/contact_info; lead/conversation.client_id и scoped FK |
| 020_operational_history | conversation_read_state; lead answers, processing_by/processing_at; расширение audit actions |
| 021_bot_dialogues | vk_dialog; расширение telegram_dialog и кнопок outbox |
| 022_delivery_claims | Outbox delivery state, lease, external IDs и связь сообщений; request idempotency коммуникаций |
| 023_booking | booking_service, booking_specialist, booking_service_specialist, booking_settings, booking_schedule, booking_schedule_exception, booking, booking_history, booking_reminder |
| 024_vk_activation | VK runtime activation/confirmation fields; encrypted_publish_token в существующей connection_secret |
| 025_autopost | post_target, post, post_delivery, post_schedule; связь с существующими outbox |
| 026_attachments | attachment, communication_attachment, post_attachment; multipart post delivery steps |
| 027_staff_notifications | notification_binding, notification_preference; очередь получателей, уникальные Telegram notification deliveries |
| 028_audit_context | actor_type, nullable actor_user_id, target_id, metadata, индекс target |
| 029_crm_history_backfill | Перенос старых lead/conversation в CRM без объединения только по имени |
| 030_post_archive | post.deleted_at и индекс видимых публикаций |
| 031_post_target_connection_scope | Составной внешний ключ запрещает цель публикации через подключение другого бизнеса |

Запуск: `npm run db:migrate`. Применять к staging-копии PostgreSQL перед разрешённым выпуском. Существующий migration runner управляет транзакциями; production schema вручную не менять.

## API

Сохранён префикс `/api/v1/businesses/:publicBusinessId`. Проверяются session, membership, permissions, scope и входные данные.

- `clients`, `clients/:clientId`: список/карточка/изменение/заметки и история.
- `profile`: публичные сведения бизнеса и timezone.
- `leads`, `leads/:leadId`, `lead-setup`: существующие маршруты расширены.
- `conversations`, `conversations/:conversationId`: список, сообщения, assignment/status, отправка.
- `attachments`, `attachments/:attachmentId`: загрузка и закрытая выдача.
- `booking-config`, `booking-slots`, `bookings`, `bookings/:bookingId`: каталог/настройки, доступность, создание и действия.
- `post-targets`, `posts`, `posts/:postId`, `posts/ai`: подключения публикаций, контент, действия, генерация.
- `notifications`, `notification-settings`: web-центр, чтение и получатели/привязка Telegram.
- `telegram/start`, `vk/start`: активация существующих подключений.

Сервисы/специалисты используют общий `booking-config` вместо параллельных несовместимых API. Публикации отправляются через существующие Telegram/VK outbox, отдельная вторая очередь не создана.

## Окружение и workers

Точные имена также перечислены в `.env.example`.

| Переменная | Назначение |
| --- | --- |
| APP_URL | Публичный HTTPS origin staging/production для auth/webhook; одинаковый в web и workers |
| DATABASE_URL | Общая PostgreSQL база web/workers |
| BETTER_AUTH_SECRET | Существующий сильный секрет auth/encryption; одинаковый во всех процессах. Не заменять без процедуры миграции зашифрованных данных. |
| NEXT_PUBLIC_DATA_SOURCE=api | Реальный серверный режим |
| TELEGRAM_WEBHOOKS_ENABLED=true | Включается в согласованном окружении с доступным webhook и Telegram worker |
| VK_WEBHOOKS_ENABLED=true | Аналогично для VK Callback API и worker |
| AI_API_TOKEN, AI_MODEL | Серверный OpenAI token и доступная ему Responses-модель; без них остальная система работает |
| ATTACHMENT_STORAGE=s3 | Приватное общее хранилище вложений |
| S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY | Доступ к одному приватному S3-compatible bucket из web и обоих workers |
| ATTACHMENT_STORAGE=filesystem, ATTACHMENT_STORAGE_PATH | Альтернатива для разработки; абсолютный каталог должен быть общим для процессов |

Telegram/VK bot/group/publish tokens вводятся через существующий UI подключений, шифруются на сервере и не являются NEXT_PUBLIC env. Для VK wall/video нужен подходящий пользовательский publish token; одного токена сообщества недостаточно.

Запуск процессов после миграций:

- Web: `npm run build`, затем `npm start`.
- Telegram: `npm run worker:telegram`.
- VK: `node --env-file-if-exists=.env.local --import tsx scripts/vk-worker.mts`.

Планировщики автопостинга, напоминаний и уведомлений встроены в существующие worker loops. Для расписаний должен работать хотя бы один loop, для доставки каждой площадке — её worker. Можно запускать оба: блокировки/unique keys защищают от повторного резервирования задач. Контролировать health и heartbeat; открытый браузер не нужен.

## Проверки и границы подтверждения

Локально выполнены `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` (Next webpack). PostgreSQL-specific concurrency tests локально пропускаются при отсутствии TEST_DATABASE_URL; они обязательны в GitHub Actions с PostgreSQL 17. CI также запускает реальные HTTP account flows и Docker build/import checks. Контролируемые ответы внешних API в тестах проверяют реальную backend-логику, но не подтверждают права конкретных production токенов.

Покрытие: валидация lead setup, matching/scoping CRM, notes/history, permissions, Telegram/VK lifecycle и dedup, assignment race, outbox retries/uncertain recovery, реальные байты вложений/multipart, S3 adapter, booking slots/buffers/exceptions/DST, double booking и перенос, reminders, recurring posts, per-platform partial/retry, AI errors/draft-only, auth/PIN/recovery и HTTP regression.

## Известные ограничения

1. Автоматическая визуальная проверка в браузере среды заблокирована `net::ERR_BLOCKED_BY_CLIENT`. Проверка размеров 390/768/1280/1440 и полного UI E2E остаётся ручной; её нельзя считать выполненной по серверным тестам.
2. Реальные Telegram/VK отправки, загрузка в ваш S3 и генерация вашим AI token не выполнялись без соответствующих окружения/секретов. Нужен staging smoke test.
3. Внешний API может принять сообщение и оборвать соединение до ответа. Абсолютное exactly-once без поддержки платформы недоказуемо: такие доставки получают `uncertain`, автоматически повторно не отправляются. Сначала проверить площадку; не делать слепой retry.
4. Telegram поддерживает inline-кнопки публикации; для VK wall кнопки представлены текстовыми ссылками. Нативной аналогичной клавиатуры wall здесь нет.
5. Вложения ограничены 50 МБ; поддержаны JPEG/PNG/WEBP, MP4/WEBM, OGG/MP3, PDF/plain text. Office/архивы не принимаются. Для фото постов дополнительно действуют лимиты альбома/размера.
6. Inbox использует безопасный polling, отдельного SSE-сервера нет. Календарь показывает день/неделю/список карточками специалистов, drag-and-drop не предусмотрен.
7. Без подтверждённой связи старые одноимённые записи клиентов намеренно не сливаются. Клиент ручной записи без Telegram/VK identity не может получить бот-напоминание; worker фиксирует отсутствие канала.
8. Email/push-уведомления и оплата не реализованы согласно рамкам этапа. AI-провайдер — OpenAI Responses; произвольные несовместимые AI endpoints не поддерживаются.

## Что проверить вручную перед merge/deploy

1. На staging применить все миграции к копии существующей базы. Проверить старые заявки/диалоги в CRM, вход, регистрацию, PIN, recovery, смену бизнеса, роли и подключения.
2. Указать название/публичное название/часовой пояс. Подключить реального Telegram-бота кнопкой, активировать решения и убедиться в корректном webhook/health. Бот приветствует от имени бизнеса.
3. Пройти заявку: вопросы → изменение → подтверждение; проверить один Lead/Client, отсутствие повторного финала, web/TG notification, «Взять в работу» и «Завершить» двумя сотрудниками.
4. Привязать личный Telegram сотрудника одноразовым кодом. Проверить выбранные события, чтение уведомлений и отзыв привязки/доступа.
5. Написать администрации текст и каждый поддержанный тип вложения в Telegram/VK; получить ответ с сайта, проверить unread отдельно у двух сотрудников, одновременное assignment, закрытие и повторное обращение.
6. Создать услуги/специалистов/перерывы/исключения. Проверить бота и ручную запись, разные timezone, занятый слот, перенос, отмену и сохранение старого слота при неудачном переносе. Проверить обе reminder-кнопки только для владельца записи.
7. Подключить Telegram-канал с admin rights и VK-сообщество с пользовательским wall token. Опубликовать текст/одно фото/альбом/видео, запланировать в timezone бизнеса и дождаться worker без браузера. Проверить recurring и ошибку одной площадки без повторной отправки в успешную.
8. Проверить S3 из web и обоих workers, приватность URL и запрет доступа другого бизнеса.
9. Указать AI token/model; создать и изменить черновик. Убедиться, что без отдельного действия публикации не происходит.
10. Проверить 390/768/1280/1440: CRM, inbox, календарь, редактор постов, клавиатуру мобильного браузера, пустые/ошибочные состояния и подтверждения опасных действий.
11. Перезапустить workers при очереди задач; проверить health, отсутствие повторных объектов и понятное отображение uncertain/failed. Проверить права operator: операционная работа доступна, secrets/подключения/критические настройки недоступны.

Разрешение на merge и production deploy остаётся отдельным решением владельца после этих внешних проверок.
