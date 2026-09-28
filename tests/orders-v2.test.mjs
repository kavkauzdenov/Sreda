/**
 * Orders V2 service coverage — PGlite + migrate fixtures (same pattern as orders.test.mjs).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  CatalogService,
  OrderService,
} from "../src/server/orders/service.ts";
import {
  listOrdersV2,
  getOrderSummary,
  parseOrderListFilters,
} from "../src/server/orders/list.ts";
import { claimOrder, assignOrder } from "../src/server/orders/assignment.ts";
import {
  getOrderSettingsV2,
  saveOrderSettingsV2,
  calculateDeliveryFee,
} from "../src/server/orders/settings.ts";
import { listInventory, adjustInventory } from "../src/server/orders/inventory.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function makeUser(name = "User") {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

/**
 * Owner (+ optional operator) business with orders solution active.
 */
async function fixture({ withOperator = false, name = "Orders V2 Shop" } = {}) {
  const uid = await makeUser("Owner");
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name,
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: b.id,
      user_id: uid,
      role: "owner",
      status: "active",
    })
    .execute();
  await db
    .insertInto("business_solution")
    .values({
      business_id: b.id,
      solution_code: "orders",
      status: "active",
    })
    .execute();

  let operatorUid = null;
  if (withOperator) {
    operatorUid = await makeUser("Operator");
    await db
      .insertInto("business_member")
      .values({
        business_id: b.id,
        user_id: operatorUid,
        role: "operator",
        status: "active",
      })
      .execute();
  }

  return {
    uid,
    operatorUid,
    b,
    publicId: b.public_id,
    catalog: new CatalogService(db),
    orders: new OrderService(db),
  };
}

function filters(patch = {}) {
  return {
    search: "",
    status: "",
    source: "",
    fulfillment: "",
    date: "",
    assignedUserId: "",
    limit: 50,
    ...patch,
  };
}

function checkoutBody(overrides = {}) {
  return {
    platform: "web",
    external_user_id: "buyer-" + randomUUID().slice(0, 8),
    customer_name: "Иван",
    customer_phone: "+79991234567",
    fulfillment: "pickup",
    request_key: "rk-" + randomUUID(),
    ...overrides,
  };
}

async function product(
  f,
  {
    name = "Товар",
    price = "100",
    currency = "RUB",
    stock = null,
    track = false,
    type = "product",
    active = true,
    variants = null,
  } = {},
) {
  const body = {
    name,
    price,
    currency,
    active,
    product_type: type,
    track_inventory: track || stock != null,
    availability: stock != null ? "quantity" : "in_stock",
    stock_quantity: stock,
  };
  if (variants) {
    body.use_variants = true;
    body.variants = variants;
  }
  return f.catalog.saveProduct(f.uid, f.publicId, body);
}

test("orders v2: summary counts new and inProgress", async () => {
  const f = await fixture();
  const p = await product(f, { name: "KPI", price: "200" });
  const a = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  const b = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000002",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await f.orders.transitionStatus(f.uid, f.publicId, b.id, {
    status: "accepted",
  });
  const summary = await getOrderSummary(db, f.uid, f.publicId);
  assert.equal(summary.newCount, 1);
  assert.equal(summary.inProgressCount, 1);
  assert.equal(summary.timezone, "Europe/Moscow");
  void a;
});

test("orders v2: today filter uses Europe/Moscow business timezone", async () => {
  const f = await fixture();
  const p = await product(f, { name: "TZ", price: "150" });
  const today = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  const old = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000003",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  // Far outside Moscow local day window.
  await db
    .updateTable("order")
    .set({ created_at: new Date("2020-01-01T12:00:00.000Z") })
    .where("id", "=", old.id)
    .execute();

  const page = await listOrdersV2(db, f.uid, f.publicId, filters({ date: "today" }));
  assert.ok(page.items.some((o) => o.id === today.id));
  assert.equal(
    page.items.some((o) => o.id === old.id),
    false,
  );
});

