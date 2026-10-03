/**
 * Dashboard UX (§1 UX gate): greeting, quick actions, attention block, summary,
 * empty state, responsive layout and navigation integrity.
 *
 * Verifies the information-architecture contract: the dashboard is a summary and
 * a set of entry points, so it must NOT re-render the profile sections' tables
 * (leads/orders/bookings lists) that the old ActivityFeed duplicated.
 *
 * Prefers the CI UI-gate storage state (register → recovery → business) and falls
 * back to running that same flow locally. Must not silently skip when the CI
 * isolated app is healthy.
 */
import { test, expect } from "playwright/test";
import fs from "fs";

const baseURL =
  process.env.E2E_BASE_URL || process.env.AUDIT_BASE_URL || "http://127.0.0.1:3000";

const storageStatePath = process.env.AUDIT_STORAGE_STATE || "";
const hasStorage = Boolean(storageStatePath) && fs.existsSync(storageStatePath);

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];

async function registerAndBusiness(page) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const user = `dashux${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026da";
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
    await name.pressSequentially(`Dash UX ${suffix}`, { delay: 15 });
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForFunction(() => !location.pathname.includes("/business/new"), null, { timeout: 60_000 });
  }
}

async function openDashboard(page) {
  const res = await page.goto(baseURL + "/dashboard", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (!res || res.status() >= 500) {
    throw new Error(`NETWORK_UNAVAILABLE: dashboard ${res?.status()}`);
  }
  await expect(page.getByTestId("dashboard-greeting")).toBeVisible({ timeout: 30_000 });
}

for (const viewport of VIEWPORTS) {
  test.describe(`dashboard · ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("приветствие по местному времени и дата", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      else await page.context().addCookies([]);
      await openDashboard(page);

      const greeting = page.getByTestId("dashboard-greeting");
      await expect(greeting).toBeVisible();

      // The greeting is one of exactly four phrases, or a bare name before hydration.
      const text = (await greeting.innerText()).trim();
      const allowed = ["Доброй ночи", "Доброе утро", "Добрый день", "Добрый вечер"];
      const base = text.split(",")[0].trim();
      expect(
        allowed.includes(base),
        `приветствие «${text}» не соответствует времени суток`,
      ).toBe(true);

      // Local date is rendered client-side and must not be empty after hydration.
      await expect(page.getByTestId("dashboard-date")).not.toHaveText("");
    });

    test("приветствие соответствует локальному часу браузера", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);
      const expected = await page.evaluate(() => {
        const h = new Date().getHours();
        if (h < 5) return "Доброй ночи";
        if (h < 12) return "Доброе утро";
        if (h < 18) return "Добрый день";
        return "Добрый вечер";
      });
      const text = (await page.getByTestId("dashboard-greeting").innerText()).trim();
      expect(
        text.split(",")[0].trim(),
        `ожидалось «${expected}» для локального времени браузера, получено «${text}»`,
      ).toBe(expected);
    });

    test("главная показывает блок внимания и пустое состояние для нового бизнеса", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);

      // A brand-new workspace has no records: the empty state must explain what to do
      // instead of rendering a wall of zeros, and the attention block must be calm.
      const empty = page.getByTestId("dashboard-empty");
      const attention = page.getByTestId("dashboard-attention");
      await expect(attention, "блок «Требует внимания» отсутствует").toBeVisible();

      if (await empty.isVisible().catch(() => false)) {
        await expect(empty).toContainText(/подключить канал|настройк/i);
      } else {
        // Data already exists (shared CI storage) — then a real state must be shown.
        const attentionEmpty = page.getByTestId("attention-empty");
        const items = page.getByTestId("attention-item");
        const calm = await attentionEmpty.isVisible().catch(() => false);
        const listed = await items.count();
        expect(calm || listed > 0, "нет ни пустого состояния, ни задач").toBe(true);
      }
    });

    test("быстрые действия ведут в существующие разделы", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);

      const quick = page.locator(".biznesoty-quick a, .biznesoty-quick button");
      const count = await quick.count();
      expect(count, "быстрые действия не отрисованы").toBeGreaterThan(0);

      const hrefs = await quick.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("href")).filter(Boolean),
      );
      for (const href of hrefs) {
        expect(
          href,
          `быстрое действие ведёт в неизвестный маршрут ${href}`,
        ).toMatch(/^\/(orders|leads|bookings|messages|posts|clients|solutions|settings)/);
      }
    });

    test("главная не дублирует таблицы профильных разделов", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);

      // The removed ActivityFeed rendered a mixed 8-row feed across five entities.
      await expect(page.getByTestId("osint-panel")).toHaveCount(0);
      await expect(page.locator(".biznesoty-activity")).toHaveCount(0);
      await expect(page.locator(".biznesoty-pulse")).toHaveCount(0);
      await expect(page.locator(".biznesoty-hive")).toHaveCount(0);
      // No data table belongs on the dashboard at all.
      const tables = await page.locator("main table").count();
      expect(tables, "на главной появилась таблица — это дублирование раздела").toBe(0);
    });

    test("без горизонтального переполнения и наложений", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `горизонтальный скролл ${overflow}px`).toBeLessThanOrEqual(1);

      // Attention rows: the CTA must stay inside its row and not overlap the text.
      const items = page.getByTestId("attention-item");
      const n = await items.count();
      for (let i = 0; i < n; i += 1) {
        const item = items.nth(i);
        const body = item.locator(".biznesoty-attention__body");
        const cta = item.locator("a.button");
        if (!(await body.isVisible().catch(() => false))) continue;
        const bb = await body.boundingBox();
        if (bb && (await cta.isVisible().catch(() => false))) {
          const cb = await cta.boundingBox();
          if (cb) {
            const stacked = cb.y >= bb.y + bb.height - 2;
            const sideBySide = cb.x >= bb.x + bb.width - 1;
            expect(
              stacked || sideBySide,
              "кнопка действия налезает на текст задачи",
            ).toBe(true);
          }
        }
      }
    });

    test("навигация и основные разделы не сломаны", async ({ page }) => {
      if (!hasStorage) await registerAndBusiness(page);
      await openDashboard(page);

      for (const path of ["/leads", "/orders", "/bookings", "/clients", "/intelligence", "/settings"]) {
        const res = await page.goto(baseURL + path, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        expect(res, `${path} недоступен`).not.toBeNull();
        expect(res.status(), `${path} вернул HTTP ${res.status()}`).toBeLessThan(400);
        // Must not be silently redirected to the login screen.
        expect(
          new URL(page.url()).pathname,
          `${path} выбросил на авторизацию`,
        ).not.toBe("/login");
      }
    });
  });
}