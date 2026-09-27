import test from "node:test";
import assert from "node:assert/strict";
import {
  validateLeadAnswer,
  keyboardForField,
} from "../src/server/leads/validation.ts";
import {
  assertLeadTransition,
  allowedLeadTransitions,
  leadWaitMeta,
} from "../src/server/leads/status.ts";
import {
  LEAD_STATUS_TRANSITIONS,
  leadTransitionActionLabel,
} from "../src/lib/leadStatus.ts";
import { leadSolutionCardState } from "../src/server/leads/readiness.ts";
import {
  parseLeadSetupV2,
  convertV1ToV2,
  validateLeadSetupV2,
} from "../src/server/leads/setup.ts";
import {
  newLeadSetupV2,
  DEFAULT_BUTTON_LABEL,
} from "../src/lib/leadSetupV2.ts";
import {
  LEAD_FORM_BUILDER_CREATE_TYPES,
  leadFormBuilderTypeLabel,
} from "../src/components/leads/LeadFormBuilder.tsx";

function field(partial) {
  return {
    fieldKey: partial.fieldKey || "f",
    label: partial.label || "Поле",
    fieldType: partial.fieldType,
    required: partial.required ?? true,
    placeholder: partial.placeholder || "",
    options: partial.options || [],
    position: partial.position ?? 0,
  };
}

test("validateLeadAnswer: phone invalid", () => {
  const r = validateLeadAnswer(field({ fieldType: "phone" }), "12345");
  assert.equal(r.ok, false);
  assert.match(r.message, /телефон/i);
});

test("validateLeadAnswer: phone valid normalizes", () => {
  const r = validateLeadAnswer(field({ fieldType: "phone" }), "+7 999 123-45-67");
  assert.equal(r.ok, true);
  assert.equal(r.value, "+79991234567");
});

test("validateLeadAnswer: email invalid", () => {
  const r = validateLeadAnswer(field({ fieldType: "email" }), "not-an-email");
  assert.equal(r.ok, false);
  assert.match(r.message, /email/i);
});

test("validateLeadAnswer: number invalid", () => {
  const r = validateLeadAnswer(field({ fieldType: "number" }), "abc");
  assert.equal(r.ok, false);
  assert.match(r.message, /число/i);
});

test("validateLeadAnswer: number accepts comma decimal", () => {
  const r = validateLeadAnswer(field({ fieldType: "number" }), "12,5");
  assert.equal(r.ok, true);
  assert.equal(r.value, "12.5");
});

test("validateLeadAnswer: select unknown option rejected", () => {
  const r = validateLeadAnswer(
    field({
      fieldType: "select",
      options: ["A", "B"],
    }),
    "C",
  );
  assert.equal(r.ok, false);
  assert.match(r.message, /вариант/i);
});

test("validateLeadAnswer: select known label", () => {
  const r = validateLeadAnswer(
    field({
      fieldType: "select",
      options: [
        { label: "Консультация", value: "consult" },
        { label: "Ремонт", value: "repair" },
      ],
    }),
    "Консультация",
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, "consult");
});

test("validateLeadAnswer: multiselect resolves labels", () => {
  const r = validateLeadAnswer(
    field({
      fieldType: "multiselect",
      options: ["A", "B", "C"],
    }),
    "A, C",
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, ["A", "C"]);
});

test("validateLeadAnswer: multiselect unknown rejected", () => {
  const r = validateLeadAnswer(
    field({
      fieldType: "multiselect",
      options: ["A", "B"],
    }),
    "A, Z",
  );
  assert.equal(r.ok, false);
});

test("validateLeadAnswer: required skip rejected", () => {
  for (const raw of ["/skip", "Пропустить"]) {
    const r = validateLeadAnswer(
      field({ fieldType: "text", required: true }),
      raw,
      { skip: true },
    );
    assert.equal(r.ok, false);
    assert.match(r.message, /обязательн/i);
  }
});

