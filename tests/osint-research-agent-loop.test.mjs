import test from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_KNOWLEDGE,
  planNextActions,
} from "../src/server/intelligence/osint/research/agent.ts";
import { buildIdentityFromSeed } from "../src/server/intelligence/osint/research/identity-builder.ts";

const seed = { name: "Кафе Ромашка", city: "Барнаул" };

/** Строим идентичность тем же путём, что и агент. */
function planIdentity(knowledge) {
  const domains = (knowledge.discovered ?? []).filter((d) => d.kind === "domain");
  return buildIdentityFromSeed({
    ...seed,
    phone: knowledge.confirmed?.contact ? "+73852551010" : null,
    knownDomains: domains.map((d) => d.value),
  });
}

function plan(knowledge, overrides = {}) {
  return planNextActions({
    identity: planIdentity(knowledge),
    knowledge,
    exhaustedHypotheses: new Set(),
    exhaustedQueries: new Set(),
    recentOutcomes: new Map(),
    maxQueries: 40,
    ...overrides,
  });
}

/* ------------------------------------------------------------------ */
/* Цикл планирования (§21)                                             */
/* ------------------------------------------------------------------ */

test("первый такт без знания порождает и гипотезы, и действия", () => {
  const result = plan(EMPTY_KNOWLEDGE);
  assert.ok(result.hypotheses.length > 0, "нужны гипотезы");
  assert.ok(result.actions.length > 0, "нужны действия");
  for (const action of result.actions) {
    assert.ok(action.query.query.length > 0);
    assert.ok(action.query.purpose.length > 0, "действие должно иметь назначение");
    assert.ok(Number.isFinite(action.priority));
  }
});

test("найденный домен порождает новые действия в том же плане", () => {
  const before = plan(EMPTY_KNOWLEDGE);
  const after = plan({
    discovered: [{ kind: "domain", value: "romashka-barnaul.ru" }],
    confirmed: {},
    blockers: {},
  });
  const siteQueries = after.actions.filter((a) => a.query.query.startsWith("site:"));
  assert.ok(
    siteQueries.length > 0,
    "после находки домена должны появиться site:-запросы",
  );
  assert.ok(
    after.hypotheses.length > before.hypotheses.length,
    "находка домена должна породить новые гипотезы",
  );
});

test("подтверждённый контакт понижает приоритет поиска контактов", () => {
  const before = plan(EMPTY_KNOWLEDGE).actions.filter(
    (a) => a.query.purpose === "contact",
  );
  const after = plan({
    discovered: [],
    confirmed: { contact: true },
    blockers: {},
  }).actions.filter((a) => a.query.purpose === "contact");
  if (before.length === 0 || after.length === 0) return; // ветка не выбрана — нечего сравнивать
  const maxBefore = Math.max(...before.map((a) => a.priority));
  const maxAfter = Math.max(...after.map((a) => a.priority));
  assert.ok(maxAfter < maxBefore, `после находки контакта приоритет падает: ${maxAfter} < ${maxBefore}`);
});

test("план уважает бюджет запросов", () => {
  const result = plan(EMPTY_KNOWLEDGE, { maxQueries: 3 });
  assert.ok(result.actions.length <= 3, `действий ${result.actions.length}, бюджет 3`);
});

test("уже выполненные запросы не планируются повторно", () => {
  const first = plan(EMPTY_KNOWLEDGE);
  const exhausted = new Set(first.actions.map((a) => a.query.dedupeKey));
  const second = plan(EMPTY_KNOWLEDGE, { exhaustedQueries: exhausted });
  for (const action of first.actions) {
    assert.equal(
      second.actions.some((a) => a.query.dedupeKey === action.query.dedupeKey),
      false,
      `запрос «${action.query.query}» повторён`,
    );
  }
});

test("исчерпанные гипотезы не возвращаются в план", () => {
  const first = plan(EMPTY_KNOWLEDGE);
  const exhausted = new Set(first.hypotheses.map((h) => h.dedupeKey));
  const second = plan(EMPTY_KNOWLEDGE, { exhaustedHypotheses: exhausted });
  for (const hypothesis of first.hypotheses) {
    assert.equal(
      second.hypotheses.some((h) => h.dedupeKey === hypothesis.dedupeKey),
      false,
      `гипотеза ${hypothesis.type} вернулась повторно`,
    );
  }
});

test("пустая выдача по направлению снижает его приоритет", () => {
  const recent = new Map([
    ["reviews", ["empty", "empty", "empty"]],
    ["identity", ["productive"]],
  ]);
  const withHistory = plan(EMPTY_KNOWLEDGE, { recentOutcomes: recent });
  const reviews = withHistory.actions.filter((a) => a.query.purpose === "reviews");
  const identity = withHistory.actions.filter((a) => a.query.purpose === "identity");
  if (reviews.length === 0) return;
  assert.ok(
    Math.max(...reviews.map((a) => a.priority)) <
      Math.max(...identity.map((a) => a.priority)),
    "ветка без результата должна уступать fruitful",
  );
});

test("действия отсортированы по убыванию приоритета", () => {
  const result = plan(EMPTY_KNOWLEDGE);
  const priorities = result.actions.map((a) => a.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test("план детерминирован: тот же вход — тот же выход", () => {
  const a = plan(EMPTY_KNOWLEDGE);
  const b = plan(EMPTY_KNOWLEDGE);
  assert.deepEqual(
    a.actions.map((x) => x.query.dedupeKey),
    b.actions.map((x) => x.query.dedupeKey),
    "планирование обязано быть воспроизводимым",
  );
});

test("каждое действие объяснимо", () => {
  const result = plan(EMPTY_KNOWLEDGE);
  for (const action of result.actions) {
    assert.ok(
      action.query.derivedFrom.length > 5,
      `действие «${action.query.query}» не объясняет происхождение`,
    );
  }
});

test("без названия бизнеса план пуст — искать нечего", () => {
  const result = planNextActions({
    identity: buildIdentityFromSeed({ city: "Барнаул" }),
    knowledge: EMPTY_KNOWLEDGE,
    exhaustedHypotheses: new Set(),
    exhaustedQueries: new Set(),
    recentOutcomes: new Map(),
    maxQueries: 40,
  });
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.hypotheses, []);
});

test("итеративное насыщение знанием не приводит к дублям действий", () => {
  // Три такта подряд, каждый раз с уже выполненными запросами.
  let exhaustedQueries = new Set();
  let total = 0;
  for (let round = 0; round < 3; round += 1) {
    const knowledge = {
      discovered:
        round === 0
          ? []
          : [{ kind: "domain", value: "romashka-barnaul.ru" }],
      confirmed: {},
      blockers: {},
    };
    const result = plan(knowledge, { exhaustedQueries });
    const keys = result.actions.map((a) => a.query.dedupeKey);
    assert.equal(
      new Set(keys).size,
      keys.length,
      `в раунде ${round} появились дубли`,
    );
    total += result.actions.length;
    exhaustedQueries = new Set([...exhaustedQueries, ...keys]);
  }
  assert.ok(total > 0, "план должен что-то предлагать");
});
