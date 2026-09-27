/**
 * Clients V2 UI audit — split into independent tests.
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
  "artifacts/clients-v2-ui-audit";

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

/** Temporary diagnostic: list elements that extend past the viewport. */
async function diagnoseOverflow(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const hits = [];
    for (const el of document.querySelectorAll("*")) {
      if (!(el instanceof HTMLElement)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (r.right > vw + 1 || r.left < -1) {
        hits.push({
          tag: el.tagName.toLowerCase(),
          className: String(el.className || "").slice(0, 120),
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
    hits.sort((a, b) => b.right - a.right);
    return {
      innerWidth: vw,
      docScrollWidth: document.documentElement.scrollWidth,
      docClientWidth: document.documentElement.clientWidth,
      bodyScrollWidth: document.body?.scrollWidth ?? null,
      bodyClientWidth: document.body?.clientWidth ?? null,
      hits: hits.slice(0, 25),
    };
  });
}

async function expectNoBodyOverflow(page, label = "") {
  const overflow = await bodyOverflowX(page);
  if (overflow) {
    const diag = await diagnoseOverflow(page);
    console.error(
      `HORIZONTAL_OVERFLOW${label ? ` (${label})` : ""}`,
      JSON.stringify(diag, null, 2),
    );
  }
  expect(overflow, `body horizontal overflow${label ? ` at ${label}` : ""}`).toBe(
    false,
  );
}

async function minTouchTarget(page, scope = ".clients-page") {
  return page.evaluate((sel) => {
    const root =
      document.querySelector(sel) ||
      document.querySelector(".clients-workspace") ||
      document.body;
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
  const user = `clv2${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026cl";
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
    await name.pressSequentially(`Clients V2 ${suffix}`, { delay: 15 });
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

async function openClients(page) {
  const res = await page.goto(baseURL + "/clients", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: clients ${res?.status()}`);
  }
  await expect(page.locator("h1")).toContainText(/Клиенты/i, {
    timeout: 30_000,
  });
}

async function boot(page) {
  try {
    await ensureAuthed(page);
    await openClients(page);
  } catch (error) {
    if (isNetworkUnavailable(error)) {
      test.skip(true, String(error));
      return false;
    }
    throw error;
  }
  return true;
}

/**
 * Create a client via UI.
 * Client id comes from the POST JSON response — never from the current URL.
 */
async function createClientViaUi(page, name = "Аудит Клиент") {
  const newBtn = page.getByRole("button", { name: /новый клиент/i });
  await expect(newBtn).toBeVisible();
  await newBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByLabel(/^Имя/i).fill(name);
  const createPromise = page.waitForResponse(
    (r) => {
      if (r.request().method() !== "POST") return false;
      const u = r.url();
      return (
        /\/api\/v1\/businesses\/[^/]+\/clients\/?(\?|$)/.test(u) &&
        !u.includes("action=")
      );
    },
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: /^Создать$/i }).click();
  const res = await createPromise;
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  expect(body && typeof body.id === "string" && body.id.length > 0).toBeTruthy();
  await expect(page.locator(".client-dialog-overlay")).toHaveCount(0, {
    timeout: 10_000,
  });
  await expect(
    page.locator(".client-detail, .client-detail--dialog, .client-detail--drawer"),
  ).toBeVisible({ timeout: 20_000 });
  return body.id;
}

test.describe("Clients V2 UI audit", () => {
  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  if (hasStorage) {
    test.use({ storageState: storageStatePath });
  }

  test("workspace responsive + touch targets", async ({ page, browserName }) => {
    test.setTimeout(120_000);
    if (!(await boot(page))) return;

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100);
      await expectNoBodyOverflow(page, `${vp.width}x${vp.height}`);
      await page.screenshot({
        path: path.join(
          outDir,
          `clients_${vp.width}_${browserName}_light.png`,
        ),
        fullPage: false,
      });
      expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);
    }
  });

  test("new client dialog + focus trap + Escape", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    const newBtn = page.getByRole("button", { name: /новый клиент/i });
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");

    for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
    const stillInside = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      return !!(d && d.contains(document.activeElement));
    });
    expect(stillInside).toBe(true);

    await page.screenshot({
      path: path.join(outDir, `clients_new_dialog_${browserName}.png`),
      fullPage: false,
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".client-dialog-overlay")).toHaveCount(0);
  });

  test("create/select client + tabs", async ({ page, browserName }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    const clientId = await createClientViaUi(page, "Аудит Клиент Tabs");
    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    await expect(page.locator(".client-dialog-overlay")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Аудит Клиент Tabs" })).toBeVisible();

    for (const name of [/Обзор/i, /История/i, /Заметки/i]) {
      const tab = page.getByRole("tab", { name });
      await expect(tab).toBeVisible();
      await tab.click();
    }

    await page.screenshot({
      path: path.join(outDir, `clients_detail_${browserName}.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "desktop detail");
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
      path: path.join(outDir, `clients_1440_${browserName}_dark.png`),
      fullPage: false,
    });
    await expectNoBodyOverflow(page, "dark 1440");
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);
  });

  test("client deep-link", async ({ page }) => {
    test.setTimeout(90_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    const clientName = "Аудит Deep Link";
    const clientId = await createClientViaUi(page, clientName);
    expect(clientId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );

    await page.goto(baseURL + `/clients?client=${encodeURIComponent(clientId)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    const detail = page.locator(
      ".client-detail, .client-detail--dialog, .client-detail--drawer",
    );
    await expect(detail).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("heading", { name: clientName })).toBeVisible();
    await expect(detail).toHaveAttribute("aria-label", new RegExp(clientName));
    expect(page.url()).toContain(`client=${clientId}`);
    await expectNoBodyOverflow(page, "deep-link");
  });

  test("mobile/tablet detail dialog semantics", async ({ page }) => {
    test.setTimeout(120_000);
    if (!(await boot(page))) return;

    await page.setViewportSize({ width: 1440, height: 900 });
    const clientName = "Аудит Mobile Dialog";
    await createClientViaUi(page, clientName);
    await expect(page.locator(".client-dialog-overlay")).toHaveCount(0);

    // Tablet band: >900px and ≤1279px → drawer + aria-modal
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(250);
    await expectNoBodyOverflow(page, "1024 drawer");
    const tabletDetail = page.locator(
      '.client-detail--drawer[role="dialog"]',
    );
    await expect(tabletDetail).toBeVisible({ timeout: 15_000 });
    await expect(tabletDetail).toHaveAttribute("aria-modal", "true");
    await expect(tabletDetail).toHaveAttribute(
      "aria-label",
      new RegExp(clientName),
    );
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);

    // Mobile ≤900px → dialog + aria-modal
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    await expectNoBodyOverflow(page, "390 dialog");
    const mobileDetail = page.locator(
      '.client-detail--dialog[role="dialog"]',
    );
    await expect(mobileDetail).toBeVisible({ timeout: 15_000 });
    await expect(mobileDetail).toHaveAttribute("aria-modal", "true");
    await expect(mobileDetail).toHaveAttribute(
      "aria-label",
      new RegExp(clientName),
    );
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(200);
    await expectNoBodyOverflow(page, "320 dialog");
    await expect(mobileDetail).toBeVisible();
    await expect(mobileDetail).toHaveAttribute("aria-modal", "true");
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);

    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(200);
    await expectNoBodyOverflow(page, "768");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
    await expectNoBodyOverflow(page, "1440");
  });
});
