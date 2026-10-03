import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const dashboardView = read("src/components/dashboard/DashboardView.tsx");

/* ------------------------------------------------------------------ */
/* Главная — сводка и точки входа, а не копия профильных разделов      */
/* ------------------------------------------------------------------ */

test("главная не дублирует ленты и таблицы профильных разделов", () => {
  // ActivityFeed повторял /leads, /orders, /bookings, /messages и /posts
  // пятью списками на одной странице и стоил 5 непагинированных запросов.
  for (const duplicated of [
    "ActivityFeed",
    "TodaySchedule",
    "DashboardKpis",
    "DashboardAiHint",
  ]) {
    assert.equal(
      new RegExp(`<${duplicated}\\b`).test(dashboardView),
      false,
      `${duplicated} дублирует профильный раздел и не должен рендериться на главной`,
    );
  }
});

test("главная не содержит декоративных блоков и выдуманных графиков", () => {
  assert.doesNotMatch(
    dashboardView,
    /Живые соты/,
    "декоративный блок без данных удалён",
  );
  assert.doesNotMatch(dashboardView, /biznesoty-hive/, "декоративная секция удалена");
});

test("главная не обещает «бизнес в порядке» без проверки данных", () => {
  assert.doesNotMatch(
    dashboardView,
    /Ваш бизнес — в порядке/,
    "статичное утверждение о состоянии заменено реальными данными",
  );
});

test("главная показывает приветствие по времени и не рендерит его на сервере", () => {
  assert.match(dashboardView, /useLocalGreeting\(\)/);
  assert.match(dashboardView, /useLocalDateLabel\(\)/);
  assert.match(dashboardView, /dashboard-greeting/);
  // Значение приходит пустым с сервера — это исключает приветствие по UTC.
  assert.match(
    read("src/hooks/useLocalGreeting.ts"),
    /serverSnapshot/,
    "часовой пояс известен только клиенту",
  );
});

test("главная использует реальные summary-эндпоинты, а не выдуманные метрики", () => {
  const hook = read("src/hooks/useDashboardPulse.ts");
  for (const endpoint of [
    "/orders?view=summary",
    "/leads?view=summary&days=1",
    "/clients?view=summary",
    "/bookings?from=",
  ]) {
    assert.ok(hook.includes(endpoint), `нет реального источника ${endpoint}`);
  }
  assert.equal(
    /Math\.random|Date\.now\(\)\s*\*\s*0\./.test(hook),
    false,
    "показатели не генерируются",
  );
});

