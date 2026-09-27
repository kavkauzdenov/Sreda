/**
 * Orders V2 UI audit — real flows (not dialog open/close only).
 * Prefer AUDIT_STORAGE_STATE (UI gate register → recovery → business).
 * Must not skip when the CI isolated app is healthy.
 */
import { test, expect } from "playwright/test";
import fs from "fs";
import path from "path";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

const storageStatePath = process.env.AUDIT_STORAGE_STATE || "";
const hasStorage =
  Boolean(storageStatePath) && fs.existsSync(storageStatePath);

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

const outDir =
  process.env.E2E_SCREENSHOT_DIR ||
  process.env.AUDIT_OUTPUT ||
  "artifacts/orders-v2-ui-audit";

function isNetworkUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /NETWORK_UNAVAILABLE|ERR_CONNECTION_REFUSED|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(
    message,
  );
}

async function bodyOverflowX(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return (
      doc.scrollWidth > doc.clientWidth + 1 ||
      (body != null && body.scrollWidth > body.clientWidth + 1)
    );
  });
}

async function expectNoBodyOverflow(page, label = "") {
  const overflow = await bodyOverflowX(page);
  expect(overflow, `body horizontal overflow${label ? ` at ${label}` : ""}`).toBe(
    false,
  );
}

async function minTouchTarget(page, scope = ".orders-page") {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel) || document.body;
    let min = Infinity;
    for (const el of root.querySelectorAll(
      "button, .button, a.button, [role='button']",
    )) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (style.opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      min = Math.min(min, Math.min(r.width, r.height));
    }
    return min === Infinity ? 0 : min;
  }, scope);
}

/** Same register/recovery/business flow as verify.yml auth storage step. */
async function registerAndBusiness(page) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const user = `ordv2${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026ord";
  const res = await page.goto(baseURL + "/register", {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: register ${res?.status()}`);
  }
  await page.locator("#account-login").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.locator("#account-login").click();
  await page.locator("#account-login").pressSequentially(user, { delay: 15 });
  await page.locator("#account-password").fill(pass);
  await page.locator("#account-confirmation").fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();

  const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
  await checkbox.waitFor({ state: "attached", timeout: 45_000 });
  await page.locator("label.recovery-confirm").click();
  await page.getByRole("button", { name: /продолжить/i }).click();
  await page.waitForFunction(
    () => !location.pathname.includes("/register"),
    null,
    { timeout: 45_000 },
  );

  if (page.url().includes("business/new")) {
    const name = page.locator("#business-name");
    await name.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800);
    await name.click();
    await name.fill("");
    await name.pressSequentially(`Orders V2 ${suffix}`, { delay: 15 });
    const createPromise = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/businesses") &&
        r.request().method() === "POST",
      { timeout: 60_000 },
    );
    await page.getByRole("button", { name: /создать пространство/i }).click();
    const createRes = await createPromise.catch(() => null);
    if (createRes && !createRes.ok()) {
      throw new Error(
        `PRODUCT_REGRESSION: create business HTTP ${createRes.status()}`,
      );
    }
    await page.waitForFunction(
      () => !location.pathname.includes("/business/new"),
      null,
      { timeout: 60_000 },
    );
  }
}

async function ensureAuthed(page) {
  if (hasStorage) return;
  await registerAndBusiness(page);
}

async function ensureOrdersSolution(page) {
  await page.evaluate(async () => {
    try {
      const me = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(me) ? me[0] : me?.[0];
      const id = biz?.id || biz?.public_id;
      if (!id) return;
      await fetch(`/api/v1/businesses/${encodeURIComponent(id)}/solutions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "orders", enabled: true }),
      });
    } catch {
      /* best-effort */
    }
  });
}

async function openOrders(page) {
  const res = await page.goto(baseURL + "/orders", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: orders ${res?.status()}`);
  }
  await ensureOrdersSolution(page);
  await page.goto(baseURL + "/orders", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(page.locator("h1")).toContainText(/Приём заказов|Заказы/i, {
    timeout: 30_000,
  });
}

async function boot(page) {
  try {
    await ensureAuthed(page);
    await openOrders(page);
  } catch (error) {
    if (isNetworkUnavailable(error)) {
      test.skip(true, String(error));
      return false;
    }
    throw error;
  }
  return true;
}

async function openTab(page, name) {
  const tab = page.getByRole("navigation", { name: /разделы заказов/i }).getByRole(
    "button",
    { name },
  );
  await expect(tab).toBeVisible({ timeout: 15_000 });
  await tab.click();
}

async function seedBiz(page) {
  return page.evaluate(async () => {
    const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
    const biz = Array.isArray(businesses) ? businesses[0] : null;
    const businessId = biz?.id;
    if (!businessId) return { error: "no-business" };
    await fetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/solutions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "orders", enabled: true }),
    });
    await fetch(
      `/api/v1/businesses/${encodeURIComponent(businessId)}/orders?view=settings`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          pickupEnabled: true,
          deliveryEnabled: true,
          deliveryPrice: "150",
          freeDeliveryFrom: "5000",
          minimumOrderAmount: null,
        }),
      },
    );
    return { businessId };
  });
}

