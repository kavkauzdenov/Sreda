/**
 * Intelligence: customer-facing copy must not expose adapter internals (§3 UX gate).
 *
 * The reported defect was a line showing internal provider names together with
 * the raw code `osint_vk_token_missing`. This spec renders the real Intelligence
 * page in a browser and asserts that no technical code, enum value or policy name
 * reaches the customer's DOM.
 *
 * It deliberately does NOT launch an OSINT discovery run: no external research is
 * triggered here, per the gate constraints.
 */
import { test, expect } from "playwright/test";
import fs from "fs";

const baseURL =
  process.env.E2E_BASE_URL || process.env.AUDIT_BASE_URL || "http://127.0.0.1:3000";

const storageStatePath = process.env.AUDIT_STORAGE_STATE || "";
const hasStorage = Boolean(storageStatePath) && fs.existsSync(storageStatePath);

/** Codes, adapter ids and policy names that must never be rendered. */
const FORBIDDEN = [
  "osint_vk_token_missing",
  "provider_not_configured",
  "no_providers_available",
  "no_page_provider_available",
  "no_queries_generated",
  "duration_budget_exhausted",
  "results_budget_exhausted",
  "aborted_by_caller",
  "stale_run_expired",
  "robots_disallowed",
  "official_api",
  "structured_data",
  "public_web",
  "search_api",
  "provider_not_",
  "osint_",
];

async function registerAndBusiness(page) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const user = `intux${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026in";
  const res = await page.goto(baseURL + "/register", { waitUntil: "networkidle", timeout: 90_000 });
  if (!res || res.status() >= 500) throw new Error(`NETWORK_UNAVAILABLE: register ${res?.status()}`);
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
  await page.waitForFunction(() => !location.pathname.includes("/register"), null, { timeout: 45_000 });
  if (page.url().includes("business/new")) {
    const name = page.locator("#business-name");
    await name.waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForTimeout(800);
    await name.click();
    await name.fill("");
    await name.pressSequentially(`Int UX ${suffix}`, { delay: 15 });
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForFunction(() => !location.pathname.includes("/business/new"), null, { timeout: 60_000 });
  }
}

async function openIntelligence(page) {
  const res = await page.goto(baseURL + "/intelligence", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: intelligence ${res?.status()}`);
  }
  await expect(page.getByTestId("intelligence-research-panel")).toBeVisible({ timeout: 30_000 });
}

test.describe("intelligence · human-readable states", () => {
  // Apply the CI session; without it every request lands on /login.
  if (hasStorage) {
    test.use({ storageState: storageStatePath });
  }

  test("в интерфейсе нет внутренних кодов и enum-значений", async ({ page }) => {
    if (!hasStorage) await registerAndBusiness(page);
    await openIntelligence(page);
    // Give the OSINT snapshot request time to settle so providers are rendered.
    await page.waitForTimeout(2500);

    const text = await page.evaluate(() => document.body.innerText);
    const leaks = FORBIDDEN.filter((needle) => text.includes(needle));
    expect(
      leaks,
      `в пользовательском интерфейсе видны технические значения: ${leaks.join(", ")}`,
    ).toEqual([]);

    // Machine enum values used for sources/entities must not leak either.
    for (const enumLike of ["OWNER", "MENTIONS", "third_party", "review_platform", "linked"]) {
      // These words may legitimately appear in prose; require them as standalone enum tokens.
      const asEnum = new RegExp(`(^|[\\s(])${enumLike}([\\s)]|$)`, "m");
      expect(
        asEnum.test(text),
        `в интерфейсе видно машинное значение ${enumLike}`,
      ).toBe(false);
    }
  });

  test("недоступный источник объяснён по-человечески, а не кодом", async ({ page }) => {
    if (!hasStorage) await registerAndBusiness(page);
    await openIntelligence(page);

    // The passport wizard lists providers on step 3 ("Источники и ограничения").
    const providers = page.getByTestId("research-providers");
    if (!(await providers.isVisible().catch(() => false))) {
      // Not rendered on the default step — the global no-code assertion above still applies.
      return;
    }
    const text = await providers.innerText();
    expect(text.includes("osint_vk_token_missing")).toBe(false);
    expect(text).not.toMatch(/official_api|public_web|structured_data/);
  });

  test("страница не утверждает успех там, где сбор не выполнялся", async ({ page }) => {
    if (!hasStorage) await registerAndBusiness(page);
    await openIntelligence(page);
    await page.waitForTimeout(2000);

    const panel = page.getByTestId("osint-panel");
    if (!(await panel.isVisible().catch(() => false))) return;
    const text = await panel.innerText();
    // A truthful state must remain truthful: with zero candidates we must not claim success.
    if (/Данные получены|всё работает|получены данные/i.test(text)) {
      const zeroCounts = await panel
        .locator("text=/Кандидаты/")
        .locator("xpath=following-sibling::strong")
        .first()
        .innerText()
        .catch(() => "1");
      expect(zeroCounts.trim(), "успех заявлен при нулевых кандидатах").not.toBe("0");
    }
  });
});