import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  assertCanGrantEntitlement,
  assertEntitlement,
  buildBillingSummary,
  getEntitlement,
  listEntitlements,
  MockBillingProvider,
  NoopBillingProvider,
} from "../src/server/billing/index.ts";
import { readFileSync } from "node:fs";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function fixture() {
  const business = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Студия",
      timezone: "Europe/Moscow",
      business_type: "hybrid",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return business;
}

test("getEntitlement reports absent when no business_solution row", async () => {
  const business = await fixture();
  const entitlement = await getEntitlement(db, business.id, "leads");
  assert.equal(entitlement.status, "absent");
  assert.equal(entitlement.entitled, false);
});

test("getEntitlement and assertEntitlement honour active and expired rows", async () => {
  const business = await fixture();
  await db
    .insertInto("business_solution")
    .values({
      business_id: business.id,
      solution_code: "booking",
      status: "active",
      starts_at: new Date(),
      expires_at: null,
    })
    .execute();

  const ok = await getEntitlement(db, business.id, "booking");
  assert.equal(ok.entitled, true);
  assert.equal(ok.status, "active");
  await assertEntitlement(db, business.id, "booking");

  await db
    .updateTable("business_solution")
    .set({
      status: "expired",
      expires_at: new Date(Date.now() - 60_000),
      updated_at: new Date(),
    })
    .where("business_id", "=", business.id)
    .where("solution_code", "=", "booking")
    .execute();

  const expired = await getEntitlement(db, business.id, "booking");
  assert.equal(expired.entitled, false);
  await assert.rejects(
    () => assertEntitlement(db, business.id, "booking"),
    (err) =>
      err instanceof Error &&
      "code" in err &&
      err.code === "ENTITLEMENT_REQUIRED",
  );
});

test("trial entitlement is active until expires_at", async () => {
  const business = await fixture();
  await db
    .insertInto("business_solution")
    .values({
      business_id: business.id,
      solution_code: "orders",
      status: "trial",
      starts_at: new Date(),
      expires_at: new Date(Date.now() + 86_400_000),
    })
    .execute();
  const entitlement = await getEntitlement(db, business.id, "sales");
  assert.equal(entitlement.solutionCode, "orders");
  assert.equal(entitlement.entitled, true);
  assert.equal(entitlement.status, "trial");
});

test("paid billing mode blocks grants until provider-backed subscription exists", async () => {
  const business = await fixture();
  const previous = process.env.BILLING_MODE;
  process.env.BILLING_MODE = "paid";
  try {
    await assert.rejects(
      () =>
        assertCanGrantEntitlement({
          db,
          businessId: business.id,
          solutionCode: "leads",
        }),
      (err) =>
        err instanceof Error &&
        "code" in err &&
        err.code === "PAYMENT_REQUIRED",
    );

    const subscription = await db
      .insertInto("business_subscription")
      .values({
        business_id: business.id,
        status: "active",
        provider: "yookassa",
        current_period_start: new Date(),
        current_period_end: new Date(Date.now() + 30 * 86_400_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("business_subscription_item")
      .values({
        subscription_id: subscription.id,
        business_id: business.id,
        solution_code: "leads",
        plan_code: "plan_leads",
        unit_price_minor: 25000,
        currency: "RUB",
        quantity: 1,
      })
      .execute();

    await assertCanGrantEntitlement({
      db,
      businessId: business.id,
      solutionCode: "leads",
    });
  } finally {
    if (previous === undefined) delete process.env.BILLING_MODE;
    else process.env.BILLING_MODE = previous;
  }
});

test("buildBillingSummary stays honest without payment success", async () => {
  const business = await fixture();
  await db
    .insertInto("business_solution")
    .values({
      business_id: business.id,
      solution_code: "leads",
      status: "active",
      starts_at: new Date(),
      expires_at: null,
    })
    .execute();
  const entitlements = await listEntitlements(db, business.id);
  const summary = buildBillingSummary(business.id, entitlements);
  assert.equal(summary.paymentConnected, false);
  assert.equal(summary.entitledCount, 1);
  assert.equal(summary.estimatedMonthlyRub, 250);
  assert.match(summary.statusLabel, /оплата не подключена/i);
  assert.match(summary.nextStep, /Подключение оплаты/i);
  assert.equal(summary.statusLabel.includes("успеш"), false);
});

test("NoopBillingProvider refuses checkout without fake success", async () => {
  const provider = new NoopBillingProvider();
  await assert.rejects(
    () =>
      provider.createCheckout({
        businessId: randomUUID(),
        solutionCodes: ["leads"],
        successUrl: "https://example.test/ok",
        cancelUrl: "https://example.test/cancel",
      }),
    (err) => {
      const code = err && typeof err === "object" && "code" in err ? err.code : null;
      const status =
        err && typeof err === "object" && "status" in err ? err.status : null;
      return (
        status === 501 ||
        code === "BILLING_NOT_CONFIGURED" ||
        /не настроено/i.test(String(err?.message ?? err))
      );
    },
  );
  const webhook = await provider.handleWebhook("{}", new Headers());
  assert.equal(webhook.handled, false);
});

test("MockBillingProvider is test-only and blocked in production", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const mock = new MockBillingProvider();
  const session = await mock.createCheckout({
    businessId: randomUUID(),
    solutionCodes: ["booking"],
    successUrl: "https://example.test/ok",
    cancelUrl: "https://example.test/cancel",
  });
  assert.equal(session.provider, "mock");
  assert.equal(mock.listCheckouts().length, 1);

  process.env.NODE_ENV = "production";
  assert.throws(() => new MockBillingProvider(), /test-only/i);
  process.env.NODE_ENV = previous;
});

test("migration 055 seeds billing_plan without billing_entitlement table", async () => {
  const plans = await db
    .selectFrom("billing_plan")
    .select(["code", "unit_price_minor", "solution_code"])
    .execute();
  assert.ok(plans.length >= 5);
  assert.ok(plans.some((p) => p.code === "plan_leads" && p.unit_price_minor === 25000));
  assert.ok(plans.some((p) => p.solution_code === "admin_messages" && p.unit_price_minor === 0));

  const sql = readFileSync(
    new URL("../migrations/055_billing_domain.sql", import.meta.url),
    "utf8",
  );
  assert.equal(/create table\s+billing_entitlement/i.test(sql), false);
  assert.match(sql, /business_solution/i);
});

test("billing page and docs reject fake payment success copy", () => {
  const page = readFileSync(
    new URL("../src/app/(app)/billing/page.tsx", import.meta.url),
    "utf8",
  );
  const view = readFileSync(
    new URL("../src/components/billing/BillingView.tsx", import.meta.url),
    "utf8",
  );
  const docs = readFileSync(new URL("../docs/BILLING.md", import.meta.url), "utf8");
  assert.match(view, /Подключение оплаты — следующий шаг/);
  assert.equal(/PagePlaceholder|этап 3/i.test(page), false);
  assert.equal(/payment succeeded|оплата прошла|платёж успешен/i.test(view), false);
  assert.match(docs, /NoopBillingProvider/);
  assert.match(docs, /business_solution/);
});
