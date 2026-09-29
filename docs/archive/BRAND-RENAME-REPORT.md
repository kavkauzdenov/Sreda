# Отчёт: ребрендинг «Соты» → «БизнеСоты»

1. Ветка:
    cursor/biznesoty-brand-rename-258e
2. Commit:

bb0363f905f8df7c6b43f08917c34437424cd1b8

3. Что изменено:
    — `src/config/brand.ts`: APP_NAME / APP_NAME_EN / tagline / description
    — Better Auth `appName` через APP_NAME
    — Пользовательские тексты UI (login, onboarding, dashboard, solutions, analytics, booking, account, admin)
    — Server-facing copy: mail subject, VK title, channel-admin, AI prompts
    — README / docs / `.env.example` / favicon `<title>`
    — CSS: размер шрифта бренда и ширина sidebar под «БизнеСоты»
4. Где заменено «Соты» → «БизнеСоты»:
    — brand.ts, layout metadata (через APP_NAME)
    — LoginForm, AccountFrame, AccountDeletionPanel, BusinessDeletionPanel
    — DashboardHeader/View, SolutionsCatalog, IndustryOnboarding, LeadsSetupView
    — AnalyticsView, BookingsView, AiInterviewPanel, PagePlaceholder, AdminShell
    — identity/mail, vk/service, channel-admin/router, ai/interview, analytics/ai/analyst
    — README, ARCHITECTURE, SECURITY, admin/channel-admin docs, scripts comments
5. Оставшиеся упоминания старого названия:
    — `migrations/047_channel_admin_binding.sql:2` — комментарий «Soty staff» (исторический, category C);
    — CSS-классы `soty-*`, ключи `soty.theme` / `soty.business*`, пути `/assets/soty/` — технические идентификаторы (D);
    — `DashboardView.tsx` «Живые соты» — метафора сот/ячеек, не бренд (оставить);
    — домены `biznesoty.ru` / `biznesoty.online` — уже актуальное имя (не старый бренд).

Публичных UI-упоминаний старого бренда «Соты»/Soty не обнаружено.

6. Проверки:
    Lint — PASS (0 errors, 4 pre-existing warnings)
    Typecheck — PASS
    Tests — PASS с оговоркой: 381 pass / 2 fail (известные lead-тесты на main, не из ребренда)
    Build — PASS
7. Responsive:
    Desktop — PASS (1024 / 1440 / 1920 login: «БизнеСоты», без clip)
    Tablet — PASS (768)
    Mobile — PASS (375 / 390 / 430)
8. GitHub:
    Push — DONE
    PR — ManagePullRequest unauthenticated; ветка: https://github.com/kavkauzdenov/Sreda/compare/main...cursor/biznesoty-brand-rename-258e
    CI — PENDING
    Merge — NOT DONE
9. Блокеры:
    Создание PR через ManagePullRequest: unauthenticated. Merge не выполнялся (нет разрешения). WireGuard/production deploy не затрагивались.

Логотип: SVG mark — только hexagon-иконка без текста; текстовая часть — HTML `APP_NAME`. Favicon `<title>` обновлён. Растровую заглушку не создавали.
