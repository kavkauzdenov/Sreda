/**
 * Clients V2 UI audit — list/detail layout, responsive, light/dark, a11y.
 * Requires reachable app via E2E_BASE_URL / AUDIT_BASE_URL.
 * Prefer AUDIT_STORAGE_STATE (same register/recovery flow as UI gate auth).
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

/**
 * Same registration/recovery flow as verify.yml
 * "Prepare auth storage for responsive audit".
 */
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

  if (page.url().includes("/business/new") || page.url().includes("business/new")) {
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

test.describe("Clients V2 UI audit", () => {
  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  if (hasStorage) {
    test.use({ storageState: storageStatePath });
  }

  test("responsive viewports + touch targets", async ({ page, browserName }) => {
    test.setTimeout(180_000);
    try {
      await ensureAuthed(page);
      await openClients(page);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        test.skip(true, String(error));
        return;
      }
      throw error;
    }

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(100);
      expect(await bodyOverflowX(page)).toBe(false);
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

  test("new-client dialog a11y + detail + mobile dialog semantics", async ({
    page,
    browserName,
  }) => {
    test.setTimeout(180_000);
    try {
      await ensureAuthed(page);
      await openClients(page);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        test.skip(true, String(error));
        return;
      }
      throw error;
    }

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

    await newBtn.click();
    await page.getByLabel(/^Имя/i).fill("Аудит Клиент");
    await page.getByRole("button", { name: /^Создать$/i }).click();
    await expect(
      page.locator(".client-detail, .client-detail--dialog"),
    ).toBeVisible({ timeout: 20_000 });

    for (const name of [/Обзор/i, /История/i, /Заметки/i]) {
      const tab = page
        .getByRole("tab", { name })
        .or(page.getByRole("button", { name }));
      if (await tab.count()) {
        await tab.first().click().catch(() => undefined);
      }
    }

    await page.screenshot({
      path: path.join(outDir, `clients_detail_${browserName}.png`),
      fullPage: false,
    });

    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.screenshot({
      path: path.join(outDir, `clients_1440_${browserName}_dark.png`),
      fullPage: false,
    });
    expect(await bodyOverflowX(page)).toBe(false);

    const clientUrl = page.url();
    const clientMatch = clientUrl.match(/client=([0-9a-f-]{36})/i);
    if (clientMatch) {
      await page.goto(baseURL + `/clients?client=${clientMatch[1]}`, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await expect(
        page.locator(".client-detail, .client-detail--dialog"),
      ).toBeVisible({ timeout: 20_000 });
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    expect(await bodyOverflowX(page)).toBe(false);
    const mobileDetail = page.locator(
      '.client-detail--dialog[role="dialog"], .client-detail--drawer[role="dialog"]',
    );
    await expect(mobileDetail).toBeVisible({ timeout: 15_000 });
    await expect(mobileDetail).toHaveAttribute("aria-modal", "true");
    await expect(mobileDetail).toHaveAttribute("aria-label", /.+/);
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);

    await page.setViewportSize({ width: 320, height: 568 });
    await page.waitForTimeout(120);
    expect(await bodyOverflowX(page)).toBe(false);
    expect(await minTouchTarget(page)).toBeGreaterThanOrEqual(43.5);
    await expect(
      page.locator('.client-detail--dialog[role="dialog"]'),
    ).toBeVisible();
    await expect(
      page.locator('.client-detail--dialog[role="dialog"]'),
    ).toHaveAttribute("aria-modal", "true");
  });
});