test("validateLeadAnswer: optional skip accepted", () => {
  const r = validateLeadAnswer(
    field({ fieldType: "text", required: false }),
    "Пропустить",
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, null);
});

test("validateLeadAnswer: date invalid", () => {
  const r = validateLeadAnswer(field({ fieldType: "date" }), "tomorrow");
  assert.equal(r.ok, false);
  assert.match(r.message, /дат/i);
});

test("validateLeadAnswer: date formats accepted and normalized", () => {
  assert.deepEqual(
    validateLeadAnswer(field({ fieldType: "date" }), "2026-12-25"),
    { ok: true, value: "2026-12-25" },
  );
  assert.deepEqual(
    validateLeadAnswer(field({ fieldType: "date" }), "25.12.2026"),
    { ok: true, value: "2026-12-25" },
  );
  assert.deepEqual(
    validateLeadAnswer(field({ fieldType: "date" }), "25.12.26"),
    { ok: true, value: "2026-12-25" },
  );
  assert.equal(
    validateLeadAnswer(field({ fieldType: "date" }), "31.02.2026").ok,
    false,
  );
});

test("validateLeadAnswer: checkbox yes/no", () => {
  assert.deepEqual(
    validateLeadAnswer(field({ fieldType: "checkbox" }), "Да"),
    { ok: true, value: true },
  );
  assert.deepEqual(
    validateLeadAnswer(field({ fieldType: "checkbox" }), "Нет"),
    { ok: true, value: false },
  );
  assert.equal(
    validateLeadAnswer(field({ fieldType: "checkbox" }), "maybe").ok,
    false,
  );
});

test("validateLeadAnswer: budget accepts amount and free text", () => {
  const numeric = validateLeadAnswer(field({ fieldType: "budget" }), "10 000");
  assert.equal(numeric.ok, true);
  assert.equal(numeric.value, "10000");
  // Digit extraction path collapses spaces when residual digits form an integer.
  const mixed = validateLeadAnswer(field({ fieldType: "budget" }), "от 10000");
  assert.equal(mixed.ok, true);
  assert.equal(mixed.value, "от10000");
  const free = validateLeadAnswer(field({ fieldType: "budget" }), "договорная");
  assert.equal(free.ok, true);
  assert.equal(free.value, "договорная");
});

test("allowedLeadTransitions covers all statuses", () => {
  assert.deepEqual(allowedLeadTransitions("new").sort(), [
    "closed",
    "processing",
    "rejected",
  ]);
  assert.deepEqual(allowedLeadTransitions("processing").sort(), [
    "closed",
    "completed",
    "new",
    "rejected",
    "waiting_customer",
  ]);
  assert.deepEqual(allowedLeadTransitions("waiting_customer").sort(), [
    "closed",
    "completed",
    "processing",
  ]);
  assert.deepEqual(allowedLeadTransitions("completed"), []);
  assert.deepEqual(allowedLeadTransitions("rejected"), []);
  assert.deepEqual(allowedLeadTransitions("closed"), []);
});

test("assertLeadTransition allows and rejects correctly", () => {
  assertLeadTransition("new", "processing");
  assertLeadTransition("new", "new");
  assertLeadTransition("processing", "new");
  assert.throws(
    () => assertLeadTransition("new", "completed"),
    (err) =>
      err &&
      typeof err === "object" &&
      err.status === 400 &&
      err.code === "INVALID_STATUS_TRANSITION",
  );
  assert.throws(
    () => assertLeadTransition("completed", "new"),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "INVALID_STATUS_TRANSITION",
  );
});

