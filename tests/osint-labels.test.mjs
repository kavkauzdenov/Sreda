import test from "node:test";
import assert from "node:assert/strict";
import {
  osintBridgeStatusLabel,
  osintProviderLabel,
  osintProviderRoleLabel,
  osintProviderState,
  osintRelationshipLabel,
  osintRunErrorDetail,
  osintRunErrorSummary,
  osintRunStatusLabel,
  osintSourceStatusLabel,
  osintSourceTypeLabel,
  osintTrustLabel,
  providerDiagnostic,
} from "../src/lib/osintLabels.ts";

/* ------------------------------------------------------------------ */
/* Пользовательское представление: никаких внутренних кодов            */
/* ------------------------------------------------------------------ */

/** The exact code the VK provider returns when OSINT_VK_API_TOKEN is unset. */
const VK_MISSING = "osint_vk_token_missing";

test("ВКонтакте без токена: нейтральное «не настроено», а не ошибка и не код", () => {
  const state = osintProviderState({ available: false, reason: VK_MISSING });
  assert.equal(state.state, "not_configured");
  assert.equal(state.label, "Интеграция не настроена");
  assert.match(state.detail, /не запущен/i);
  const rendered = `${state.label} — ${state.detail}`;
  assert.equal(
    rendered.includes(VK_MISSING),
    false,
    "технический код не должен попадать в интерфейс",
  );
  assert.equal(rendered.includes("token"), false);
});

test("неизвестный код не течёт: деградация до нейтральной фразы", () => {
  for (const reason of [
    "some_future_internal_code_v2",
    "ECONNRESET",
    "provider:vk:vk_api_error:Too many requests",
  ]) {
    const state = osintProviderState({ available: false, reason });
    assert.equal(state.state, "not_configured");
    assert.ok(state.label.length > 0);
    assert.equal(
      `${state.label} ${state.detail}`.includes(reason),
      false,
      `код ${reason} утёк в UI`,
    );
  }
});

test("настроенный источник честно называется рабочим", () => {
  const state = osintProviderState({
    available: true,
    reason: null,
    policy: "official_api",
  });
  assert.equal(state.state, "ready");
  assert.equal(state.label, "Готов к работе");
  assert.match(state.detail, /официальный API/i);
  assert.equal(`${state.label}${state.detail}`.includes("policy"), false);
});

test("доступный источник без policy всё равно читаем", () => {
  const state = osintProviderState({ available: true, reason: null });
  assert.equal(state.state, "ready");
  assert.ok(state.detail.length > 0);
});

test("null/undefined reason трактуется как «не настроено», без раскрытия", () => {
  for (const reason of [null, undefined]) {
    const state = osintProviderState({ available: false, reason });
    assert.equal(state.state, "not_configured");
    assert.ok(state.label.length > 0);
  }
});

test("provider_not_configured тоже читается по-человечески", () => {
  const state = osintProviderState({
    available: false,
    reason: "provider_not_configured",
  });
  assert.equal(state.label, "Интеграция не настроена");
});

test("названия провайдеров — человеческие, не идентификаторы адаптеров", () => {
  assert.equal(osintProviderLabel("own_urls"), "Ваши сайты");
  assert.equal(osintProviderLabel("vk"), "ВКонтакте");
  assert.equal(osintProviderLabel("web_page"), "Страницы сайтов");
  for (const id of ["own_urls", "vk", "web_page"]) {
    assert.notEqual(osintProviderLabel(id), id, `${id} не должен показываться как есть`);
  }
  assert.equal(
    osintProviderLabel("unknown_provider", "ВКонтакте (официальный API)"),
    "ВКонтакте (официальный API)",
    "известный fallback лучше идентификатора",
  );
  assert.equal(osintProviderLabel("brand_new"), "Источник");
});

test("роль источника переводится, а не показывается как search/crawl", () => {
  assert.equal(osintProviderRoleLabel("search"), "поиск");
  assert.equal(osintProviderRoleLabel("crawl"), "обход страниц");
  assert.notEqual(osintProviderRoleLabel("search"), "search");
});

test("типы, доверие и статусы источников переведены", () => {
  assert.equal(osintSourceTypeLabel("review_platform"), "Отзывы");
  assert.equal(osintSourceTypeLabel("social_network"), "Социальная сеть");
  assert.equal(osintSourceTypeLabel("website"), "Сайт");
  assert.equal(osintSourceTypeLabel("brand_new"), "Источник");

  assert.equal(osintTrustLabel("official"), "Официальный");
  assert.equal(osintTrustLabel("third_party"), "Сторонний");
  assert.equal(osintTrustLabel("???"), "Сторонний");

  assert.equal(osintSourceStatusLabel("active"), "Работает");
  assert.equal(osintSourceStatusLabel("error"), "Ошибка сбора");
  assert.equal(osintSourceStatusLabel("paused"), "Приостановлен");
  assert.equal(osintSourceStatusLabel("weird"), "Неизвестное состояние");
});