test("orders v2: average check and revenue do not mix currencies", async () => {
  const f = await fixture();
  const rub = await product(f, { name: "RUB item", price: "100", currency: "RUB" });
  const usd = await product(f, { name: "USD item", price: "50", currency: "USD" });

  async function complete(orderId) {
    await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
      status: "accepted",
    });
    await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
      status: "assembling",
    });
    await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
      status: "ready",
    });
    await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
      status: "handed_over",
    });
    await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
      status: "completed",
    });
  }

  const o1 = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: rub.id, quantity: 2 }],
    }),
    f.uid,
  );
  const o2 = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000004",
      cart_items: [{ product_id: rub.id, quantity: 1 }],
    }),
    f.uid,
  );
  const o3 = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000005",
      cart_items: [{ product_id: usd.id, quantity: 1 }],
    }),
    f.uid,
  );
  await complete(o1.id);
  await complete(o2.id);
  await complete(o3.id);

  const summary = await getOrderSummary(db, f.uid, f.publicId);
  const rubRev = summary.todayRevenue.find((r) => r.currency === "RUB");
  const usdRev = summary.todayRevenue.find((r) => r.currency === "USD");
  assert.ok(rubRev);
  assert.ok(usdRev);
  assert.equal(Number(rubRev.amount), 300);
  assert.equal(Number(usdRev.amount), 50);

  const rubAvg = summary.averageCheck.find((r) => r.currency === "RUB");
  const usdAvg = summary.averageCheck.find((r) => r.currency === "USD");
  assert.equal(rubAvg.amount, "150.00");
  assert.equal(usdAvg.amount, "50.00");
});

test("orders v2: search by order number, client name, phone normalization", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Searchable", price: "80" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_name: "Анна Поиск",
      customer_phone: "+79991112233",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  assert.ok(order.order_number != null);

  for (const search of [
    String(order.order_number),
    "Анна",
    "+79991112233",
    "89991112233",
    "79991112233",
  ]) {
    const page = await listOrdersV2(
      db,
      f.uid,
      f.publicId,
      filters({ search }),
    );
    assert.ok(
      page.items.some((o) => o.id === order.id),
      `search missed for ${search}`,
    );
  }
});

test("orders v2: status source fulfillment assigned filters", async () => {
  const f = await fixture({ withOperator: true });
  const p = await product(f, { name: "Filter", price: "90" });
  const match = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      platform: "telegram",
      source: "telegram",
      external_user_id: "100200300",
      fulfillment: "delivery",
      delivery_address: "ул. Тест 1",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await f.orders.transitionStatus(f.uid, f.publicId, match.id, {
    status: "accepted",
  });
  await assignOrder(db, f.uid, f.publicId, match.id, f.operatorUid);

  const other = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      platform: "web",
      customer_phone: "+79990000006",
      fulfillment: "pickup",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  void other;

  const page = await listOrdersV2(
    db,
    f.uid,
    f.publicId,
    filters({
      status: "accepted",
      source: "telegram",
      fulfillment: "delivery",
      assignedUserId: f.operatorUid,
    }),
  );
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].id, match.id);

  const unassigned = await listOrdersV2(
    db,
    f.uid,
    f.publicId,
    filters({ assignedUserId: "none" }),
  );
  assert.ok(unassigned.items.every((o) => o.assignedUser == null));
  assert.ok(unassigned.items.some((o) => o.id === other.id));
});