test("status transitions: every from→to pair allowed or forbidden", () => {
  const statuses = Object.keys(LEAD_STATUS_TRANSITIONS);
  for (const from of statuses) {
    const allowed = new Set(LEAD_STATUS_TRANSITIONS[from]);
    for (const to of statuses) {
      if (from === to || allowed.has(to)) {
        assert.doesNotThrow(() => assertLeadTransition(from, to));
      } else {
        assert.throws(
          () => assertLeadTransition(from, to),
          (err) =>
            err &&
            typeof err === "object" &&
            err.code === "INVALID_STATUS_TRANSITION",
          `${from} → ${to} must be forbidden`,
        );
      }
    }
  }
  assert.equal(
    leadTransitionActionLabel("processing", "new"),
    "Вернуть в новые",
  );
  assert.equal(
    leadTransitionActionLabel("new", "processing"),
    "Взять в работу",
  );
});

test("leadSolutionCardState table-driven states", () => {
  const baseSetup = {
    version: 2,
    setupStep: 0,
    completed: false,
    channels: [],
    buttonLabel: "Оставить заявку",
    greeting: "Привет",
    finalMessage: "Спасибо",
    notifyOwner: true,
    notifyAssignee: true,
    slaMinutes: null,
  };

  const cases = [
    {
      name: "not configured",
      entitled: false,
      readiness: {
        ready: false,
        checks: [{ code: "ENTITLEMENT", ok: true }],
        setup: { ...baseSetup },
        revision: 0,
      },
      expect: "not_configured",
    },
    {
      name: "in progress",
      entitled: true,
      readiness: {
        ready: false,
        checks: [
          { code: "ENTITLEMENT", ok: true },
          { code: "FORM_FIELDS", ok: false, message: "Добавьте поля" },
        ],
        setup: { ...baseSetup, setupStep: 2 },
        revision: 1,
      },
      expect: "in_progress",
    },
    {
      name: "ready to launch",
      entitled: false,
      readiness: {
        ready: true,
        checks: [{ code: "ENTITLEMENT", ok: true }],
        setup: { ...baseSetup, setupStep: 5, completed: false },
        revision: 2,
      },
      expect: "ready",
    },
    {
      name: "active",
      entitled: true,
      readiness: {
        ready: true,
        checks: [{ code: "ENTITLEMENT", ok: true }],
        setup: { ...baseSetup, setupStep: 6, completed: true },
        revision: 3,
      },
      expect: "active",
    },
    {
      name: "channel attention",
      entitled: true,
      readiness: {
        ready: false,
        checks: [
          { code: "ENTITLEMENT", ok: true },
          {
            code: "CHANNEL_TELEGRAM",
            ok: false,
            message: "Бот Telegram недоступен.",
            cta: { label: "Подключения", href: "/connections" },
          },
        ],
        setup: { ...baseSetup, setupStep: 6, completed: true },
        revision: 4,
      },
      expect: "attention",
    },
    {
      name: "paused/disabled",
      entitled: false,
      readiness: {
        ready: false,
        checks: [
          {
            code: "ENTITLEMENT",
            ok: false,
            message: "Решение выключено. Включите его в разделе «Решения».",
            cta: { label: "Открыть решения", href: "/solutions" },
          },
        ],
        setup: { ...baseSetup, setupStep: 6, completed: true },
        revision: 5,
      },
      expect: "paused",
    },
  ];

  for (const row of cases) {
    const result = leadSolutionCardState(row.readiness, row.entitled);
    assert.equal(result.state, row.expect, row.name);
  }
});

test("LeadFormBuilder covers backend-supported field types", () => {
  const createValues = LEAD_FORM_BUILDER_CREATE_TYPES.map((t) => t.value);
  for (const type of [
    "text",
    "textarea",
    "phone",
    "email",
    "number",
    "select",
    "multiselect",
    "date",
    "checkbox",
    "attachment",
    "address",
    "budget",
    "service",
    "message",
  ]) {
    assert.ok(createValues.includes(type), `missing create type ${type}`);
  }
  assert.ok(!createValues.includes("name"), "system name is not creatable");
  assert.equal(leadFormBuilderTypeLabel("multiselect"), "Несколько вариантов");
  assert.equal(leadFormBuilderTypeLabel("name"), "Имя");
  assert.equal(leadFormBuilderTypeLabel("select"), "Список");
});

