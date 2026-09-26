import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const baseURL = "http://localhost:3000";
const outDir = "/tmp/ui-audit";

const viewports = [
  { name: "320", width: 320, height: 844 },
  { name: "375", width: 375, height: 812 },
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1024", width: 1024, height: 768 },
  { name: "1440", width: 1440, height: 900 },
];

const pages = [
  { path: "/login", name: "login", auth: false },
  { path: "/register", name: "register", auth: false },
  { path: "/dashboard", name: "dashboard", auth: true },
  { path: "/onboarding", name: "onboarding", auth: true },
  { path: "/connections", name: "connections", auth: true },
  { path: "/settings", name: "settings", auth: true },
  { path: "/settings/advanced", name: "settings-advanced", auth: true },
];

async function registerAndLogin(page, suffix) {
  const user = `audit${suffix}`;
  const pass = "AcceptTest!2026ux";
  await page.goto(baseURL + "/register", { waitUntil: "domcontentloaded", timeout: 60_000 });
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
  await page.waitForFunction(() => !location.pathname.includes("/register"), null, { timeout: 60_000 });
  if (page.url().includes("business/new")) {
    await page.locator("#business-name").fill(`Audit ${suffix}`);
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForTimeout(2000);
  }
  return user;
}

async function run() {
  const browser = await chromium.launch();
  
  for (const theme of ["light", "dark"]) {
    for (const vp of viewports) {
      const page = await browser.newPage();
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.emulateMedia({ colorScheme: theme });
      
      fs.mkdirSync(path.join(outDir, theme, vp.name), { recursive: true });
      
      let loggedIn = false;
      
      for (const p of pages) {
        if (p.auth && !loggedIn) {
          await registerAndLogin(page, `${theme}-${vp.name}`);
          loggedIn = true;
        }
        await page.goto(baseURL + p.path, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForTimeout(1000);
        await page.screenshot({
          path: path.join(outDir, theme, vp.name, `${p.name}.png`),
          fullPage: true,
        });
        
        // Check for overflow
        const overflow = await page.evaluate(() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 ||
                 document.body.scrollWidth > document.documentElement.clientWidth + 1;
        });
        if (overflow) {
          console.log(`⚠️ OVERFLOW: ${theme} ${vp.name} ${p.name}`);
        }
        
        // Check for overlapping elements
        const overlaps = await page.evaluate(() => {
          const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"], .button, .text-link'));
          const bad = [];
          for (let i = 0; i < elements.length; i++) {
            for (let j = i + 1; j < elements.length; j++) {
              const r1 = elements[i].getBoundingClientRect();
              const r2 = elements[j].getBoundingClientRect();
              if (r1.width > 0 && r1.height > 0 && r2.width > 0 && r2.height > 0) {
                const overlap = !(r1.right <= r2.left || r2.right <= r1.left || r1.bottom <= r2.top || r2.bottom <= r1.top);
                if (overlap) {
                  bad.push({ 
                    a: { tag: elements[i].tagName, class: elements[i].className, rect: { x: r1.x, y: r1.y, w: r1.width, h: r1.height } },
                    b: { tag: elements[j].tagName, class: elements[j].className, rect: { x: r2.x, y: r2.y, w: r2.width, h: r2.height } }
                  });
                }
              }
            }
          }
          return bad;
        });
        if (overlaps.length > 0) {
          console.log(`⚠️ OVERLAP: ${theme} ${vp.name} ${p.name}`, overlaps);
        }
      }
      await page.close();
    }
  }
  await browser.close();
  console.log("Done!");
}

run().catch(console.error);