test.describe("Orders V2 UI audit", () => {
  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  if (hasStorage) {
    test.use({ storageState: storageStatePath });
  }

  test("workspace loads + responsive", async ({ page, browserName }) => {
    test.setTimeout(120_000);
    if (!(await boot(page))) return;

    await expect(page.locator(".orders-page")).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: /разделы заказов/i }),
    ).toBeVisible();

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100);
      await expectNoBodyOverflow(page, `${vp.width}x${vp.height}`);
      await page.screenshot({
        path: path.join(
          outDir,
          `orders_${vp.width}_${browserName}_light.png`,
        ),
        fullPage: false,
      });
      expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("filters and search", async ({ page, browserName }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    const search = page.getByPlaceholder(/номер, имя или телефон/i);
    await expect(search).toBeVisible();
    await search.fill("тест");
    await page.waitForTimeout(400);
    await expect(
      page.getByRole("region", { name: /список заказов|фильтры заказов/i }).first(),
    ).toBeVisible();

    const toggle = page.getByRole("button", { name: /фильтр/i }).first();
    if (await toggle.isVisible().catch(() => false)) {
      await toggle.click();
    }

    await page.screenshot({
      path: path.join(outDir, `orders_filters_${browserName}.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "filters");
  });

  test("pickup pipeline + cancel confirmation", async ({ page, browserName }) => {
    test.setTimeout(150_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });

    const seeded = await page.evaluate(async () => {
      const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(businesses) ? businesses[0] : null;
      const businessId = biz?.id;
      if (!businessId) return { error: "no-business" };
      await fetch(`/api/v1/businesses/${encodeURIComponent(businessId)}/solutions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "orders", enabled: true }),
      });
      const productRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/products`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "E2E Pickup",
            price: "199",
            availability: "in_stock",
          }),
        },
      );
      if (!productRes.ok) return { error: `product ${productRes.status}` };
      const product = await productRes.json();
      const orderRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            platform: "web",
            customer_name: "E2E Pickup Client",
            customer_phone: "+79998887701",
            fulfillment: "pickup",
            request_key: `e2e-pick-${Date.now()}`,
            cart_items: [{ product_id: product.id, quantity: 1 }],
          }),
        },
      );
      if (!orderRes.ok) return { error: `order ${orderRes.status}` };
      const order = await orderRes.json();
      for (const status of ["accepted", "assembling", "ready"]) {
        const patch = await fetch(
          `/api/v1/businesses/${encodeURIComponent(businessId)}/orders/${order.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status }),
          },
        );
        if (!patch.ok) return { error: `patch ${status} ${patch.status}` };
      }
      return { businessId, orderId: order.id, orderNumber: order.order_number };
    });

    expect(seeded.error, JSON.stringify(seeded)).toBeUndefined();
    await page.goto(
      baseURL + `/orders?order=${encodeURIComponent(seeded.orderId)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );

    await expect(
      page.getByRole("button", { name: /перевести в «выдан»/i }).first(),
    ).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByRole("button", { name: /^доставлен$/i }),
    ).toHaveCount(0);

    const cancelBtn = page.getByRole("button", { name: /^отменить$/i }).first();
    await cancelBtn.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/отменить заказ/i);
    await expect(confirm).toContainText(/остатки будут возвращены/i);
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0, { timeout: 10_000 });

    await cancelBtn.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    const patchPromise = page.waitForResponse(
      (r) =>
        r.request().method() === "PATCH" &&
        r.url().includes(`/orders/${seeded.orderId}`),
      { timeout: 30_000 },
    );
    await page.getByRole("button", { name: /отменить заказ/i }).click();
    const patchRes = await patchPromise;
    expect(patchRes.ok()).toBeTruthy();
    await expect(page.getByText(/заказ отменён/i).first()).toBeVisible({
      timeout: 15_000,
    });

    await page.screenshot({
      path: path.join(outDir, `orders_pickup_cancel_${browserName}.png`),
      fullPage: false,
    });
  });

  test("delivery pipeline shows delivered only", async ({ page, browserName }) => {
    test.setTimeout(150_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });

    const seeded = await page.evaluate(async () => {
      const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(businesses) ? businesses[0] : null;
      const businessId = biz?.id;
      if (!businessId) return { error: "no-business" };
      const productRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/products`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "E2E Delivery",
            price: "250",
            availability: "in_stock",
          }),
        },
      );
      if (!productRes.ok) return { error: `product ${productRes.status}` };
      const product = await productRes.json();
      const orderRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            platform: "web",
            customer_name: "E2E Delivery Client",
            customer_phone: "+79998887702",
            fulfillment: "delivery",
            delivery_address: "Тестовая 1",
            request_key: `e2e-del-${Date.now()}`,
            cart_items: [{ product_id: product.id, quantity: 1 }],
          }),
        },
      );
      if (!orderRes.ok) return { error: `order ${orderRes.status}` };
      const order = await orderRes.json();
      for (const status of ["accepted", "assembling", "ready"]) {
        await fetch(
          `/api/v1/businesses/${encodeURIComponent(businessId)}/orders/${order.id}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status }),
          },
        );
      }
      return { orderId: order.id };
    });

    expect(seeded.error, JSON.stringify(seeded)).toBeUndefined();
    await page.goto(
      baseURL + `/orders?order=${encodeURIComponent(seeded.orderId)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await expect(
      page.getByRole("button", { name: /перевести в «доставлен»/i }).first(),
    ).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByRole("button", { name: /^выдан$/i }),
    ).toHaveCount(0);

    await page.screenshot({
      path: path.join(outDir, `orders_delivery_pipeline_${browserName}.png`),
      fullPage: false,
    });
  });

  test("manual multi-item order with totals", async ({ page, browserName }) => {
    test.setTimeout(180_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });

    const seeded = await page.evaluate(async () => {
      const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(businesses) ? businesses[0] : null;
      const businessId = biz?.id;
      if (!businessId) return { error: "no-business" };
      await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders?view=settings`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            pickupEnabled: true,
            deliveryEnabled: true,
            deliveryPrice: "100",
            freeDeliveryFrom: null,
          }),
        },
      );
      const names = ["E2E Multi A", "E2E Multi B"];
      const products = [];
      for (const name of names) {
        const res = await fetch(
          `/api/v1/businesses/${encodeURIComponent(businessId)}/products`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name,
              price: name.endsWith("A") ? "100" : "200",
              availability: "in_stock",
              active: true,
            }),
          },
        );
        if (!res.ok) return { error: `product ${res.status}` };
        products.push(await res.json());
      }
      return { businessId, products };
    });
    expect(seeded.error, JSON.stringify(seeded)).toBeUndefined();

    await page.goto(baseURL + "/orders", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.getByRole("button", { name: /создать заказ/i }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await dialog.getByRole("button", { name: /^новый$/i }).click();
    await dialog.getByRole("textbox", { name: /имя/i }).fill("Multi Client");
    await dialog.getByRole("textbox", { name: /телефон/i }).fill("+79991112233");

    const cartSection = dialog.locator("fieldset").filter({ hasText: /^Корзина/ });
    for (const p of seeded.products) {
      await cartSection.locator("select").first().selectOption({ label: new RegExp(p.name) });
      await dialog.getByRole("button", { name: /добавить в заказ/i }).click();
      await expect(dialog.getByText(p.name).first()).toBeVisible();
    }

    await expect(dialog.getByRole("region", { name: /итоги заказа/i })).toBeVisible();
    await expect(dialog.getByText(/^Подытог$/)).toBeVisible();
    await expect(dialog.getByText(/^Доставка$/)).toBeVisible();
    await expect(dialog.getByText(/^Итого$/)).toBeVisible();

    const createPromise = page.waitForResponse(
      (r) => {
        if (r.request().method() !== "POST") return false;
        try {
          const u = new URL(r.url());
          return /\/api\/v1\/businesses\/[^/]+\/orders$/.test(u.pathname);
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    await dialog.getByRole("button", { name: /^создать заказ$/i }).click();
    const createRes = await createPromise;
    expect(createRes.ok()).toBeTruthy();
    const created = await createRes.json();
    expect(created.id).toBeTruthy();

    await expect(page.getByText(/E2E Multi A/i).first()).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByText(/E2E Multi B/i).first()).toBeVisible();
    // Detail should list both line items.
    await expect(page.locator(".crm-list li").filter({ hasText: /E2E Multi/ })).toHaveCount(2);
    await page.screenshot({
      path: path.join(outDir, `orders_manual_multi_${browserName}.png`),
      fullPage: false,
    });
  });

  test("catalog product creation + filters + image placeholder", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(180_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await openTab(page, /каталог/i);
    await expect(page.getByRole("region", { name: /каталог/i })).toBeVisible({
      timeout: 20_000,
    });

    await expect(
      page.getByPlaceholder(/название или sku/i),
    ).toBeVisible();

    const add = page.getByRole("button", { name: /\+ добавить/i });
    await add.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });

    await dialog.getByRole("textbox", { name: /название/i }).fill("E2E Catalog Tea");

    // Wizard: main → images → price → variants → inventory → preview
    for (let i = 0; i < 6; i++) {
      const createBtn = dialog.getByRole("button", {
        name: /^(создать|сохранить)$/i,
      });
      if (await createBtn.isVisible().catch(() => false)) break;
      const price = dialog.getByRole("textbox", { name: /базовая цена/i });
      if (await price.isVisible().catch(() => false)) {
        await price.fill("350");
      }
      const next = dialog.getByRole("button", { name: /^далее$/i });
      if (await next.isVisible().catch(() => false)) {
        await next.click();
        await page.waitForTimeout(150);
      } else break;
    }

    const savePromise = page.waitForResponse(
      (r) =>
        r.url().includes("/products") &&
        (r.request().method() === "POST" || r.request().method() === "PATCH"),
      { timeout: 60_000 },
    );
    await dialog.getByRole("button", { name: /^(создать|сохранить)$/i }).click();
    const res = await savePromise;
    expect(res.ok()).toBeTruthy();

    await expect(page.getByText(/E2E Catalog Tea/i).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("img", { name: /нет фото/i }).first(),
    ).toBeVisible();

    await page.getByPlaceholder(/название или sku/i).fill("Catalog Tea");
    await page.waitForTimeout(300);
    await expect(page.getByText(/E2E Catalog Tea/i).first()).toBeVisible();

    await page.screenshot({
      path: path.join(outDir, `orders_catalog_created_${browserName}.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "catalog");
  });

  test("inventory stock adjustment + low stock", async ({ page, browserName }) => {
    test.setTimeout(150_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });

    const seeded = await page.evaluate(async () => {
      const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(businesses) ? businesses[0] : null;
      const businessId = biz?.id;
      if (!businessId) return { error: "no-business" };
      const productRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/products`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "E2E Stock Item",
            price: "80",
            track_inventory: true,
            availability: "quantity",
            stock_quantity: 8,
            low_stock_threshold: 5,
          }),
        },
      );
      if (!productRes.ok) return { error: `product ${productRes.status}` };
      const product = await productRes.json();
      const adj = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders?view=inventory`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ productId: product.id, quantity: 4 }),
        },
      );
      if (!adj.ok) return { error: `adjust ${adj.status}` };
      const inv = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders?view=inventory&state=low`,
      ).then((r) => r.json());
      return {
        businessId,
        productId: product.id,
        lowHit: (inv.items || []).some((i) => i.productId === product.id),
      };
    });
    expect(seeded.error, JSON.stringify(seeded)).toBeUndefined();
    expect(seeded.lowHit).toBeTruthy();

    await openTab(page, /склад/i);
    await expect(
      page.getByRole("region", { name: "Склад", exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/E2E Stock Item/i).first()).toBeVisible({
      timeout: 20_000,
    });

    await page.screenshot({
      path: path.join(outDir, `orders_inventory_low_${browserName}.png`),
      fullPage: false,
    });
  });

  test("settings save + channel deep links", async ({ page, browserName }) => {
    test.setTimeout(120_000);
    if (!(await boot(page))) return;
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedBiz(page);
    await openTab(page, /настройки/i);
    await expect(page.getByRole("heading", { name: /настройки заказов/i })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/telegram/i).first()).toBeVisible();
    await expect(page.getByText(/^vk$/i).first()).toBeVisible();
    await expect(
      page
        .locator(".orders-channel-status a, .orders-settings a")
        .filter({ hasText: /подключить/i })
        .first(),
    ).toHaveAttribute("href", /connections/);

    const save = page.getByRole("button", { name: /сохранить настройки/i });
    if (await save.isVisible().catch(() => false)) {
      const savePromise = page.waitForResponse(
        (r) =>
          r.url().includes("view=settings") &&
          (r.request().method() === "PATCH" || r.request().method() === "PUT"),
        { timeout: 30_000 },
      );
      await save.click();
      const res = await savePromise;
      expect(res.ok()).toBeTruthy();
      await expect(page.getByText(/настройки сохранены/i)).toBeVisible({
        timeout: 15_000,
      });
    }

    await page.screenshot({
      path: path.join(outDir, `orders_settings_${browserName}.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "settings");
  });

  test("dark theme", async ({ page, browserName }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(100);
    await page.screenshot({
      path: path.join(outDir, `orders_1440_${browserName}_dark.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "dark 1440");
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);
  });

  test("deep links ?tab= and ?order=", async ({ page }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(baseURL + "/orders?tab=catalog", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(page.getByRole("region", { name: /каталог/i })).toBeVisible({
      timeout: 20_000,
    });
    expect(page.url()).toMatch(/tab=catalog/);

    await page.goto(baseURL + "/orders?tab=inventory", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.getByRole("region", { name: "Склад", exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });

    await page.goto(baseURL + "/orders?tab=settings", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await expect(
      page.getByRole("heading", { name: /настройки заказов/i }),
    ).toBeVisible({ timeout: 20_000 });

    await page.goto(
      baseURL + "/orders?order=00000000-0000-4000-8000-000000000099",
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await expect(page.locator(".orders-page")).toBeVisible({ timeout: 20_000 });
    await expectNoBodyOverflow(page, "deep-link");
  });

  test("deep link ?client= opens create with preset", async ({ page }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(
      baseURL + "/orders?client=00000000-0000-4000-8000-000000000088",
      {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      },
    );
    await expect(page.locator(".orders-page")).toBeVisible({ timeout: 20_000 });
    await expectNoBodyOverflow(page, "client deep-link");
  });

  test("mobile viewport detail shell", async ({ page, browserName }) => {
    test.setTimeout(150_000);
    if (!(await boot(page))) return;

    const seeded = await page.evaluate(async () => {
      const businesses = await fetch("/api/v1/businesses").then((r) => r.json());
      const biz = Array.isArray(businesses) ? businesses[0] : null;
      const businessId = biz?.id;
      if (!businessId) return { error: "no-business" };
      const productRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/products`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "E2E Mobile",
            price: "99",
            availability: "in_stock",
          }),
        },
      );
      if (!productRes.ok) return { error: `product ${productRes.status}` };
      const product = await productRes.json();
      const orderRes = await fetch(
        `/api/v1/businesses/${encodeURIComponent(businessId)}/orders`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            platform: "web",
            customer_name: "Mobile Client",
            customer_phone: "+79990001122",
            fulfillment: "pickup",
            request_key: `e2e-mob-${Date.now()}`,
            cart_items: [{ product_id: product.id, quantity: 1 }],
          }),
        },
      );
      if (!orderRes.ok) return { error: `order ${orderRes.status}` };
      const order = await orderRes.json();
      return { orderId: order.id };
    });
    expect(seeded.error, JSON.stringify(seeded)).toBeUndefined();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      baseURL + `/orders?order=${encodeURIComponent(seeded.orderId)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await expect(page.locator(".orders-page")).toBeVisible();
    await expect(
      page.getByRole("dialog").or(page.locator(".client-detail--dialog")),
    ).toBeVisible({ timeout: 25_000 });
    await expectNoBodyOverflow(page, "390 detail");
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);

    await page.screenshot({
      path: path.join(outDir, `orders_mobile_${browserName}.png`),
      fullPage: false,
    });

    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(200);
    await expectNoBodyOverflow(page, "1024");
  });
});
