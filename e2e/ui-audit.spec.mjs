import { test, expect } from "@playwright/test";

const baseURL = "http://localhost:3000";

test("ui audit", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  
  // Register + login
  const user = `quick${Date.now()}`;
  const pass = "AcceptTest!2026ux";
  await page.goto(baseURL + "/register", { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.locator('input[name="username"], input[autocomplete="username"]').first().fill(user);
  const passwords = page.locator('input[type="password"]');
  await passwords.nth(0).fill(pass);
  if ((await passwords.count()) > 1) await passwords.nth(1).fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();
  await page.waitForTimeout(3000);
  const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
  if (await checkbox.count()) {
    await checkbox.check({ force: true });
    await page.getByRole("button", { name: /продолжить/i }).click();
    await page.waitForTimeout(2000);
  }
  await page.waitForFunction(() => !location.pathname.includes("/register"), null, { timeout: 30_000 });
  if (page.url().includes("business/new")) {
    await page.locator("#business-name").fill(`Quick ${Date.now()}`);
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForTimeout(2000);
  }
  
  const pages = [
    { path: "/dashboard", name: "dashboard" },
    { path: "/onboarding", name: "onboarding" },
    { path: "/connections", name: "connections" },
    { path: "/settings", name: "settings" },
    { path: "/settings/advanced", name: "settings-advanced" },
  ];
  
  for (const p of pages) {
    await page.goto(baseURL + p.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `/tmp/${p.name}-light.png`, fullPage: true });
    
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.documentElement.clientWidth + 1);
    console.log(`${p.name} light: overflow=${overflow}`);
    
    const overlaps = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], .button, .text-link'));
      const bad = [];
      for (let i = 0; i < elements.length; i++) {
        for (let j = i + 1; j < elements.length; j++) {
          const r1 = elements[i].getBoundingClientRect();
          const r2 = elements[j].getBoundingClientRect();
          if (r1.width > 0 && r1.height > 0 && r2.width > 0 && r2.height > 0) {
            const overlap = !(r1.right <= r2.left || r2.right <= r1.left || r1.bottom <= r2.top || r2.bottom <= r1.top);
            if (overlap) bad.push({ a: elements[i].outerHTML.slice(0,100), b: elements[j].outerHTML.slice(0,100) });
          }
        }
      }
      return bad;
    });
    console.log(`${p.name} light: overlaps=${overlaps.length}`);
    if (overlaps.length) console.log(overlaps);
  }
  
  await page.emulateMedia({ colorScheme: "dark" });
  for (const p of pages) {
    await page.goto(baseURL + p.path, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/${p.name}-dark.png`, fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.documentElement.clientWidth + 1);
    console.log(`${p.name} dark: overflow=${overflow}`);
  }
});