test("orders v2: cursor pagination is stable without duplicates", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Page", price: "10" });
  const stamp = new Date("2024-06-01T12:00:00.000Z");
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const order = await f.orders.checkout(
      f.b.id,
      checkoutBody({
        customer_phone: `+79990001${String(i).padStart(3, "0")}`,
        cart_items: [{ product_id: p.id, quantity: 1 }],
      }),
      f.uid,
    );
    ids.push(order.id);
    await db
      .updateTable("order")
      .set({ created_at: stamp })
      .where("id", "=", order.id)
      .execute();
  }

  const page1 = await listOrdersV2(
    db,
    f.uid,
    f.publicId,
    filters({ limit: 2 }),
  );
  assert.equal(page1.items.length, 2);
  assert.ok(page1.hasMore);
  assert.ok(page1.nextCursor);

  const page2 = await listOrdersV2(
    db,
    f.uid,
    f.publicId,
    filters({ limit: 2, cursor: page1.nextCursor }),
  );
  assert.equal(page2.items.length, 2);
  const page3 = await listOrdersV2(
    db,
    f.uid,
    f.publicId,
    filters({ limit: 2, cursor: page2.nextCursor }),
  );
  assert.equal(page3.items.length, 1);

  const all = [...page1.items, ...page2.items, ...page3.items].map((o) => o.id);
  assert.equal(new Set(all).size, 5);
  assert.deepEqual(new Set(all), new Set(ids));
});

test("orders v2: manual multi-item cart_items checkout", async () => {
  const f = await fixture();
  const a = await product(f, { name: "A", price: "100" });
  const b = await product(f, { name: "B", price: "250" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [
        { product_id: a.id, quantity: 2 },
        { product_id: b.id, quantity: 1 },
      ],
    }),
    f.uid,
  );
  assert.equal(order.total, "450.00");
  const detail = await f.orders.get(f.uid, f.publicId, order.id);
  assert.equal(detail.items.length, 2);
});

test("orders v2: existing client_id reused without duplicate client", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Reuse", price: "40" });
  const clientId = randomUUID();
  await db
    .insertInto("client")
    .values({
      id: clientId,
      business_id: f.b.id,
      name: "Существующий",
      phone: "+79995554433",
      first_seen_at: new Date(),
      last_seen_at: new Date(),
    })
    .execute();

  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      client_id: clientId,
      customer_name: "Ignored",
      customer_phone: "+79990000000",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  assert.equal(order.client_id, clientId);
  assert.equal(order.customer_name, "Существующий");

  const clients = await db
    .selectFrom("client")
    .select("id")
    .where("business_id", "=", f.b.id)
    .execute();
  assert.equal(clients.length, 1);
});

test("orders v2: idempotent request_key", async () => {
  const f = await fixture();
  const p = await product(f, {
    name: "Idem",
    price: "55",
    track: true,
    stock: 5,
  });
  const key = "idem-v2-" + randomUUID();
  const body = checkoutBody({
    request_key: key,
    cart_items: [{ product_id: p.id, quantity: 1 }],
  });
  const first = await f.orders.checkout(f.b.id, body, f.uid);
  const second = await f.orders.checkout(f.b.id, body, f.uid);
  assert.equal(first.id, second.id);
  const stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  assert.equal(stock.stock_quantity, 4);
});

test("orders v2: tenant isolation on list and detail", async () => {
  const a = await fixture({ name: "A" });
  const other = await fixture({ name: "B" });
  const p = await product(a, { name: "Secret", price: "10" });
  const order = await a.orders.checkout(
    a.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    a.uid,
  );
  const list = await listOrdersV2(
    db,
    other.uid,
    other.publicId,
    filters({ limit: 50 }),
  );
  assert.equal(
    list.items.some((o) => o.id === order.id),
    false,
  );
  await assert.rejects(
    () => other.orders.get(other.uid, other.publicId, order.id),
    (e) => e.code === "ORDER_NOT_FOUND",
  );
  await assert.rejects(
    () => a.orders.get(other.uid, a.publicId, order.id),
    (e) => e.code === "BUSINESS_NOT_FOUND" || e.code === "FORBIDDEN",
  );
});

