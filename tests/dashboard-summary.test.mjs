import test from "node:test";
import assert from "node:assert/strict";
import { greetingForHour } from "../src/hooks/useLocalGreeting.ts";
import { buildAttentionItems, isWorkspaceEmpty } from "../src/lib/dashboardAttention.ts";

/* ------------------------------------------------------------------ */
/* Greeting by local time                                              */
/* ------------------------------------------------------------------ */

test("приветствие по местному времени: ночь до 5", () => {
  for (const hour of [0, 1, 2, 3, 4]) {
    assert.equal(greetingForHour(hour), "Доброй ночи", `час ${hour}`);
  }
});

test("приветствие по местному времени: утро 5–11", () => {
  for (const hour of [5, 6, 7, 8, 9, 10, 11]) {
    assert.equal(greetingForHour(hour), "Доброе утро", `час ${hour}`);
  }
});

test("приветствие по местному времени: день 12–17", () => {
  for (const hour of [12, 13, 14, 15, 16, 17]) {
    assert.equal(greetingForHour(hour), "Добрый день", `час ${hour}`);
  }
});

test("приветствие по местному времени: вечер 18–23", () => {
  for (const hour of [18, 19, 20, 21, 22, 23]) {
    assert.equal(greetingForHour(hour), "Добрый вечер", `час ${hour}`);
  }
});

test("приветствие: границы диапазонов не пересекаются", () => {
  assert.equal(greetingForHour(4), "Доброй ночи");
  assert.equal(greetingForHour(5), "Доброе утро");
  assert.equal(greetingForHour(11), "Доброе утро");
  assert.equal(greetingForHour(12), "Добрый день");
  assert.equal(greetingForHour(17), "Добрый день");
  assert.equal(greetingForHour(18), "Добрый вечер");
});

test("приветствие: все 24 часа дают одно из четырёх слов", () => {
  const allowed = new Set([
    "Доброй ночи",
    "Доброе утро",
    "Добрый день",
    "Добрый вечер",
  ]);
  for (let hour = 0; hour < 24; hour += 1) {
    assert.ok(allowed.has(greetingForHour(hour)), `час ${hour}`);
  }
});

test("приветствие: невалидный час нормализуется, а не ломает рендер", () => {
  assert.equal(greetingForHour(24), "Доброй ночи", "24:00 → полночь");
  assert.equal(greetingForHour(25), "Доброй ночи", "25:00 → 01:00");
  assert.equal(greetingForHour(37), "Добрый день", "37:00 → 13:00");
  assert.equal(greetingForHour(-1), "Добрый вечер", "-1 → вчерашние 23:00");
  assert.equal(greetingForHour(7.9), "Доброе утро", "дробный час");
  assert.equal(greetingForHour(Number.NaN), "Добрый день", "NaN → нейтральное");
});

/* ------------------------------------------------------------------ */
/* «Требует внимания»                                                  */
/* ------------------------------------------------------------------ */

/** @type {import("../src/lib/dashboardAttention.ts").AttentionInput} */
const base = {
  leads: { newCount: 0, processingCount: 0 },
  orders: { newCount: 0, inProgressCount: 0 },
  bookings: { todayCount: 0 },
  connections: { connected: 1, problemCount: 0 },
  solutions: { setupRequiredCount: 0, totalCount: 5 },
  onboardingComplete: true,
};

test("внимание: при полном покое список пуст — выдумывать нечего", () => {
  assert.deepEqual(buildAttentionItems(base), []);
});

test("внимание: новые заявки — главный приоритет и ведут в раздел заявок", () => {
  const items = buildAttentionItems({
    ...base,
    leads: { newCount: 3, processingCount: 0 },
    orders: { newCount: 2, inProgressCount: 1 },
  });
  assert.equal(items[0].id, "leads-new");
  assert.match(items[0].title, /3 новые заявки/);
  assert.equal(items[0].href, "/leads?status=new");
  assert.equal(items[0].tone, "action");
  const orders = items.find((item) => item.id === "orders-new");
  assert.equal(orders?.href, "/orders?view=new");
});

test("внимание: единственная заявка формулируется grammatically", () => {
  const items = buildAttentionItems({
    ...base,
    leads: { newCount: 1, processingCount: 0 },
  });
  assert.match(items[0].title, /^1 новая заявка/);
});

test("внимание: упавшее подключение важнее спокойных пунктов и не скрывает реальный сбой", () => {
  const items = buildAttentionItems({
    ...base,
    connections: { connected: 1, problemCount: 1 },
    bookings: { todayCount: 2 },
  });
  const problem = items.find((item) => item.id === "connections-problem");
  assert.ok(problem, "сбой подключения обязан попасть в список");
  assert.equal(problem?.tone, "warning");
  assert.match(problem?.title ?? "", /не работает/);
  assert.ok(
    (problem?.weight ?? 0) > (items.find((i) => i.id === "bookings-today")?.weight ?? 0),
    "сбой приоритетнее информационной записи",
  );
});

