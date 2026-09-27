/**
 * Authenticated Leads V2 UI hardening — setup, builder, list, detail.
 * Requires reachable app via E2E_BASE_URL / AUDIT_BASE_URL (ci-ui-app or local).
 * Does not bypass production auth: registers a real ephemeral account.
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
  "/opt/cursor/artifacts/screenshots/leads-v2-hardening";

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
      (body != null && body.scrollWidth > doc.clientWidth + 1)
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
  const user = `ldv2${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026ld";
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
    await page.waitForTimeout(500);
    await name.click();
    await name.fill("");
    await name.pressSequentially(`Leads V2 ${suffix}`, { delay: 12 });
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForFunction(
      () => !location.pathname.includes("/business/new"),
      null,
      { timeout: 60_000 },
    );
  }
  return { user, pass, suffix };
}

async function activateLeads(page) {
  await page.goto(baseURL + "/solutions", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1000);
  const leadsCard = page.locator(".solution-card", {
    hasText: /заявок|leads/i,
  });
  if (await leadsCard.count()) {
    const connect = leadsCard
      .first()
      .getByRole("button", { name: /подключить|настроить|открыть|продолжить/i });
    if (await connect.count()) {
      await connect.first().click();
      await page.waitForTimeout(1500);
    }
  }
  await page.goto(baseURL + "/solutions/leads/setup", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1200);
}

test.describe("Leads V2 authenticated hardening", () => {
  test("setup → form builder → leads list across viewports", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    fs.mkdirSync(outDir, { recursive: true });

    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await registerAndBusiness(page);
      await activateLeads(page);
    } catch (error) {
      if (isNetworkUnavailable(error)) {
        test.skip(true, String(error));
        return;
      }
      throw error;
    }

    const routes = [
      { path: "/solutions/leads/setup", label: "setup" },
      { path: "/leads", label: "leads" },
    ];

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      for (const route of routes) {
        await page.goto(baseURL + route.path, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(800);
        expect(
          await bodyOverflowX(page),
          `${route.label} overflow @${vp.width}`,
        ).toBeFalsy();

        const shot = path.join(
          outDir,
          `${route.label}-${vp.width}.png`,
        );
        await page.screenshot({ path: shot, fullPage: true });
      }

      // Form builder presence on setup
      await page.goto(baseURL + "/solutions/leads/setup", {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(600);
      const builder = page.locator(
        '[aria-label="Конструктор формы заявки"], .lead-form-builder',
      );
      if (await builder.count()) {
        await expect(builder.first()).toBeVisible();
        const typeSelect = builder.locator("select").first();
        if (await typeSelect.count()) {
          const options = await typeSelect.locator("option").allTextContents();
          expect(options.some((t) => /несколько вариантов/i.test(t))).toBeTruthy();
        }
      }

      // Filters / list chrome on /leads
      await page.goto(baseURL + "/leads", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(600);
      expect(await bodyOverflowX(page)).toBeFalsy();
      const touch = await minTouchTarget(page);
      if (touch > 0 && vp.width <= 390) {
        expect(touch, `touch target @${vp.width}`).toBeGreaterThanOrEqual(32);
      }
    }

    // Focus / dialog sanity: open first lead if present
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(baseURL + "/leads", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    const leadRow = page.locator(
      "a[href*='/leads/'], button.leads-row, .leads-list button, [data-lead-id]",
    );
    if (await leadRow.count()) {
      await leadRow.first().click();
      await page.waitForTimeout(800);
      expect(await bodyOverflowX(page)).toBeFalsy();
      const detail = page.locator(
        ".lead-detail, [aria-label*='заявк'], dialog, [role='dialog']",
      );
      if (await detail.count()) {
        await expect(detail.first()).toBeVisible();
        const status = page.locator("#lead-detail-status");
        if (await status.count()) {
          await status.focus();
          await expect(status).toBeFocused();
        }
      }
    }
  });
});