test("orders v2: operator claim / cannot steal / admin reassign", async () => {
  const f = await fixture({ withOperator: true });
  const op2 = await makeUser("Operator2");
  await db
    .insertInto("business_member")
    .values({
      business_id: f.b.id,
      user_id: op2,
      role: "operator",
      status: "active",
    })
    .execute();

  const p = await product(f, { name: "Assign", price: "70" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );

  const claimed = await claimOrder(db, f.operatorUid, f.publicId, order.id);
  assert.equal(claimed.assignedUser.id, f.operatorUid);

  await assert.rejects(
    () => claimOrder(db, op2, f.publicId, order.id),
    (e) => e.code === "FORBIDDEN" && e.status === 403,
  );

  const reassigned = await assignOrder(
    db,
    f.uid,
    f.publicId,
    order.id,
    op2,
  );
  assert.equal(reassigned.assignedUser.id, op2);
});

test("orders v2: status transition valid and invalid", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Status", price: "120" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "accepted",
  });
  await assert.rejects(
    () =>
      f.orders.transitionStatus(f.uid, f.publicId, order.id, {
        status: "completed",
      }),
    (e) => e.code === "INVALID_STATUS_TRANSITION",
  );
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "assembling",
  });
  const detail = await f.orders.get(f.uid, f.publicId, order.id);
  assert.equal(detail.status, "assembling");
});

test("orders v2: stock decrement and concurrent checkout never negative", async () => {
  const f = await fixture();
  const p = await product(f, {
    name: "Race",
    price: "30",
    track: true,
    stock: 1,
  });
  const results = await Promise.allSettled([
    f.orders.checkout(
      f.b.id,
      checkoutBody({
        external_user_id: "race-a",
        cart_items: [{ product_id: p.id, quantity: 1 }],
      }),
      f.uid,
    ),
    f.orders.checkout(
      f.b.id,
      checkoutBody({
        external_user_id: "race-b",
        cart_items: [{ product_id: p.id, quantity: 1 }],
      }),
      f.uid,
    ),
  ]);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.ok(fulfilled.length >= 1);
  if (rejected.length) {
    assert.equal(rejected[0].reason.code, "OUT_OF_STOCK");
  }
  const stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  assert.ok((stock.stock_quantity ?? 0) >= 0);
  assert.equal(stock.stock_quantity, 0);
});

test("orders v2: cancel restores stock once; double cancel safe", async () => {
  const f = await fixture();
  const p = await product(f, {
    name: "Cancel",
    price: "60",
    track: true,
    stock: 3,
  });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 2 }],
    }),
    f.uid,
  );
  let stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  assert.equal(stock.stock_quantity, 1);

  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "cancelled",
  });
  stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  assert.equal(stock.stock_quantity, 3);

  // Second cancel from cancelled is invalid transition — stock stays restored.
  await assert.rejects(
    () =>
      f.orders.transitionStatus(f.uid, f.publicId, order.id, {
        status: "cancelled",
      }),
    (e) => e.code === "INVALID_STATUS_TRANSITION",
  );
  stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", p.id)
    .executeTakeFirstOrThrow();
  assert.equal(stock.stock_quantity, 3);

  const after = await db
    .selectFrom("order")
    .select(["status", "inventory_restored_at"])
    .where("id", "=", order.id)
    .executeTakeFirstOrThrow();
  assert.equal(after.status, "cancelled");
  assert.ok(after.inventory_restored_at);
});

test("orders v2: delivery price, free_delivery_from, minimum_order_amount", async () => {
  const f = await fixture();
  await saveOrderSettingsV2(db, f.uid, f.publicId, {
    deliveryEnabled: true,
    pickupEnabled: true,
    deliveryPrice: "200",
    freeDeliveryFrom: "1000",
    minimumOrderAmount: "300",
  });

  assert.equal(
    calculateDeliveryFee(
      {
        pickup_enabled: true,
        delivery_enabled: true,
        delivery_price: "200.00",
        free_delivery_from: "1000.00",
      },
      "delivery",
      500,
    ),
    200,
  );
  assert.equal(
    calculateDeliveryFee(
      {
        pickup_enabled: true,
        delivery_enabled: true,
        delivery_price: "200.00",
        free_delivery_from: "1000.00",
      },
      "delivery",
      1000,
    ),
    0,
  );
  assert.equal(
    calculateDeliveryFee(
      {
        pickup_enabled: true,
        delivery_enabled: true,
        delivery_price: "200.00",
        free_delivery_from: "1000.00",
      },
      "pickup",
      500,
    ),
    0,
  );

  const cheap = await product(f, { name: "Cheap", price: "100" });
  await assert.rejects(
    () =>
      f.orders.checkout(
        f.b.id,
        checkoutBody({
          cart_items: [{ product_id: cheap.id, quantity: 1 }],
        }),
        f.uid,
      ),
    (e) => e.code === "MINIMUM_ORDER",
  );

  const pricey = await product(f, { name: "Pricey", price: "600" });
  const paid = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      fulfillment: "delivery",
      delivery_address: "Москва",
      cart_items: [{ product_id: pricey.id, quantity: 1 }],
    }),
    f.uid,
  );
  assert.equal(paid.delivery_fee, "200.00");
  assert.equal(paid.total, "800.00");

  const free = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000007",
      fulfillment: "delivery",
      delivery_address: "Москва",
      cart_items: [{ product_id: pricey.id, quantity: 2 }],
    }),
    f.uid,
  );
  assert.equal(free.delivery_fee, "0.00");
  assert.equal(free.total, "1200.00");
});

