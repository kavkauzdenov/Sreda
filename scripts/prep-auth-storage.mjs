import { chromium } from "playwright";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const state = JSON.parse(await readFile("artifacts/ci-ui-app.json", "utf8"));
const base = state.origin;
await mkdir("artifacts", { recursive: true });
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
const page = await ctx.newPage();
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const user = `ordgate${suffix}`.slice(0, 28);
const pass = "AcceptTest!2026ord";
await page.goto(base + "/register", { waitUntil: "networkidle", timeout: 90_000 });
await page.locator("#account-login").waitFor({ state: "visible", timeout: 30_000 });
await page.waitForTimeout(800);
await page.locator("#account-login").fill(user);
await page.locator("#account-password").fill(pass);
await page.locator("#account-confirmation").fill(pass);
await page.getByRole("button", { name: /создать аккаунт/i }).click();
const checkbox = page.locator("label.recovery-confirm input[type=checkbox]");
await checkbox.waitFor({ state: "attached", timeout: 45_000 });
await page.locator("label.recovery-confirm").click();
await page.getByRole("button", { name: /продолжить/i }).click();
await page.waitForFunction(() => !location.pathname.includes("/register"), null, {
  timeout: 45_000,
});
if (page.url().includes("business/new")) {
  const name = page.locator("#business-name");
  await name.waitFor({ state: "visible", timeout: 20_000 });
  await name.fill(`Orders Gate ${suffix}`);
  await page.getByRole("button", { name: /создать пространство/i }).click();
  await page.waitForFunction(
    () => !location.pathname.includes("/business/new"),
    null,
    { timeout: 60_000 },
  );
}
await ctx.storageState({ path: "artifacts/audit-storage.json" });
await browser.close();
console.log("storage ready", user, base);