test("связи и статусы сущностей переведены", () => {
  assert.equal(osintRelationshipLabel("OWNER"), "Владелец");
  assert.equal(osintRelationshipLabel("ABOUT"), "Сведён с");
  assert.equal(osintRelationshipLabel("UNKNOWN_REL"), "Связан с");
  assert.equal(osintBridgeStatusLabel("candidate"), "кандидат");
  assert.equal(osintBridgeStatusLabel("linked"), "подтверждено");
  assert.equal(osintBridgeStatusLabel("???"), "на проверке");
});

test("статусы запуска переведены, неизвестный не показывается кодом", () => {
  assert.equal(osintRunStatusLabel("completed"), "Готово");
  assert.equal(osintRunStatusLabel("partial"), "Частично");
  assert.equal(osintRunStatusLabel("failed"), "Ошибка");
  assert.equal(osintRunStatusLabel("running"), "Выполняется");
  assert.equal(osintRunStatusLabel("queued"), "В очереди");
  assert.equal(osintRunStatusLabel("mystery"), "Неизвестное состояние");
});

/* ------------------------------------------------------------------ */
/* Ошибки запуска                                                      */
/* ------------------------------------------------------------------ */

test("пустая ошибка не превращается в текст", () => {
  for (const value of [null, undefined, "", ";", "  ;  "]) {
    assert.equal(osintRunErrorSummary(value), "");
  }
});

test("no_providers_available читается по-человечески", () => {
  const human = osintRunErrorSummary("no_providers_available");
  assert.match(human, /не нашлось источников/i);
  assert.equal(human.includes("no_providers_available"), false);
});

test("сбой источника не маскируется под «всё работает»", () => {
  const human = osintRunErrorSummary("provider:vk:vk_api_error:Too many requests");
  assert.match(human, /ответил ошибкой/i);
  assert.match(human, /ограничения/i, "сбой должен быть назван сбоем");
  assert.equal(human.includes("Too many requests"), false);
  assert.equal(human.includes("vk_api_error"), false);
});

test("лимиты сборки объясняются пользователю", () => {
  assert.match(osintRunErrorSummary("duration_budget_exhausted"), /по времени/i);
  assert.match(osintRunErrorSummary("results_budget_exhausted"), /по лимиту/i);
  assert.match(osintRunErrorSummary("aborted_by_caller"), /прерван/i);
});

test("запрет роботов и приватные адреса не выглядят как ошибка системы", () => {
  const human = osintRunErrorSummary(
    "crawl:https://example.com:robots_disallowed",
  );
  assert.match(human, /запрещает автоматический сбор/i);
  assert.equal(human.includes("robots_disallowed"), false);
});

test("несколько кодов объединяются в одно понятное объяснение", () => {
  const human = osintRunErrorSummary(
    "no_page_provider_available; duration_budget_exhausted",
  );
  assert.match(human, /страниц/i);
  assert.match(human, /по времени/i);
  assert.equal(human.includes(";"), true, "соединение кодов допустимо в тексте");
});

test("неизвестная комбинация кодов даёт честное нейтральное объяснение", () => {
  const human = osintRunErrorSummary("weird:1; another:2");
  assert.match(human, /часть источников/i);
  assert.equal(human.includes("weird:1"), false);
});

test("в объяснении ошибки нет токенов, URL и длинных кодов", () => {
  const human = osintRunErrorSummary(
    "provider:vk:vk_api_error:Insufficient access: you need to pass token",
  );
  assert.equal(/token/i.test(human), false, "слово «token» не должно появляться");
  assert.equal(/vk_api_error/.test(human), false);
  assert.ok(human.length < 300, "объяснение остаётся коротким");
});

/* ------------------------------------------------------------------ */
/* Диагностика: точный код остаётся доступен администратору             */
/* ------------------------------------------------------------------ */

test("диагностика сохраняет исходный код для администратора", () => {
  const diagnostic = providerDiagnostic("vk", VK_MISSING);
  assert.equal(diagnostic.code, VK_MISSING, "точный код обязателен для разбора сбоя");
  assert.equal(diagnostic.provider, "ВКонтакте");
  assert.equal(diagnostic.human, "Интеграция не настроена");
});

test("деталь ошибки запуска отдаёт и коды, и человеческий текст", () => {
  const detail = osintRunErrorDetail("no_providers_available; aborted_by_caller");
  assert.deepEqual(detail.codes, ["no_providers_available", "aborted_by_caller"]);
  assert.ok(detail.human.length > 0);
  assert.match(detail.human, /не нашлось источников/i);
  assert.match(detail.human, /прерван/i);
});

test("деталь пустой ошибки не выдумывает коды", () => {
  assert.deepEqual(osintRunErrorDetail(null), { codes: [], human: "" });
  assert.deepEqual(osintRunErrorDetail(""), { codes: [], human: "" });
});

test("диагностика не раскрывает секретов: только идентификатор и код", () => {
  const diagnostic = providerDiagnostic("vk", VK_MISSING);
  assert.deepEqual(Object.keys(diagnostic).sort(), ["code", "human", "provider"]);
  for (const value of Object.values(diagnostic)) {
    assert.equal(
      /secret|password|cookie|bearer|api[_-]?key/i.test(String(value)),
      false,
      "в диагностике не должно быть значений-секретов",
    );
  }
});