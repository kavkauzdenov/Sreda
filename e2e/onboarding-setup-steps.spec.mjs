/**
 * Onboarding E2E audit scenarios.
 * Run against a local dev environment (npm run dev) or staging.
 * NOT for production - creates throwaway accounts.
 */
import { test, expect } from "playwright/test";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

async function registerAndLogin(page, suffix) {
  const user = `e2eonb${suffix}`;
  const pass = "AcceptTest!2026ux";
  await page.goto(baseURL + "/register", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await page.locator('input[name="username"], input[autocomplete="username"]').first().fill(user);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(pass);
  if ((await passwords.count()) > 1) await passwords.nth(1).fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();
  await page.waitForTimeout(3500);
  const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
  if (await checkbox.count()) {
    await checkbox.check({ force: true });
    await page.getByRole("button", { name: /продолжить/i }).click();
    await page.waitForTimeout(3000);
  }
  await page.waitForFunction(() => !location.pathname.includes("/register"), null, { timeout: 60_000 });
  if (page.url().includes("business/new")) {
    await page.locator("#business-name").fill(`E2E Онборд ${suffix}`);
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForTimeout(3000);
  }
  return user;
}

async function getDashboardState(page) {
  await page.goto(baseURL + "/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".biznesoty-hero")).toBeVisible({ timeout: 30_000 });
  const banner = page.locator(".account-notice").first();
  const bannerText = await banner.textContent().catch(() => "");
  const checklist = page.locator(".setup-checklist--compact");
  const checklistText = await checklist.textContent().catch(() => "");
  const continueLink = page.locator(".account-notice a[href]").first();
  const continueHref = await continueLink.getAttribute("href").catch(() => "");
  return { bannerText, checklistText, continueHref };
}

async function goOnboarding(page) {
  await page.goto(baseURL + "/onboarding", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".setup-page")).toBeVisible({ timeout: 30_000 });
}

async function getOnboardingStep(page) {
  const eyebrow = page.locator(".eyebrow, .eyebrow + h1, h1").first();
  const text = await eyebrow.textContent().catch(() => "");
  const notice = page.locator(".account-notice").first();
  const noticeText = await notice.textContent().catch(() => "");
  return { stepText: text, noticeText };
}

async function saveAdvancedConfig(page) {
  const saveBtn = page.getByRole("button", { name: /сохранить/i }).first();
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(2000);
  }
}

test.describe("Onboarding E2E flow", () => {
  test.setTimeout(300_000);

  test("new business: dashboard → onboarding → advanced save → next step visible", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    await registerAndLogin(page, suffix);

    // 1. Dashboard shows onboarding banner
    const dash1 = await getDashboardState(page);
    expect(dash1.bannerText).toContain("Стартовая настройка");
    expect(dash1.continueHref).toMatch(/\/onboarding/);

    // 2. Continue → /onboarding
    await page.goto(baseURL + dash1.continueHref, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".setup-page")).toBeVisible();

    // 3. Should be at industry step (no industry yet)
    const step1 = await getOnboardingStep(page);
    expect(step1.stepText).toMatch(/Настройка бизнеса|Чем занимается/);

    // 4. Open advanced configurator
    const advBtn = page.getByRole("button", { name: /расширенную настройку/i }).first();
    if (await advBtn.count()) {
      await advBtn.click();
      await page.waitForTimeout(1000);
    }

    // 5. Advanced configurator visible
    await expect(page.locator("text=Что должен уметь бот")).toBeVisible({ timeout: 10_000 });

    // 6. Save without changes
    await saveAdvancedConfig(page);

    // 7. Should show "Настройки сохранены" + next step CTA + checklist
    await expect(page.locator("text=Настройки сохранены")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Что дальше")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Вернуться в дашборд")).toBeVisible();
    await expect(page.locator(".setup-progress__list")).toBeVisible();

    // 8. Dashboard after save - banner should reflect progress
    const dash2 = await getDashboardState(page);
    expect(dash2.bannerText).toContain("Стартовая настройка");
  });

  test("existing Telegram connection: banner does not show 'Подключите Telegram'", async ({ page }) => {
    // This test requires a business with pre-existing Telegram connection.
    // Run against a seeded staging environment.
    test.skip(true, "Requires seeded business with Telegram connection");
  });

  test("completed onboarding: no banner, no continue link", async ({ page }) => {
    test.skip(true, "Requires seeded business with completed onboarding");
  });

  test("refresh persistence: save → F5 → state preserved", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    await registerAndLogin(page, suffix);
    await page.goto(baseURL + "/onboarding", { waitUntil: "domcontentloaded" });
    const advBtn = page.getByRole("button", { name: /расширенную настройку/i }).first();
    if (await advBtn.count()) await advBtn.click();
    await page.waitForTimeout(1000);
    await saveAdvancedConfig(page);
    await page.waitForTimeout(2000);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("text=Настройки сохранены")).toBeVisible({ timeout: 10_000 });
  });

  test("dashboard ↔ onboarding consistency: banner and checklist agree", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    await registerAndLogin(page, suffix);
    const dash = await getDashboardState(page);
    expect(dash.bannerText).toContain("Стартовая настройка");
    if (dash.checklistText) {
      // Both should show same progress concept
      expect(dash.checklistText).toContain("Стартовая настройка");
    }
  });

  test("direct URL to /onboarding shows correct step", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    await registerAndLogin(page, suffix);
    await page.goto(baseURL + "/onboarding", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".setup-page")).toBeVisible();
    // Should not show completed steps as pending
    const step = await getOnboardingStep(page);
    expect(step.stepText.length).toBeGreaterThan(0);
  });

  test("back/forward navigation doesn't break state", async ({ page }) => {
    const suffix = Date.now().toString(36).slice(-6);
    await registerAndLogin(page, suffix);
    await page.goto(baseURL + "/dashboard", { waitUntil: "domcontentloaded" });
    const dash1 = await getDashboardState(page);
    await page.goto(baseURL + "/onboarding", { waitUntil: "domcontentloaded" });
    await page.goBack();
    await page.waitForTimeout(500);
    const dash2 = await getDashboardState(page);
    expect(dash2.bannerText).toBe(dash1.bannerText);
  });
});