test("orders v2: pickup-only and delivery-only settings enforce fulfillment", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Fulfill", price: "400" });

  await saveOrderSettingsV2(db, f.uid, f.publicId, {
    pickupEnabled: true,
    deliveryEnabled: false,
  });
  await assert.rejects(
    () =>
      f.orders.checkout(
        f.b.id,
        checkoutBody({
          fulfillment: "delivery",
          delivery_address: "x",
          cart_items: [{ product_id: p.id, quantity: 1 }],
        }),
        f.uid,
      ),
    (e) => e.code === "FULFILLMENT_DISABLED",
  );
  const pickup = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      fulfillment: "pickup",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  assert.equal(pickup.fulfillment, "pickup");

  await saveOrderSettingsV2(db, f.uid, f.publicId, {
    pickupEnabled: false,
    deliveryEnabled: true,
    deliveryPrice: "50",
  });
  await assert.rejects(
    () =>
      f.orders.checkout(
        f.b.id,
        checkoutBody({
          customer_phone: "+79990000008",
          fulfillment: "pickup",
          cart_items: [{ product_id: p.id, quantity: 1 }],
        }),
        f.uid,
      ),
    (e) => e.code === "FULFILLMENT_DISABLED",
  );
  const delivery = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      customer_phone: "+79990000009",
      fulfillment: "delivery",
      delivery_address: "Адрес",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  assert.equal(delivery.fulfillment, "delivery");
});

test("orders v2: product_type=service skips stock", async () => {
  const f = await fixture();
  const service = await product(f, {
    name: "Консультация",
    price: "1000",
    type: "service",
    track: true,
    stock: 2,
  });
  const saved = await db
    .selectFrom("product")
    .select(["product_type", "track_inventory", "stock_quantity"])
    .where("id", "=", service.id)
    .executeTakeFirstOrThrow();
  assert.equal(saved.product_type, "service");
  assert.equal(saved.track_inventory, false);

  await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: service.id, quantity: 1 }],
    }),
    f.uid,
  );
  const stock = await db
    .selectFrom("product")
    .select("stock_quantity")
    .where("id", "=", service.id)
    .executeTakeFirstOrThrow();
  // Services do not track inventory; checkout must not invent stock math.
  assert.equal(stock.stock_quantity, saved.stock_quantity);

  const movements = await db
    .selectFrom("inventory_movement")
    .selectAll()
    .where("product_id", "=", service.id)
    .execute();
  assert.equal(movements.length, 0);
});

test("orders v2: variants still work", async () => {
  const f = await fixture();
  const p = await f.catalog.saveProduct(f.uid, f.publicId, {
    name: "Футболка",
    price: "1200",
    use_variants: true,
    track_inventory: true,
    availability: "quantity",
    stock_quantity: 0,
    variants: [
      {
        label: "M",
        availability: "quantity",
        stock_quantity: 4,
        active: true,
      },
    ],
  });
  const detail = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  const variantId = detail.variants[0].id;
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [
        { product_id: p.id, variant_id: variantId, quantity: 1 },
      ],
    }),
    f.uid,
  );
  assert.equal(order.status, "new");
  const after = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(after.variants[0].stock_quantity, 3);
});

