/**
 * Clients V2 UI audit — list/detail layout, responsive, light/dark.
 * Requires reachable app via E2E_BASE_URL / AUDIT_BASE_URL.
 */
import { test, expect } from "playwright/test";
import fs from "fs";
import path from "path";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

const outDir =
  process.env.E2E_SCREENSHOT_DIR ||
  "/opt/cursor/artifacts/screenshots/clients-v2";

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

async function minTouchTarget(page) {
  return page.evaluate(() => {
    let min = Infinity;
    for (const el of document.querySelectorAll(
      "button, .button, a.button, [role='button']",
    )) {
      if (!(el instanceof HTMLElement)) continue;
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      min = Math.min(min, Math.min(r.width, r.height));
    }
    return min === Infinity ? 0 : min;
  });
}

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
  await page.waitForTimeout(800);
  await page.locator("#account-login").click();
  await page.locator("#account-login").pressSequentially(user, { delay: 12 });
  await page.locator("#account-password").fill(pass);
  await page.locator("#account-confirmation").fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();
  const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
  if (await checkbox.count()) {
    await checkbox.check({ force: true }).catch(() => undefined);
  }
  await page.waitForURL(/\/(business\/new|dashboard|onboarding)/, {
    timeout: 60_000,
  });
  if (page.url().includes("/business/new")) {
    await page.getByLabel(/название/i).fill(`Clients V2 ${suffix}`);
    await page.getByRole("button", { name: /создать/i }).click();
    await page.waitForURL(/\/dashboard|\/clients|\/leads/, { timeout: 60_000 });
  }
}

test.describe("Clients V2 UI audit", () => {
  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  test("clients workspace responsive + themes", async ({ page, browserName }) => {
    test.setTimeout(180_000);
    try {
      await registerAndBusiness(page);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        test.skip(true, String(error));
        return;
      }
      throw error;
    }

    await page.goto(baseURL + "/clients", {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await expect(page.locator("h1")).toContainText(/Клиенты/i, {
      timeout: 30_000,
    });

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(300);
      expect(await bodyOverflowX(page)).toBe(false);
      const shot = path.join(
        outDir,
        `clients_${vp.width}_${browserName}_light.png`,
      );
      await page.screenshot({ path: shot, fullPage: true });
    }

    // Open new client dialog
    await page.setViewportSize({ width: 1440, height: 900 });
    const newBtn = page.getByRole("button", { name: /новый клиент/i });
    await expect(newBtn).toBeVisible();
    await newBtn.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({
      path: path.join(outDir, `clients_new_dialog_${browserName}.png`),
      fullPage: true,
    });
    await page.keyboard.press("Escape");

    // Create a client for detail screens
    await newBtn.click();
    await page.getByLabel(/^Имя/i).fill("Аудит Клиент");
    await page.getByRole("button", { name: /^Создать$/i }).click();
    await expect(page.locator(".client-detail, .client-detail--dialog")).toBeVisible({
      timeout: 20_000,
    });
    await page.screenshot({
      path: path.join(outDir, `clients_detail_${browserName}.png`),
      fullPage: true,
    });

    // Dark theme
    await page.evaluate(() => {
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(outDir, `clients_1440_${browserName}_dark.png`),
      fullPage: true,
    });
    expect(await bodyOverflowX(page)).toBe(false);

    // Mobile detail layer
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    expect(await bodyOverflowX(page)).toBe(false);
    const touch = await minTouchTarget(page);
    expect(touch).toBeGreaterThanOrEqual(40);
  });
});
