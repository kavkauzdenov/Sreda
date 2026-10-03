import test from "node:test";
import assert from "node:assert/strict";

import {
  STOP_REASON_LABELS,
  decideStop,
  duplicationFor,
  evaluateCoverage,
  noveltyFor,
  relevanceFor,
  scoreAction,
} from "../src/server/intelligence/osint/research/coverage.ts";
import {
  ACCESS_STATUS_BY_REASON,
  blockedReasonLabel,
  classifyBlockedReason,
  decideFallback,
  isRetryableReason,
} from "../src/server/intelligence/osint/research/fallback.ts";
import { buildIdentityFromSeed } from "../src/server/intelligence/osint/research/identity-builder.ts";

/* ------------------------------------------------------------------ */
/* Оценка следующего действия (§23, §24)                               */
/* ------------------------------------------------------------------ */

const signals = {
  purpose: "identity",
  identityRelevance: 1,
  expectedInformationGain: 0.9,
  sourceReliability: 0.7,
  novelty: 0.8,
  cost: 1,
  duplication: 0,
};

test("приоритет выше у информативного дешёвого действия", () => {
  const good = scoreAction(signals);
  const bad = scoreAction({ ...signals, expectedInformationGain: 0.1, duplication: 0.8 });
  assert.ok(good.priority > bad.priority, `${good.priority} должно быть выше ${bad.priority}`);
});

test("дублирование снижает приоритет сильнее, чем его добавляло", () => {
  const base = scoreAction(signals).priority;
  const duplicated = scoreAction({ ...signals, duplication: 1 }).priority;
  assert.ok(duplicated < base, `дублирование должно снижать: ${duplicated} < ${base}`);
});

test("стоимость снижает приоритет", () => {
  const cheap = scoreAction({ ...signals, cost: 1 }).priority;
  const costly = scoreAction({ ...signals, cost: 5 }).priority;
  assert.ok(costly < cheap, "дорогое действие должно быть менее привлекательным");
});

test("действие получает объяснение", () => {
  const scored = scoreAction(signals);
  assert.ok(scored.explanation.length > 0, "действие должно объяснять себя");
  const dup = scoreAction({ ...signals, duplication: 0.9 });
  assert.match(dup.explanation, /повтор|изученн/i);
});

test("независимый источник надёжнее и получает больший приоритет", () => {
  const reliable = scoreAction({ ...signals, sourceReliability: 0.9 }).priority;
  const dubious = scoreAction({ ...signals, sourceReliability: 0.1 }).priority;
  assert.ok(reliable > dubious);
});

test("пока бизнес не опознан, опознание релевантнее подтверждений", () => {
  const weak = buildIdentityFromSeed({ name: "Кафе Ромашка", city: "Барнаул" });
  const strong = buildIdentityFromSeed({
    name: "Кафе Ромашка",
    city: "Барнаул",
    phone: "+73852551010",
  });
  const noConfirmed = {};
  assert.ok(
    relevanceFor(weak, "identity", noConfirmed) >
      relevanceFor(strong, "identity", noConfirmed),
    "опознание теряет смысл, когда бизнес уже опознан",
  );
});

test("найденный контакт обесценивает повторный поиск контактов", () => {
  const identity = buildIdentityFromSeed({ name: "Кафе Ромашка" });
  assert.ok(
    relevanceFor(identity, "contact", { contact: true }) <
      relevanceFor(identity, "contact", { contact: false }),
  );
});

test("новизна падает на пустых и дублирующих результатах", () => {
  assert.equal(noveltyFor([]), 1, "без истории новизна максимальна");
  assert.equal(noveltyFor(["productive", "productive"]), 1);
  const barren = noveltyFor(["empty", "empty", "duplicate", "empty"]);
  assert.ok(barren < 0.25, `пустые ветки должны терять новизну: ${barren}`);
});

test("дублирование считается по пустым и дублирующим исходам", () => {
  assert.equal(duplicationFor([]), 0);
  assert.equal(duplicationFor(["productive", "productive"]), 0);
  assert.equal(duplicationFor(["empty", "duplicate"]), 1);
});

/* ------------------------------------------------------------------ */
/* Покрытие и насыщение (§37, §70)                                     */
/* ------------------------------------------------------------------ */

