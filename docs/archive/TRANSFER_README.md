# БизнеСоты — пакет передачи (transfer)

Архив для ChatGPT Codex и переноса в новый репозиторий  
https://github.com/9wwnmw2szc-hue/Biznesoty

## Критично про дизайн

**Текущий Dashboard визуально НЕ ПРИНЯТ.**

Новый утверждённый концепт desktop/mobile находится в ChatGPT и будет добавлен отдельно.

Файлы ниже — **исторические материалы предыдущего этапа**. Их нужно сохранить, но **не называть новым утверждённым дизайном**:

- `public/assets/sreda/decor/APPROVED-DESIGN-REFERENCE.jpeg`
- `public/assets/sreda/decor/MASTER-ASSET-SHEET.png` / `.webp`
- `public/images/design-reference.jpg`

---

## Исходный репозиторий

| Поле | Значение |
|------|----------|
| Origin | https://github.com/saakav/Chernoviki |
| Открытый PR | https://github.com/saakav/Chernoviki/pull/1 |
| Целевой репозиторий | https://github.com/9wwnmw2szc-hue/Biznesoty |

## Ветка и commit

| Поле | Значение |
|------|----------|
| Ветка | `cursor/sreda-stage1-foundation-04e7` |
| Полный SHA | `33008957e31d4135e4edfd519163df5f8c4ce93c` |
| Короткий | `3300895` |
| Сообщение tip | `fix: stop right-panel CSS from overriding Tailwind hidden` |
| Относительно `main` | **15 commits ahead**, 0 behind |
| Working tree при сборке ZIP | **чистый** (кроме добавленного `TRANSFER_README.md`) |

### Какой Dashboard актуален

**Один актуальный вариант** — ветка `cursor/sreda-stage1-foundation-04e7`.

- На `main` каталога `src/components/dashboard/` **нет**.
- Параллельных расходящихся реализаций Dashboard в working tree нет.
- Выбирать между вариантами не пришлось: актуален tip этой ветки.

## Незакоммиченные изменения кода

**Кода приложения — нет.**  
В архив вошло дерево tip commit `33008957e31d4135e4edfd519163df5f8c4ce93c` плюс этот `TRANSFER_README.md` (только для передачи; в tip commit его может не быть).

---

## Где что лежит

### Dashboard (UI)

Страница: `src/app/(app)/dashboard/page.tsx`

| Файл | Роль |
|------|------|
| `BrandBlock.tsx` | Бренд-блок |
| `BusinessSwitcher.tsx` | Переключатель бизнеса |
| `ConnectionsCard.tsx` | Подключения |
| `DashboardHeader.tsx` | Шапка dashboard |
| `DashboardView.tsx` | Корневой вид |
| `HeroFlowNav.tsx` | Навигация потока hero |
| `PromoCard.tsx` | Промо |
| `QuickActions.tsx` | Быстрые действия |
| `RecentLeads.tsx` | Последние заявки |
| `ScheduledPosts.tsx` | Запланированные посты |
| `SearchField.tsx` | Поиск |
| `SolutionModule.tsx` | Модуль решения |
| `SolutionWorkspace.tsx` | Сцена / платформа |
| `TariffCard.tsx` | Карточка тарифа |
| `WorkspaceGlassHints.tsx` | Glass-подсказки сцены |

### Стили

| Файл | Назначение |
|------|------------|
| `src/app/globals.css` | Атмосфера, сцена, layout, панели |
| Tailwind CSS v4 | `@tailwindcss/postcss` |

### Конфигурация сцены и solutions

| Файл | Назначение |
|------|------------|
| `src/config/scene.ts` | Frame, docks, anchors, layout tokens, typography |
| `src/config/solutions.ts` | Визуалы решений, mobile order, dock mapping |
| `src/config/assets.ts` | Пути к `public/assets/sreda/...` |
| `src/config/design.ts` | Акценты / design tokens |
| `src/config/navigation.ts` | Навигация sidebar |

Файлы `src/config/`:

```
assets.ts
design.ts
navigation.ts
scene.ts
solutions.ts
```

Debug сцены: `/dashboard?debugScene=1`.

### Assets и референсы

Корень: **`public/assets/sreda/`** (в ZIP целиком).

Файлы `public/assets/sreda/decor/`:

```
APPROVED-DESIGN-REFERENCE.jpeg
MASTER-ASSET-SHEET.png
MASTER-ASSET-SHEET.webp
decor-coffee.png
decor-plant-large.png
decor-plant-large.webp
decor-plant-small.png
decoration-leaves.png
logo-leaf.png
```

| Путь | Назначение |
|------|------------|
| `public/assets/sreda/decor/APPROVED-DESIGN-REFERENCE.jpeg` | Старый референс этапа (не новый концепт) |
| `public/assets/sreda/decor/MASTER-ASSET-SHEET.png` (+ `.webp`) | Исторический Asset Kit |
| `public/images/design-reference.jpg` | Доп. исторический референс |
| `public/assets/sreda/platform/platform-tray.*` | Чистый crop платформы (текущая сцена) |
| `public/assets/sreda/platform/platform-base.*` | Полный export с chrome |
| `public/assets/sreda/solutions/*` | Модули решений |
| `public/assets/sreda/{icons,ui,status,decor}/*` | Иконки, UI, статус, декор |

---

## Стек и окружение (машина сборки ZIP)

| | |
|--|--|
| Node.js | `v22.14.0` |
| npm | `10.9.7` |
| Lock-файл | `package-lock.json` |
| Next.js | `16.3.4` (App Router) |
| React | `19.2.8` |
| TypeScript | `^5` |
| Tailwind | v4 |

Каталога `.github/` в проекте **нет** (workflows не заведены). В архиве есть `.gitignore`.

---

## Команды

```bash
npm ci                 # или: npm install
npm run dev            # http://localhost:3000 — dashboard: /dashboard
npm run typecheck
npm run lint
npm run build
npm run start          # после build
```

Данные: mock (`NEXT_PUBLIC_DATA_SOURCE=mock` в `.env.example`). Backend / платежи / production deploy в пакет не входят.

---

## Известные проблемы и заглушки

1. Dashboard визуально **НЕ ПРИНЯТ** — ждёт новый концепт из ChatGPT.
2. Посадка модулей / масштаб / подписи vs старый референс всё ещё расходятся (MAJOR).
3. Атмосфера стола — временный тёплый градиент, не фото-фон.
4. Mock: возможное противоречие «250 ₽/мес» vs число активных решений — не менялось.
5. `/solutions`, `/billing` и др. — заготовки, не production.
6. `.env.example` только с публичными именами; реальных секретов в архиве нет.
7. Playwright в `devDependencies` нужен скриптам скриншотов; для обычного `dev` не обязателен.

---

## Содержимое архива / исключения

**Включено:** `src/`, `public/` (включая `public/assets/sreda`), configs, `package.json`, `package-lock.json`, `README.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.env.example`, `scripts/`, `TRANSFER_README.md`.

**Исключено:** `.git/`, `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`, кеши/логи, реальные `.env*`, токены/ключи, БД, персональные данные.
