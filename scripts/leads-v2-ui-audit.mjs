/**
 * Authenticated Leads V2 viewport audit (320/390/768/1024/1440).
 * Uses real register → business fixture (no auth bypass).
 *
 * Usage:
 *   AUDIT_BASE_URL=https://127.0.0.1:PORT AUDIT_IGNORE_HTTPS_ERRORS=1 \
 *     node scripts/leads-v2-ui-audit.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const base =
  process.env.AUDIT_BASE_URL ||
  process.env.E2E_BASE_URL ||
  "http://127.0.0.1:3000";
const out =
  process.env.AUDIT_OUTPUT ||
  "/opt/cursor/artifacts/screenshots/leads-v2-ui-audit";
const ignoreHTTPSErrors = process.env.AUDIT_IGNORE_HTTPS_ERRORS === "1";

const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];

async function overflow(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    return (
      doc.scrollWidth > doc.clientWidth + 1 ||
      (body != null && body.scrollWidth > doc.clientWidth + 1)
    );
  });
}

async function minTouch(page) {
  return page.evaluate(() => {
    let min = Infinity;
    for (const el of document.querySelectorAll(
      "button, .button, a.button, [role='button']",
    )) {
      if (!(el instanceof HTMLElement)) continue;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      min = Math.min(min, Math.min(r.width, r.height));
    }
    return min === Infinity ? null : Math.round(min * 10) / 10;
  });
}

async function register(page) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`;
  const user = `ldaud${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026ld";
  await page.goto(base + "/register", {
    waitUntil: "networkidle",
    timeout: 90_000,
  });
  await page.locator("#account-login").waitFor({ state: "visible" });
  await page.waitForTimeout(600);
  await page.locator("#account-login").pressSequentially(user, { delay: 10 });
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
    await name.waitFor({ state: "visible" });
    await name.pressSequentially(`Leads Audit ${suffix}`, { delay: 10 });
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForFunction(
      () => !location.pathname.includes("/business/new"),
      null,
      { timeout: 60_000 },
    );
  }
  return { user };
}

async function snap(page, name) {
  const file = path.join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function main() {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ignoreHTTPSErrors });
  const page = await ctx.newPage();
  const report = { base, viewports: {}, checks: [] };

  await page.setViewportSize({ width: 390, height: 844 });
  await register(page);

  // Activate / open leads setup
  await page.goto(base + "/solutions", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const connect = page
    .locator(".solution-card", { hasText: /заявок/i })
    .getByRole("button", { name: /подключить|настроить|открыть|продолжить/i });
  if (await connect.count()) {
    await connect.first().click();
    await page.waitForTimeout(1200);
  }
  await page.goto(base + "/solutions/leads/setup", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1000);

  const surfaces = [
    { key: "setup", path: "/solutions/leads/setup" },
    { key: "leads", path: "/leads" },
    { key: "solutions", path: "/solutions" },
  ];

  for (const vp of VIEWPORTS) {
    const vpKey = String(vp.width);
    report.viewports[vpKey] = {};
    await page.setViewportSize(vp);

    for (const surface of surfaces) {
      await page.goto(base + surface.path, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.waitForTimeout(700);
      const ox = await overflow(page);
      const touch = await minTouch(page);
      const shot = await snap(page, `${surface.key}-${vp.width}`);
      const entry = {
        overflowX: ox,
        minTouchTarget: touch,
        screenshot: shot,
      };
      report.viewports[vpKey][surface.key] = entry;
      report.checks.push({
        viewport: vp.width,
        surface: surface.key,
        pass: !ox,
        ...entry,
      });
      if (ox) {
        throw new Error(`Horizontal overflow on ${surface.path} @${vp.width}`);
      }
    }

    // Form builder + wizard next on setup
    await page.goto(base + "/solutions/leads/setup", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(600);
    const builder = page.locator(".lead-form-builder");
    const next = page.getByRole("button", { name: /далее|продолжить/i });
    // Advance to form step if needed
    for (let i = 0; i < 3 && !(await builder.count()); i++) {
      if (await next.count()) {
        await next.first().click();
        await page.waitForTimeout(700);
      }
    }
    if (await builder.count()) {
      const options = await builder.locator("select option").allTextContents();
      const hasMulti = options.some((t) => /несколько вариантов/i.test(t));
      report.viewports[vpKey].formBuilder = {
        visible: true,
        hasMultiselect: hasMulti,
        overflowX: await overflow(page),
        screenshot: await snap(page, `form-builder-${vp.width}`),
      };
      if (!hasMulti) {
        throw new Error(`multiselect missing in FormBuilder @${vp.width}`);
      }
    } else {
      report.viewports[vpKey].formBuilder = { visible: false };
    }

    // Channel step / preview if reachable
    const channelLegend = page.getByText(/Telegram|ВКонтакте|VK/i);
    if (await channelLegend.count()) {
      report.viewports[vpKey].channels = {
        visible: true,
        overflowX: await overflow(page),
      };
    }

    // Filters on /leads
    await page.goto(base + "/leads", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(600);
    const filters = page.locator(".leads-filters, [aria-label='Фильтры заявок']");
    report.viewports[vpKey].filters = {
      visible: (await filters.count()) > 0,
      overflowX: await overflow(page),
      screenshot: await snap(page, `filters-${vp.width}`),
    };
  }

  // Focus check on setup heading / controls at 1024
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(base + "/solutions/leads/setup", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(500);
  const focusable = page.locator("button, input, select, textarea").first();
  if (await focusable.count()) {
    await focusable.focus();
    report.focusOk = await page.evaluate(
      () => document.activeElement?.tagName != null,
    );
  }

  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, out, summary: report.checks }, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