const emptyCoverageInput = {
  confirmed: {},
  blockers: {},
  barrenActions: 0,
  exhausted: false,
  budgetExhausted: false,
};

test("покрытие не обещает полноту: без данных оно низкое", () => {
  const report = evaluateCoverage(emptyCoverageInput);
  assert.ok(report.overall < 0.3, `пустое покрытие должно быть низким: ${report.overall}`);
  assert.ok(report.unknown.length > 0, "неизвестное должно быть перечислено");
});

test("подтверждённое направление поднимает покрытие и попадает в covered", () => {
  const report = evaluateCoverage({
    ...emptyCoverageInput,
    confirmed: { identity: true, website: true },
  });
  assert.ok(report.covered.includes("Идентичность"));
  assert.ok(report.covered.includes("Сайт"));
  assert.ok(report.overall > 0.05);
});

test("заблокированное направление не выглядит как полностью исследованное", () => {
  const report = evaluateCoverage({
    ...emptyCoverageInput,
    confirmed: { identity: true },
    blockers: { reviews: ["Источник требует проверки человеком"] },
  });
  const reviews = report.dimensions.find((entry) => entry.key === "reviews");
  assert.ok(reviews.level < 1, "заблокированное направление не закрыто");
  assert.ok(reviews.level > 0, "но прогресс есть — мы знаем причину");
  assert.deepEqual(reviews.blockers, ["Источник требует проверки человеком"]);
});

test("покрытие всегда в границах 0..1 и никогда не «100%»", () => {
  const report = evaluateCoverage({
    ...emptyCoverageInput,
    confirmed: Object.fromEntries(
      Object.keys({
        identity: 1,
        website: 1,
        contacts: 1,
        social: 1,
        reviews: 1,
        legal: 1,
        mentions: 1,
        locations: 1,
        news: 1,
        vacancies: 1,
      }).map((key) => [key, true]),
    ),
  });
  assert.ok(report.overall <= 1 && report.overall >= 0);
  assert.ok(
    report.unknown.length === 0,
    "даже при полном подтверждении неизвестное не должно исчезать совсем",
  );
});

test("насыщение наступает после серии действий без нового знания", () => {
  assert.equal(evaluateCoverage(emptyCoverageInput).saturating, false);
  const saturating = evaluateCoverage({ ...emptyCoverageInput, barrenActions: 9 });
  assert.equal(saturating.saturating, true);
});

test("насыщение требует подтверждения, а не одного простоя", () => {
  assert.equal(evaluateCoverage({ ...emptyCoverageInput, barrenActions: 2 }).saturating, false);
  assert.equal(evaluateCoverage({ ...emptyCoverageInput, barrenActions: 7 }).saturating, false);
});

/* ------------------------------------------------------------------ */
/* Причина остановки (§72)                                             */
/* ------------------------------------------------------------------ */

test("исчерпанный бюджет останавливает исследование явно", () => {
  const reason = decideStop({
    budgetExhausted: true,
    pendingActions: 10,
    barrenActions: 0,
    coverage: evaluateCoverage(emptyCoverageInput),
  });
  assert.equal(reason, "budget_exhausted");
  assert.ok(STOP_REASON_LABELS[reason].length > 0);
});

test("при отсутствии действий агент останавливается, а не крутится", () => {
  const reason = decideStop({
    budgetExhausted: false,
    pendingActions: 0,
    barrenActions: 0,
    coverage: evaluateCoverage(emptyCoverageInput),
  });
  assert.ok(["no_useful_actions", "information_gain_exhausted"].includes(reason));
});

test("агент не останавливается, пока есть что делать и информация прибывает", () => {
  const reason = decideStop({
    budgetExhausted: false,
    pendingActions: 5,
    barrenActions: 0,
    coverage: evaluateCoverage(emptyCoverageInput),
  });
  assert.equal(reason, null);
});

test("при насыщении агент сворачивается к концу очереди", () => {
  const coverage = evaluateCoverage({ ...emptyCoverageInput, barrenActions: 9 });
  const reason = decideStop({
    budgetExhausted: false,
    pendingActions: 2,
    barrenActions: 9,
    coverage,
  });
  assert.equal(reason, "information_gain_exhausted");
});