test("блоки главной ссылаются на профильные разделы, а не дублируют их", () => {
  const summary = read("src/components/dashboard/BusinessSummary.tsx");
  const attention = read("src/components/dashboard/AttentionPanel.tsx");
  for (const href of ["/analytics", "/orders", "/leads", "/bookings", "/clients"]) {
    assert.ok(summary.includes(href), `сводка должна ссылаться на ${href}`);
  }
  assert.match(attention, /href=\{item\.href\}/, "каждый пункт ведёт в свой раздел");
  assert.equal(
    /<table|<ul[^>]*>\s*\{.*\.map\(.*(order|lead)\.map/s.test(summary),
    false,
    "сводка не превращается в таблицу",
  );
});

test("пустое состояние ведёт в настройку, а не показывает нули", () => {
  const empty = read("src/components/dashboard/DashboardEmptyState.tsx");
  assert.match(dashboardView, /isWorkspaceEmpty\(/);
  assert.match(empty, /dashboard-empty/);
  assert.match(empty, /settings\?section=connections/);
  assert.equal(
    /Данных нет|0 заказов|0 заявок/.test(empty),
    false,
    "нулевые показатели — не объяснение для нового пользователя",
  );
});

test("главная показывает блок внимания и спокойное состояние, когда всё хорошо", () => {
  assert.match(dashboardView, /<AttentionPanel items=\{attentionItems\}/);
  const attention = read("src/components/dashboard/AttentionPanel.tsx");
  assert.match(attention, /attention-empty/, "есть состояние «всё под контролем»");
  assert.match(attention, /Всё под контролем/);
});

test("сбой подключения попадает в «требует внимания», а не игнорируется", () => {
  assert.match(
    dashboardView,
    /connection\.status === "error"/,
    "реальная ошибка подключения должна быть видна",
  );
});

/* ------------------------------------------------------------------ */
/* Intelligence: пользовательский вид не содержит внутренних кодов      */
/* ------------------------------------------------------------------ */

/** Every customer-facing component under src/components/intelligence. */
const intelligenceFiles = walk(join(root, "src/components/intelligence"));

/**
 * Patterns that catch a raw technical field reaching the DOM — direct JSX
 * interpolation or template-literal concatenation.
 *
 * Merely *reading* a field is fine and expected: passing
 * `provider.unavailableReason` into `osintProviderState()` is precisely the
 * translation boundary we want. What must not happen is rendering it as-is.
 */
const RAW_RENDERS = [
  /\{\s*\w+\.unavailableReason\s*\}/,
  /\{\s*provider\.label\s*\}/,
  /\{\s*\w+\.policy\s*\}/,
  /\{\s*\w+\.provider\s*\}/,
  /\{\s*\w+\.relationship\s*\}/,
  /\{\s*\w+\.bridgeStatus\s*\}/,
  /\{\s*\w+\.trustLevel\s*\}/,
  /\{\s*\w+\.error\s*\}/,
  /\$\{[^}]*\.unavailableReason[^}]*\}/,
  /\$\{[^}]*\.policy[^}]*\}/,
  /\$\{[^}]*\.trustLevel[^}]*\}/,
  /\$\{[^}]*\.bridgeStatus[^}]*\}/,
  /\$\{[^}]*\.relationship[^}]*\}/,
];

test("в пользовательских компонентах Intelligence нет прямого вывода технических полей", () => {
  for (const file of intelligenceFiles) {
    const source = readFileSync(file, "utf8");
    for (const pattern of RAW_RENDERS) {
      assert.equal(
        pattern.test(source),
        false,
        `${file.replace(root, "")} выводит техническое поле в разметку (${pattern}) — нужен osintLabels`,
      );
    }
  }
});

test("технические поля читаются только как аргумент функции перевода", () => {
  const osintPanel = read("src/components/intelligence/OsintPanel.tsx");
  assert.match(
    osintPanel,
    /reason: provider\.unavailableReason/,
    "код передаётся в osintProviderState, а не рендерится",
  );
  assert.match(osintPanel, /osintProviderLabel\(provider\.id, provider\.label\)/);
});

test("компоненты Intelligence переводят состояния через osintLabels", () => {
  const osintPanel = read("src/components/intelligence/OsintPanel.tsx");
  const passport = read("src/components/intelligence/ResearchPassportPanel.tsx");
  assert.match(osintPanel, /osintProviderState/);
  assert.match(osintPanel, /osintRunErrorSummary/);
  assert.match(passport, /osintProviderState/);
  assert.match(passport, /osintRunErrorSummary/);
});

test("в разметке нет запасного вывода сырого кода (default: return status)", () => {
  for (const file of intelligenceFiles) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(
      source,
      /default:\s*\n?\s*return (status|reason|code);/,
      `${file.replace(root, "")} возвращает сырой код как fallback`,
    );
  }
});

test("доменный слой сохраняет osint_vk_token_missing для тестов и логов", () => {
  // Переводить код нужно на границе представления, а не в провайдере:
  // от него зависят тесты провайдеров и диагностика.
  const vk = read("src/server/intelligence/osint/providers/vk.ts");
  assert.match(vk, /osint_vk_token_missing/);
  const registry = read("src/server/intelligence/osint/providers/registry.ts");
  assert.match(registry, /reason/);
});

test("точные коды уходят в структурные логи, а не в интерфейс", () => {
  const service = read("src/server/intelligence/osint-service.ts");
  assert.match(
    service,
    /log\("warn", "osint\.provider_unavailable"/,
    "недоступный провайдер логируется с точным кодом",
  );
  assert.match(
    service,
    /error_codes: result\.errors\.join/,
    "ошибки запуска логируются с точными кодами",
  );
});