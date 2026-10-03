/**
 * Research passport (§2 задачи Stage 4) — UI journey от заполнения паспорта
 * до просмотра результата: идентификация → цели → источники → предпросмотр
 * плана → сохранение → запуск → статус. Prefer AUDIT_STORAGE_STATE (UI gate
 * register → recovery → business). Must not skip when the CI isolated app
 * is healthy.
 */
import { test, expect } from "playwright/test";
import fs from "fs";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

const storageStatePath = process.env.AUDIT_STORAGE_STATE || "";
const hasStorage =
  Boolean(storageStatePath) && fs.existsSync(storageStatePath);

const outDir =
  process.env.E2E_SCREENSHOT_DIR ||
  process.env.AUDIT_OUTPUT ||
  "artifacts/intelligence-research-ui-audit";

function isNetworkUnavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /NETWORK_UNAVAILABLE|ERR_CONNECTION_REFUSED|ECONNREFUSED|ETIMEDOUT|net::ERR_/i.test(
    message,
  );
}

/** Same register/recovery/business flow as verify.yml auth storage step. */
async function registerAndBusiness(page) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const user = `osintr${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026os";
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
    await name.pressSequentially(`Research ${suffix}`, { delay: 15 });
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
        `PRODUCT_REGRESSION: create business HTTP ${createRes.status}`,
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

async function openIntelligence(page) {
  const res = await page.goto(baseURL + "/intelligence", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: intelligence ${res?.status}`);
  }
  await expect(
    page.getByTestId("intelligence-research-panel"),
  ).toBeVisible({ timeout: 30_000 });
}

async function boot(page) {
  try {
    await ensureAuthed(page);
    await openIntelligence(page);
  } catch (error) {
    if (isNetworkUnavailable(error)) {
      test.skip(true, String(error));
      return false;
    }
    throw error;
  }
  return true;
}

test.describe("Research passport UI journey", () => {
  test.beforeAll(() => {
    fs.mkdirSync(outDir, { recursive: true });
  });

  if (hasStorage) {
    test.use({ storageState: storageStatePath });
  }

  test("passport → goals → plan preview → save → launch → status", async ({
    page,
  }) => {
    if (!(await boot(page))) return;

    // --- Свежий паспорт: запуск без целей заблокирован --------------------
    await page.getByTestId("research-step-5").click();
    await expect(page.getByTestId("research-step-panel-5")).toBeVisible();
    await expect(page.getByTestId("research-step-panel-5")).toContainText(
      "Выберите хотя бы одну цель",
    );
    await expect(page.getByTestId("research-launch")).toBeDisabled();

    // --- Шаг 1: О бизнесе — идентификация и URL-роли ----------------------
    await page.getByTestId("research-step-1").click();
    const nameField = page.getByTestId("research-display-name");
    await expect(nameField).toBeVisible();
    await nameField.fill("Кафе Research UI");
    await page.getByTestId("research-new-url").fill("https://research-ui.example/");
    await page.getByRole("button", { name: "Добавить URL" }).click();
    await expect(page.getByTestId("research-urls")).toContainText(
      "https://research-ui.example/",
    );

    // --- Шаг 2: Что искать — цели с честными уровнями ---------------------
    await page.getByTestId("research-step-2").click();
    await expect(page.getByTestId("research-step-panel-2")).toBeVisible();
    await page.getByTestId("research-goal-contacts").check({ timeout: 30_000 });
    const goalsList = page.getByTestId("research-goals");
    await expect(goalsList).toContainText("Недоступно", { timeout: 30_000 });
    await expect(goalsList).toContainText("Поддерживается");
    await page.getByTestId("research-phrases").fill("research ui фраза");

    // --- Шаг 3–4: источники и предпросмотр плана без запуска --------------
    await page.getByTestId("research-step-3").click();
    await expect(page.getByTestId("research-step-panel-3")).toBeVisible();
    await page.getByTestId("research-preview").click();
    await expect(page.getByTestId("research-step-panel-4")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("research-queries")).toContainText(
      "research ui фраза",
    );
    await expect(page.getByTestId("research-unsupported")).toContainText(
      "Временной горизонт",
    );

    // --- Шаг 5: сохранение и запуск --------------------------------------
    await page.getByTestId("research-step-5").click();
    await expect(page.getByTestId("research-step-panel-5")).toBeVisible();
    await page.getByTestId("research-save").click();
    await expect(page.getByTestId("research-notice")).toContainText(
      "Паспорт сохранён",
      { timeout: 30_000 },
    );
    await expect(page.getByTestId("research-launch")).toBeEnabled();

    await page.getByTestId("research-launch").click();
    await expect(page.getByTestId("research-notice")).toContainText(
      /Исследование запущено|Активный запуск/,
      { timeout: 30_000 },
    );

    // --- Шаг 6: Результаты — статус запуска виден ------------------------
    await expect(page.getByTestId("research-step-panel-6")).toBeVisible();
    await expect(page.getByTestId("research-launch-status")).toContainText(
      /В очереди|Выполняется|Готово|Ошибка/,
      { timeout: 30_000 },
    );
    await page.screenshot({
      path: `${outDir}/research-journey-${page.viewportSize().width}.png`,
      fullPage: true,
    });
  });
});