/* ------------------------------------------------------------------ */
/* Блокировки: таксономия и fallback (§11, §12, §38)                    */
/* ------------------------------------------------------------------ */

test("HTTP-исходы различаются, а не схлопываются в http_error", () => {
  assert.equal(classifyBlockedReason({ httpStatus: 403 }), "http_403");
  assert.equal(classifyBlockedReason({ httpStatus: 404 }), "http_404");
  assert.equal(classifyBlockedReason({ httpStatus: 429 }), "http_429");
  assert.equal(classifyBlockedReason({ httpStatus: 503 }), "http_5xx");
});

test("причины safe-fetch попадают в таксономию", () => {
  assert.equal(classifyBlockedReason({ fetchReason: "robots_disallowed" }), "robots_disallowed");
  assert.equal(classifyBlockedReason({ fetchReason: "timeout" }), "timeout");
  assert.equal(classifyBlockedReason({ fetchReason: "private_address" }), "private_address");
  assert.equal(classifyBlockedReason({ fetchReason: "redirect_limit" }), "redirect_limit");
});

test("защитный барьер распознаётся как captcha", () => {
  assert.equal(
    classifyBlockedReason({ challengeDetected: true, httpStatus: 200 }),
    "captcha",
    "200 с защитным барьером — это не успех",
  );
});

test("успешная попытка не классифицируется как блокировка", () => {
  assert.equal(classifyBlockedReason({ httpStatus: 200 }), null);
  assert.equal(classifyBlockedReason({}), null);
});

test("у каждой причины есть человекочитаемое объяснение без кодов", () => {
  const reasons = Object.keys(ACCESS_STATUS_BY_REASON);
  for (const reason of reasons) {
    const label = blockedReasonLabel(reason);
    assert.ok(label.length > 5, `пустое объяснение для ${reason}`);
    assert.equal(
      /_|[0-9]{3}/.test(label),
      false,
      `в объяснении для ${reason} просочилась техническая деталь: ${label}`,
    );
  }
});

test("CAPTCHA не повторяется — состояние не изменится само", () => {
  assert.equal(isRetryableReason("captcha"), false);
  const decision = decideFallback("captcha");
  assert.equal(decision.retrySource, false);
  assert.equal(decision.changeStrategy, true);
});

test("robots.txt не обходится: меняем маршрут, а не игнорируем запрет", () => {
  const decision = decideFallback("robots_disallowed");
  assert.equal(decision.retrySource, false);
  assert.equal(decision.changeStrategy, true);
  assert.match(decision.reason, /друг/i);
});

test("временные сбои повторяются, но маршрут всё равно меняется", () => {
  for (const reason of ["http_429", "timeout", "http_5xx"]) {
    const decision = decideFallback(reason);
    assert.equal(decision.retrySource, true, `${reason} должен быть повторяемым`);
    assert.equal(decision.changeStrategy, true, `${reason}: идём дальше сейчас`);
  }
});

test("НИ ОДНА блокировка не останавливает всё исследование", () => {
  for (const reason of Object.keys(ACCESS_STATUS_BY_REASON)) {
    const decision = decideFallback(reason);
    assert.equal(
      decision.changeStrategy,
      true,
      `${reason}: исследование должно продолжиться другой веткой`,
    );
    assert.ok(decision.alternative !== "none", `${reason}: должна быть альтернатива`);
    assert.ok(decision.reason.length > 5, `${reason}: нужно объяснение`);
  }
});

test("приватный адрес не обходится — это отказ нашей SSRF-защиты", () => {
  const decision = decideFallback("private_address");
  assert.equal(decision.retrySource, false);
  assert.equal(decision.alternative, "other_source");
});

test("каждый статус доступа соответствует смыслу, а не HTTP-коду", () => {
  assert.equal(ACCESS_STATUS_BY_REASON.captcha, "blocked");
  assert.equal(ACCESS_STATUS_BY_REASON.http_403, "blocked");
  assert.equal(ACCESS_STATUS_BY_REASON.http_429, "rate_limited");
  assert.equal(ACCESS_STATUS_BY_REASON.robots_disallowed, "robots_disallowed");
  assert.equal(ACCESS_STATUS_BY_REASON.http_404, "not_found");
});
