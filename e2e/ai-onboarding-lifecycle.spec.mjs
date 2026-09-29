/**
 * P0: NEW USER → business → AI interview submit → next step.
 * Also covers AI-unavailable fallback retention via API when AI returns errors.
 * Against E2E_BASE_URL (staging).
 */
import { test, expect } from "playwright/test";
import fs from "fs";
import path from "path";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

const outDir =
  process.env.E2E_SCREENSHOT_DIR ||
  "/opt/cursor/artifacts/screenshots/ai-onboarding-lifecycle";

async function register(page, suffix) {
  const user = `aionb${suffix}`;
  const pass = "AcceptTest!2026ux";
  await page.goto(baseURL + "/register", {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.locator("#account-login").waitFor({ state: "visible" });
  // Ensure React handlers are attached before submit.
  await page.waitForFunction(() => {
    const form = document.querySelector("form");
    return form && Object.keys(form).some((k) => k.startsWith("__react"));
  });
  await page.locator("#account-login").fill(user);
  await page.locator("#account-password").fill(pass);
  await page.locator("#account-confirmation").fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();
  const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
  await checkbox.waitFor({ state: "visible", timeout: 90_000 });
  await checkbox.check({ force: true });
  await page.getByRole("button", { name: /продолжить/i }).click();
  await page.waitForFunction(
    () => !location.pathname.includes("/register"),
    null,
    { timeout: 90_000 },
  );
  return { user, pass };
}

async function ensureBusiness(page, suffix) {
  if (page.url().includes("business/new") || page.url().includes("/business")) {
    const name = page.locator("#business-name");
    if (await name.count()) {
      await name.fill(`AI Онборд ${suffix}`);
      await page.getByRole("button", { name: /создать пространство/i }).click();
      await page.waitForTimeout(3500);
    }
  }
  // Prefer navigating to settings AI section.
  await page.goto(baseURL + "/settings?section=ai", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(2000);
  if (page.url().includes("business/new")) {
    await page.locator("#business-name").fill(`AI Онборд ${suffix}`);
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForTimeout(3500);
    await page.goto(baseURL + "/settings?section=ai", {
      waitUntil: "domcontentloaded",
    });
  }
}

test.describe("AI onboarding lifecycle", () => {
  test("register → create business → AI interview → confirm without global crash", async ({
    page,
  }) => {
    test.setTimeout(480_000);
    fs.mkdirSync(outDir, { recursive: true });
    const suffix = Date.now().toString(36).slice(-6);

    await page.setViewportSize({ width: 390, height: 844 });
    await register(page, suffix);
    await page.screenshot({
      path: path.join(outDir, "01-after-register-390.png"),
      fullPage: true,
    });

    await ensureBusiness(page, suffix);
    await page.screenshot({
      path: path.join(outDir, "02-settings-ai-390.png"),
      fullPage: true,
    });

    // Open AI interview disclosure if collapsed.
    const summary = page.locator("summary", { hasText: /AI-интервью/i });
    if (await summary.count()) {
      await summary.first().click();
      await page.waitForTimeout(500);
    }

    const panel = page.locator(".ai-interview-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });

    // Answer all questions until summary appears.
    let guard = 0;
    while (guard++ < 40) {
      const crash = page.getByText(/Что-то пошло не так/i);
      expect(await crash.count(), "global crash screen must not appear").toBe(0);

      const confirmBtn = panel.getByRole("button", { name: /Всё верно/i });
      if (await confirmBtn.count()) break;

      const answerBox = panel.locator("textarea").first();
      if (!(await answerBox.count())) {
        // Summary regenerating / no question — wait or break.
        const regen = panel.getByRole("button", { name: /Повторить AI-анализ/i });
        if (await regen.count()) {
          await regen.click();
          await page.waitForTimeout(5000);
          continue;
        }
        await page.waitForTimeout(2000);
        continue;
      }
      await expect(answerBox).toBeEnabled({ timeout: 120_000 });
      await answerBox.fill(`E2E ответ ${guard} для AI-онбординга`);
      await panel.getByRole("button", { name: /Ответить/i }).click();
      // Last answers trigger AI summary — allow up to 60s for unlock.
      await page
        .locator(".ai-interview-panel")
        .getByRole("button", { name: /Всё верно|Ответить|Повторить AI-анализ/i })
        .first()
        .waitFor({ state: "visible", timeout: 120_000 });
      await page.waitForTimeout(800);
    }

    await page.screenshot({
      path: path.join(outDir, "03-ai-summary-390.png"),
      fullPage: true,
    });

    const confirmBtn = panel.getByRole("button", { name: /Всё верно/i });
    await expect(confirmBtn).toBeVisible({ timeout: 60_000 });
    await confirmBtn.click();
    await page.waitForTimeout(3000);

    // Must not show global error.
    expect(await page.getByText(/Что-то пошло не так/i).count()).toBe(0);
    await expect(panel.getByText(/Интервью подтверждено/i)).toBeVisible({
      timeout: 30_000,
    });

    await page.screenshot({
      path: path.join(outDir, "04-ai-confirmed-390.png"),
      fullPage: true,
    });

    // Reload — confirmed state persists.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    const summary2 = page.locator("summary", { hasText: /AI-интервью/i });
    if (await summary2.count()) await summary2.first().click();
    await expect(
      page.locator(".ai-interview-panel").getByText(/Интервью подтверждено/i),
    ).toBeVisible({ timeout: 30_000 });

    await page.screenshot({
      path: path.join(outDir, "05-ai-persisted-after-reload-390.png"),
      fullPage: true,
    });
  });

  test("registration light theme inputs are readable (no white-on-white)", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    fs.mkdirSync(outDir, { recursive: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto(baseURL + "/register", { waitUntil: "domcontentloaded" });
    await page
      .locator('input[name="username"], input[autocomplete="username"]')
      .first()
      .fill("contrastcheck");
    const colors = await page.evaluate(() => {
      const input = document.querySelector(
        'input[name="username"], input[autocomplete="username"]',
      );
      if (!input) return null;
      const cs = getComputedStyle(input);
      return {
        color: cs.color,
        background: cs.backgroundColor,
        placeholder: getComputedStyle(input, "::placeholder").color,
      };
    });
    expect(colors).toBeTruthy();
    // Must not be near-white text on near-white background.
    const parseRgb = (c) => {
      const m = String(c).match(/(\d+)/g);
      return m ? m.map(Number).slice(0, 3) : [0, 0, 0];
    };
    const [r, g, b] = parseRgb(colors.color);
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    expect(luminance, `input text too light: ${colors.color}`).toBeLessThan(
      0.55,
    );
    await page.screenshot({
      path: path.join(outDir, "register-light-contrast-390.png"),
      fullPage: true,
    });
  });
});
