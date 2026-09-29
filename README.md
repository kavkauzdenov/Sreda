# БизнеСоты (Biznesoty)

Закрытая бета платформы готовых решений для малого бизнеса (Telegram / VK).

Репозиторий GitHub может сохранять историческое имя; продуктовое имя в UI и auth: **БизнеСоты**.

## Что это

**БизнеСоты** — Next.js App Router SaaS: один аккаунт → несколько бизнесов → активируемые решения и каналы.

## Локальный запуск

Нужны PostgreSQL и переменные из `.env.example` (минимум `DATABASE_URL`, `BETTER_AUTH_SECRET` ≥ 32 символа, `APP_URL`).

```bash
npm ci
npm run db:migrate
npm run dev
```

Скрипты: `npm test`, `npm run test:http`, `npm run lint`, `npm run typecheck`, `npm run build`.

## Деплой

См. [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — схема web + Postgres + telegram-worker + vk-worker и canonical origin `https://biznesoty.ru`.
