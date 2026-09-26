import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDerivedStep,
  readinessSetupSteps,
  resolveSetupSteps,
  setupStepsForIndustry,
} from "../src/lib/setupSteps.ts";

const noReadiness = {};

test("telegram step is derived from live readiness, not manual ticks", () => {
  const steps = setupStepsForIndustry("other");
  const step = (readiness, progress) =>
    resolveSetupSteps({ steps, progress, readiness }).steps.find(
      (s) => s.id === "telegram",
    );
  assert.equal(step({ hasConnection: true }, {}).done, true);
  assert.equal(step({ hasConnection: true }, { telegram: false }).done, true);
  assert.equal(step({ hasConnection: false }, { telegram: true }).done, false);
  assert.equal(step({}, { telegram: true }).done, false);
  assert.equal(isDerivedStep("telegram"), true);
});

test("already-connected business counts the Telegram step as done", () => {
  const steps = setupStepsForIndustry("other");
  const connected = resolveSetupSteps({
    steps,
    progress: {},
    readiness: {
      hasIndustry: true,
      hasActiveSolution: true,
      hasConnection: true,
    },
  });
  assert.equal(connected.done, 3);
  assert.equal(connected.total, 4);
  assert.equal(connected.next?.id, "ai");

  const missing = resolveSetupSteps({
    steps,
    progress: {},
    readiness: { hasIndustry: true, hasActiveSolution: true },
  });
  assert.equal(missing.done, 2);
  assert.equal(missing.next?.id, "telegram");
  assert.equal(missing.next?.href, "/connections");
});

test("resolution is idempotent: repeated evaluation does not drift", () => {
  const steps = setupStepsForIndustry("retail");
  const readiness = { hasIndustry: true, hasConnection: true };
  const first = resolveSetupSteps({ steps, progress: { catalog: true }, readiness });
  const second = resolveSetupSteps({ steps, progress: { catalog: true }, readiness });
  const third = resolveSetupSteps({ steps, progress: { catalog: true }, readiness });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.done, 2);
  assert.equal(first.next?.id, "orders");
});

test("manual steps still come from setup_progress", () => {
  const steps = setupStepsForIndustry("retail");
  assert.equal(isDerivedStep("catalog"), false);
  const resolved = resolveSetupSteps({
    steps,
    progress: { catalog: true, orders: true, telegram: true },
    readiness: { hasIndustry: true, hasConnection: true },
  });
  assert.equal(resolved.done, 3);
  assert.equal(resolved.total, 3);
  assert.equal(resolved.next, null);
});

test("compact readiness steps resolve the same way as full steps", () => {
  const resolved = resolveSetupSteps({
    steps: readinessSetupSteps(),
    progress: {},
    readiness: {
      hasIndustry: true,
      hasActiveSolution: false,
      hasConnection: true,
    },
  });
  assert.equal(resolved.done, 2);
  assert.equal(resolved.total, 3);
  assert.equal(resolved.next?.id, "solutions");
});

test("every industry step list keeps the Telegram step linkable", () => {
  for (const industry of [
    "beauty",
    "sport_health",
    "education",
    "rental",
    "retail",
    "food",
    "automotive",
    "construction",
    "professional_services",
    "other",
    null,
  ]) {
    const steps = setupStepsForIndustry(industry);
    const telegram = steps.find((s) => s.id === "telegram");
    assert.ok(telegram, `no telegram step for ${industry}`);
    assert.match(telegram.href, /connections/);
  }
});

test("derived steps stay false without readiness even if ticked manually", () => {
  const resolved = resolveSetupSteps({
    steps: setupStepsForIndustry("other"),
    progress: { industry: true, solutions: true, telegram: true, ai: true },
    readiness: noReadiness,
  });
  assert.equal(
    resolved.steps.find((s) => s.id === "ai")?.done,
    true,
    "manual step must follow setup_progress",
  );
  for (const id of ["industry", "solutions", "telegram"]) {
    assert.equal(
      resolved.steps.find((s) => s.id === id)?.done,
      false,
      `${id} must not be completed without readiness`,
    );
  }
  assert.equal(resolved.done, 1);
});