test("orders v2: product soft disable blocks checkout", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Disable me", price: "99" });
  await f.catalog.deleteProduct(f.uid, f.publicId, p.id);
  await assert.rejects(
    () =>
      f.orders.checkout(
        f.b.id,
        checkoutBody({
          cart_items: [{ product_id: p.id, quantity: 1 }],
        }),
        f.uid,
      ),
    (e) => e.code === "PRODUCT_UNAVAILABLE",
  );
});

test("orders v2: historical order item name snapshot survives product rename", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Старое имя", price: "75" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await f.catalog.saveProduct(
    f.uid,
    f.publicId,
    { name: "Новое имя", price: "75" },
    p.id,
  );
  const detail = await f.orders.get(f.uid, f.publicId, order.id);
  assert.equal(detail.items[0].name, "Старое имя");
  const renamed = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(renamed.name, "Новое имя");
});

test("orders v2: malformed parseOrderListFilters → 400", () => {
  assert.throws(
    () => parseOrderListFilters(new URLSearchParams("status=nope")),
    (e) => e.status === 400 && e.code === "INVALID_FILTER",
  );
  assert.throws(
    () => parseOrderListFilters(new URLSearchParams("limit=0")),
    (e) => e.status === 400 && e.code === "INVALID_FILTER",
  );
  assert.throws(
    () => parseOrderListFilters(new URLSearchParams("cursor=!!!")),
    (e) => e.status === 400 && e.code === "INVALID_CURSOR",
  );
});

test("orders v2: inventory adjust records movement", async () => {
  const f = await fixture();
  const p = await product(f, {
    name: "Stocked",
    price: "20",
    track: true,
    stock: 5,
  });
  const result = await adjustInventory(db, f.uid, f.publicId, {
    productId: p.id,
    delta: 3,
  });
  assert.equal(result.stockQuantity, 8);
  assert.equal(result.delta, 3);

  const inv = await listInventory(db, f.uid, f.publicId);
  const row = inv.items.find((i) => i.productId === p.id);
  assert.ok(row);
  assert.equal(row.stockQuantity, 8);

  const movement = await db
    .selectFrom("inventory_movement")
    .selectAll()
    .where("business_id", "=", f.b.id)
    .where("product_id", "=", p.id)
    .where("reason", "=", "manual_adjustment")
    .executeTakeFirst();
  assert.ok(movement);
  assert.equal(movement.delta, 3);
  assert.equal(movement.remaining, 8);
  assert.equal(movement.actor_user_id, f.uid);
});

test("orders v2: settings save owner-only (operator 403)", async () => {
  const f = await fixture({ withOperator: true });
  const ok = await saveOrderSettingsV2(db, f.uid, f.publicId, {
    deliveryPrice: "150",
  });
  assert.equal(ok.deliveryPrice, "150.00");

  const got = await getOrderSettingsV2(db, f.operatorUid, f.publicId);
  assert.equal(got.deliveryPrice, "150.00");

  await assert.rejects(
    () =>
      saveOrderSettingsV2(db, f.operatorUid, f.publicId, {
        deliveryPrice: "1",
      }),
    (e) => e.code === "FORBIDDEN" && e.status === 403,
  );
});

async function advanceToReady(f, orderId) {
  await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
    status: "accepted",
  });
  await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
    status: "assembling",
  });
  await f.orders.transitionStatus(f.uid, f.publicId, orderId, {
    status: "ready",
  });
}

test("orders v2: pickup ready → delivered is 409", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Pickup item", price: "50" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      fulfillment: "pickup",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await advanceToReady(f, order.id);
  const detail = await f.orders.get(f.uid, f.publicId, order.id);
  assert.deepEqual(detail.next_statuses, ["handed_over", "cancelled"]);
  await assert.rejects(
    () =>
      f.orders.transitionStatus(f.uid, f.publicId, order.id, {
        status: "delivered",
      }),
    (e) => e.status === 409 && e.code === "INVALID_STATUS_TRANSITION",
  );
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "handed_over",
  });
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "completed",
  });
});