test("внимание: неподтверждённый заказ попадает в список", () => {
  const items = buildAttentionItems({
    ...base,
    orders: { newCount: 4, inProgressCount: 2 },
  });
  const item = items.find((entry) => entry.id === "orders-new");
  assert.ok(item);
  assert.match(item?.title ?? "", /4 новых заказа/);
});

test("внимание: нулевые счётчики не создают пунктов", () => {
  const items = buildAttentionItems({
    ...base,
    leads: { newCount: 0, processingCount: 7 },
    orders: { newCount: 0, inProgressCount: 9 },
    bookings: { todayCount: 0 },
  });
  assert.deepEqual(items, [], "работа в процессе — не «требует внимания»");
});

test("внимание: список отсортирован по убыванию приоритета", () => {
  const items = buildAttentionItems({
    ...base,
    leads: { newCount: 2, processingCount: 0 },
    orders: { newCount: 1, inProgressCount: 0 },
    connections: { connected: 1, problemCount: 1 },
    bookings: { todayCount: 3 },
  });
  const weights = items.map((item) => item.weight);
  assert.deepEqual(weights, [...weights].sort((a, b) => b - a));
});

test("внимание: больше заявок — выше приоритет", () => {
  const few = buildAttentionItems({
    ...base,
    leads: { newCount: 1, processingCount: 0 },
  }).find((item) => item.id === "leads-new");
  const many = buildAttentionItems({
    ...base,
    leads: { newCount: 9, processingCount: 0 },
  }).find((item) => item.id === "leads-new");
  assert.ok((many?.weight ?? 0) > (few?.weight ?? 0));
});

test("внимание: после онбординга подсказка по настройке решений уходит", () => {
  const setup = { setupRequiredCount: 2, totalCount: 5 };
  const before = buildAttentionItems({
    ...base,
    onboardingComplete: false,
    solutions: setup,
  });
  const after = buildAttentionItems({
    ...base,
    onboardingComplete: true,
    solutions: setup,
  });
  assert.ok(before.some((item) => item.id === "solutions-setup"));
  assert.equal(after.some((item) => item.id === "solutions-setup"), false);
});

test("внимание: без каналов предлагаем подключить канал", () => {
  const items = buildAttentionItems({
    ...base,
    connections: { connected: 0, problemCount: 0 },
  });
  const item = items.find((entry) => entry.id === "connections-none");
  assert.ok(item);
  assert.equal(item?.href, "/settings?section=connections");
});

test("внимание: каждый пункт ведёт в существующий раздел", () => {
  const sections = new Set([
    "/leads?status=new",
    "/orders?view=new",
    "/bookings",
    "/solutions",
    "/settings?section=connections",
  ]);
  const items = buildAttentionItems({
    ...base,
    onboardingComplete: false,
    leads: { newCount: 1, processingCount: 0 },
    orders: { newCount: 1, inProgressCount: 1 },
    bookings: { todayCount: 1 },
    connections: { connected: 0, problemCount: 1 },
    solutions: { setupRequiredCount: 1, totalCount: 5 },
  });
  assert.ok(items.length >= 5);
  for (const item of items) {
    assert.ok(sections.has(item.href), `неизвестный маршрут ${item.href}`);
    assert.ok(item.title.length > 0);
    assert.ok(item.detail.length > 0);
    assert.ok(item.cta.length > 0);
  }
});

test("внимание: недоступные данные не превращаются в нули", () => {
  const items = buildAttentionItems({
    ...base,
    leads: null,
    orders: null,
    bookings: null,
  });
  assert.deepEqual(items, [], "нет данных — нет выдуманных пунктов");
});

/* ------------------------------------------------------------------ */
/* Пустое состояние                                                    */
/* ------------------------------------------------------------------ */

test("пустое состояние: новое пространство без данных", () => {
  assert.equal(
    isWorkspaceEmpty({
      orders: { newCount: 0, inProgressCount: 0 },
      leads: { newCount: 0, processingCount: 0 },
      clients: { total: 0 },
      bookings: { todayCount: 0 },
    }),
    true,
  );
});

test("пустое состояние: любая реальная активность его отменяет", () => {
  const empty = {
    orders: { newCount: 0, inProgressCount: 0 },
    leads: { newCount: 0, processingCount: 0 },
    clients: { total: 0 },
    bookings: { todayCount: 0 },
  };
  assert.equal(
    isWorkspaceEmpty({ ...empty, leads: { newCount: 1, processingCount: 0 } }),
    false,
  );
  assert.equal(
    isWorkspaceEmpty({ ...empty, orders: { newCount: 0, inProgressCount: 1 } }),
    false,
  );
  assert.equal(isWorkspaceEmpty({ ...empty, clients: { total: 3 } }), false);
  assert.equal(
    isWorkspaceEmpty({ ...empty, bookings: { todayCount: 1 } }),
    false,
  );
});

test("пустое состояние: при недоступных данных не показываем его уверенно", () => {
  assert.equal(
    isWorkspaceEmpty({
      orders: null,
      leads: null,
      clients: null,
      bookings: null,
    }),
    true,
    "нулевые значения при null — это «нет данных», а не «пусто»",
  );
});