test("leadWaitMeta SLA labels", () => {
  const created = new Date(Date.now() - 20 * 60_000);
  const waiting = leadWaitMeta(created, null, 15);
  assert.equal(waiting.overdue, true);
  assert.equal(waiting.overdueMinutes, 5);
  assert.equal(waiting.label, "Просрочено на 5 мин");

  const ok = leadWaitMeta(created, null, 60);
  assert.equal(ok.overdue, false);
  assert.match(ok.label, /^Ждёт \d+ мин$/);

  const noSla = leadWaitMeta(created, null, null);
  assert.equal(noSla.overdue, false);
  assert.match(noSla.label, /^Ждёт \d+ мин$/);

  const taken = leadWaitMeta(created, new Date(), 15);
  assert.equal(taken.label, null);
});

test("parseLeadSetupV2 / convertV1ToV2 / validateLeadSetupV2", () => {
  assert.deepEqual(parseLeadSetupV2(null).version, 2);
  assert.equal(parseLeadSetupV2({ version: 99 }).setupStep, 0);

  const v1 = {
    version: 1,
    step: 3,
    channels: ["telegram", "vk"],
    fields: ["name", "phone"],
    title: "Заявка",
    greeting: "Привет",
    finalMessage: "Спасибо",
  };
  const converted = convertV1ToV2(v1);
  assert.equal(converted.version, 2);
  assert.equal(converted.completed, true);
  assert.equal(converted.setupStep, 6);
  assert.equal(converted.buttonLabel, "Заявка");
  assert.deepEqual(converted.channels, ["telegram", "vk"]);

  const viaParse = parseLeadSetupV2(v1);
  assert.equal(viaParse.completed, true);
  assert.equal(viaParse.buttonLabel, "Заявка");

  const incomplete = convertV1ToV2({
    ...v1,
    step: 1,
    channels: ["telegram"],
  });
  assert.equal(incomplete.completed, false);
  assert.equal(incomplete.setupStep, 1);

  const valid = validateLeadSetupV2({
    ...newLeadSetupV2(),
    buttonLabel: DEFAULT_BUTTON_LABEL,
    channels: ["telegram"],
    completed: true,
    setupStep: 6,
  });
  assert.equal(valid.completed, true);

  assert.throws(
    () =>
      validateLeadSetupV2({
        ...newLeadSetupV2(),
        channels: [],
        completed: true,
      }),
    (err) =>
      err &&
      typeof err === "object" &&
      err.code === "INVALID_SETUP" &&
      err.status === 400,
  );
});

test("keyboardForField pagination page size 7", () => {
  const options = Array.from({ length: 16 }, (_, i) => `Opt${i + 1}`);
  const f = field({
    fieldType: "select",
    required: true,
    options,
  });
  const page0 = keyboardForField(f, 0, 7);
  assert.deepEqual(page0.slice(0, 7), options.slice(0, 7));
  assert.ok(page0.includes("Далее →"));
  assert.ok(!page0.includes("← Назад по списку"));
  assert.ok(page0.includes("Отмена"));

  const page1 = keyboardForField(f, 1, 7);
  assert.deepEqual(page1.slice(0, 7), options.slice(7, 14));
  assert.ok(page1.includes("Далее →"));
  assert.ok(page1.includes("← Назад по списку"));

  const page2 = keyboardForField(f, 2, 7);
  assert.deepEqual(page2.slice(0, 2), options.slice(14, 16));
  assert.ok(!page2.includes("Далее →"));
  assert.ok(page2.includes("← Назад по списку"));

  const multi = keyboardForField(
    field({ fieldType: "multiselect", required: false, options: ["A"] }),
    0,
    7,
  );
  assert.ok(multi.includes("✓ Готово"));
  assert.ok(multi.includes("Пропустить"));

  const checkbox = keyboardForField(field({ fieldType: "checkbox" }), 0, 7);
  assert.deepEqual(checkbox.slice(0, 2), ["Да", "Нет"]);
});