test("orders v2: delivery ready → handed_over is 409", async () => {
  const f = await fixture();
  const p = await product(f, { name: "Delivery item", price: "50" });
  const order = await f.orders.checkout(
    f.b.id,
    checkoutBody({
      fulfillment: "delivery",
      delivery_address: "ул. Тест 2",
      cart_items: [{ product_id: p.id, quantity: 1 }],
    }),
    f.uid,
  );
  await advanceToReady(f, order.id);
  const detail = await f.orders.get(f.uid, f.publicId, order.id);
  assert.deepEqual(detail.next_statuses, ["delivered", "cancelled"]);
  await assert.rejects(
    () =>
      f.orders.transitionStatus(f.uid, f.publicId, order.id, {
        status: "handed_over",
      }),
    (e) => e.status === 409 && e.code === "INVALID_STATUS_TRANSITION",
  );
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "delivered",
  });
  await f.orders.transitionStatus(f.uid, f.publicId, order.id, {
    status: "completed",
  });
});

test("orders v2: variant adjust enables track_inventory and checkout deducts", async () => {
  const f = await fixture();
  const p = await f.catalog.saveProduct(f.uid, f.publicId, {
    name: "Variant stock bug",
    price: "300",
    use_variants: true,
    track_inventory: false,
    availability: "in_stock",
    variants: [
      {
        label: "L",
        availability: "in_stock",
        stock_quantity: null,
        active: true,
      },
    ],
  });
  const detail = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(detail.track_inventory, false);
  const variantId = detail.variants[0].id;

  await adjustInventory(db, f.uid, f.publicId, {
    productId: p.id,
    variantId,
    quantity: 5,
  });

  const afterAdjust = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(afterAdjust.track_inventory, true);
  assert.equal(afterAdjust.variants[0].stock_quantity, 5);

  await f.orders.checkout(
    f.b.id,
    checkoutBody({
      cart_items: [{ product_id: p.id, variant_id: variantId, quantity: 2 }],
    }),
    f.uid,
  );

  const afterCheckout = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(afterCheckout.variants[0].stock_quantity, 3);
});

test("orders v2: inventory adjust rejects mismatched variant / service", async () => {
  const f = await fixture();
  const plain = await product(f, { name: "Plain", price: "10", stock: 2 });
  const service = await product(f, {
    name: "Svc",
    price: "10",
    type: "service",
  });
  const withVariants = await f.catalog.saveProduct(f.uid, f.publicId, {
    name: "With vars",
    price: "20",
    use_variants: true,
    track_inventory: true,
    variants: [
      { label: "A", availability: "quantity", stock_quantity: 1, active: true },
      {
        label: "B",
        availability: "quantity",
        stock_quantity: 1,
        active: false,
      },
    ],
  });
  const detail = await f.catalog.getProduct(f.uid, f.publicId, withVariants.id);
  const activeVar = detail.variants.find((v) => v.active)?.id;
  const inactiveVar = detail.variants.find((v) => !v.active)?.id;
  assert.ok(activeVar);
  assert.ok(inactiveVar);

  await assert.rejects(
    () =>
      adjustInventory(db, f.uid, f.publicId, {
        productId: withVariants.id,
        quantity: 3,
      }),
    (e) => e.code === "INVALID_STOCK",
  );
  await assert.rejects(
    () =>
      adjustInventory(db, f.uid, f.publicId, {
        productId: plain.id,
        variantId: activeVar,
        quantity: 1,
      }),
    (e) => e.code === "INVALID_STOCK" || e.code === "VARIANT_NOT_FOUND",
  );
  await assert.rejects(
    () =>
      adjustInventory(db, f.uid, f.publicId, {
        productId: withVariants.id,
        variantId: inactiveVar,
        quantity: 2,
      }),
    (e) => e.code === "INVALID_STOCK",
  );
  await assert.rejects(
    () =>
      adjustInventory(db, f.uid, f.publicId, {
        productId: service.id,
        quantity: 1,
      }),
    (e) => e.code === "INVALID_STOCK",
  );
});

test("orders v2: inventory state filter rejects unknown values", async () => {
  const f = await fixture();
  await assert.rejects(
    () => listInventory(db, f.uid, f.publicId, { state: "hacked" }),
    (e) => e.status === 400 && e.code === "INVALID_FILTER",
  );
  const ok = await listInventory(db, f.uid, f.publicId, { state: "in_stock" });
  assert.ok(Array.isArray(ok.items));
});

test("orders v2: settings reject string booleans", async () => {
  const f = await fixture();
  await assert.rejects(
    () =>
      saveOrderSettingsV2(db, f.uid, f.publicId, {
        pickupEnabled: "false",
      }),
    (e) => e.status === 400 && e.code === "INVALID_SETTINGS",
  );
  await assert.rejects(
    () =>
      saveOrderSettingsV2(db, f.uid, f.publicId, {
        deliveryEnabled: "true",
      }),
    (e) => e.status === 400 && e.code === "INVALID_SETTINGS",
  );
  const ok = await saveOrderSettingsV2(db, f.uid, f.publicId, {
    pickupEnabled: true,
    deliveryEnabled: false,
  });
  assert.equal(ok.pickupEnabled, true);
  assert.equal(ok.deliveryEnabled, false);
});

test("orders v2: channelDisplayStatus distinguishes runtime", async () => {
  const { channelDisplayStatus, isChannelRuntimeReady } = await import(
    "../src/lib/ordersChannelStatus.ts"
  );
  assert.equal(channelDisplayStatus(undefined).label, "Не подключено");
  assert.equal(channelDisplayStatus({ status: "disconnected" }).ready, false);

  const pending = channelDisplayStatus({
    status: "connected",
    runtimeStatus: "pending",
  });
  assert.equal(pending.label, "Подключено, не запущено");
  assert.equal(pending.ready, false);
  assert.match(pending.cta, /Запустить|Настроить/);

  const nullRuntime = channelDisplayStatus({
    status: "connected",
    runtimeStatus: null,
  });
  assert.equal(nullRuntime.label, "Подключено, не запущено");
  assert.equal(nullRuntime.ready, false);

  const errored = channelDisplayStatus({
    status: "connected",
    runtimeStatus: "error",
  });
  assert.equal(errored.label, "Ошибка запуска");
  assert.equal(errored.ready, false);

  const ready = channelDisplayStatus({
    status: "connected",
    runtimeStatus: "ready",
  });
  assert.equal(ready.label, "Работает");
  assert.equal(ready.ready, true);
  assert.equal(isChannelRuntimeReady({ status: "connected", runtimeStatus: "ready" }), true);
  assert.equal(
    isChannelRuntimeReady({ status: "connected", runtimeStatus: "pending" }),
    false,
  );
});

test("orders v2: low_stock_threshold create/edit + inventory low state", async () => {
  const f = await fixture();
  const p = await f.catalog.saveProduct(f.uid, f.publicId, {
    name: "Threshold tea",
    price: "40",
    track_inventory: true,
    availability: "quantity",
    stock_quantity: 5,
    low_stock_threshold: 3,
  });
  let detail = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(detail.low_stock_threshold, 3);

  await f.catalog.saveProduct(
    f.uid,
    f.publicId,
    {
      name: "Threshold tea",
      price: "40",
      track_inventory: true,
      availability: "quantity",
      stock_quantity: 2,
      low_stock_threshold: 3,
    },
    p.id,
  );
  detail = await f.catalog.getProduct(f.uid, f.publicId, p.id);
  assert.equal(detail.stock_quantity, 2);
  assert.equal(detail.low_stock_threshold, 3);

  const inv = await listInventory(db, f.uid, f.publicId, { state: "low" });
  assert.ok(inv.items.some((i) => i.productId === p.id && i.state === "low"));
});
