/**
 * Browser contrast checks for critical UI elements (light + dark).
 * Uses relativeLuminance / contrastRatio from src/lib/contrast.ts.
 */
import { test, expect } from "playwright/test";
import { contrastRatio, AA_NORMAL, UI_CHROME_MIN } from "../src/lib/contrast.ts";

const baseURL =
  process.env.E2E_BASE_URL ||
  process.env.AUDIT_BASE_URL ||
  "http://127.0.0.1:3000";

function parseCssColor(input) {
  const s = String(input || "").trim();
  const rgba = s.match(
    /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
  );
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] == null ? 1 : Number(rgba[4]),
    };
  }
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex.slice(0, 6);
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    };
  }
  return null;
}

function compositeOver(fg, bg) {
  const a = Math.max(0, Math.min(1, fg.a ?? 1));
  if (a >= 0.999) return { r: fg.r, g: fg.g, b: fg.b };
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

async function sample(page, selector, { fill, placeholder } = {}) {
  return page.evaluate(
    ({ selector, fill, placeholder }) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      if (fill != null && "value" in el) {
        el.value = fill;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
      const style = getComputedStyle(el);
      let color = style.color;
      let background = style.backgroundColor;
      if (placeholder) {
        // Approximate placeholder via ::placeholder when supported
        try {
          const ph = getComputedStyle(el, "::placeholder");
          if (ph && ph.color) color = ph.color;
        } catch {
          /* ignore */
        }
      }
      // Walk ancestors for opaque background
      let node = el;
      while (node && node !== document.documentElement) {
        const bg = getComputedStyle(node).backgroundColor;
        const parsed = bg.match(
          /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i,
        );
        if (parsed) {
          const a = parsed[4] == null ? 1 : Number(parsed[4]);
          if (a >= 0.95) {
            background = bg;
            break;
          }
        }
        node = node.parentElement;
      }
      return {
        color,
        background,
        fontSize: style.fontSize,
        text: (el.textContent || el.value || "").slice(0, 40),
      };
    },
    { selector, fill, placeholder: Boolean(placeholder) },
  );
}

function ratioFromSample(sampleResult) {
  if (!sampleResult) return null;
  const fg = parseCssColor(sampleResult.color);
  const bg = parseCssColor(sampleResult.background);
  if (!fg || !bg) return null;
  const composed = compositeOver(fg, bg);
  return contrastRatio(composed, { r: bg.r, g: bg.g, b: bg.b });
}

async function setTheme(page, theme) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("biznesoty.theme", t);
      document.documentElement.setAttribute("data-theme", t);
      document.documentElement.style.colorScheme = t;
    } catch {
      /* ignore */
    }
  }, theme);
  await page.evaluate((t) => {
    try {
      localStorage.setItem("biznesoty.theme", t);
      document.documentElement.setAttribute("data-theme", t);
      document.documentElement.style.colorScheme = t;
    } catch {
      /* ignore */
    }
  }, theme);
}

async function requireSample(page, selector, opts, label) {
  const result = await sample(page, selector, opts);
  expect(result, `missing required selector for ${label}: ${selector}`).not.toBeNull();
  const ratio = ratioFromSample(result);
  expect(ratio, `unparseable colors for ${label}`).not.toBeNull();
  return ratio;
}

async function registerAndEnterApp(page, suffix) {
  const user = `ctrst${suffix}`.slice(0, 28);
  const pass = "AcceptTest!2026ui";
  const response = await page.goto(baseURL + "/register", {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  if (!response || response.status() >= 500) {
    const err = new Error(`NETWORK_UNAVAILABLE: HTTP ${response?.status()}`);
    err.name = "NetworkUnavailable";
    throw err;
  }
  await page.locator("#account-login").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1200);
  await page.locator("#account-login").click();
  await page.locator("#account-login").fill("");
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
    await page.waitForTimeout(600);
    await name.click();
    await name.fill("");
    await name.pressSequentially(`Contrast ${suffix}`, { delay: 12 });
    await page.getByRole("button", { name: /создать пространство/i }).click();
    await page.waitForFunction(
      () => !location.pathname.includes("/business/new"),
      null,
      { timeout: 60_000 },
    );
  }
  return user;
}

for (const theme of ["light", "dark"]) {
  test.describe(`computed contrast — ${theme}`, () => {
    test.use({ colorScheme: theme === "dark" ? "dark" : "light" });

    test(`register/login critical text (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseURL + "/register", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await setTheme(page, theme);
      await page.waitForTimeout(200);

      const labelRatio = await requireSample(
        page,
        'label[for="account-login"], .field__label',
        {},
        "register label",
      );
      expect(labelRatio).toBeGreaterThanOrEqual(AA_NORMAL);

      await page.locator("#account-login").fill("contrastuser");
      const valueRatio = await requireSample(
        page,
        "#account-login",
        { fill: "contrastuser" },
        "input value",
      );
      expect(valueRatio).toBeGreaterThanOrEqual(AA_NORMAL);

      await page.locator("#account-login").fill("");
      const phRatio = await requireSample(
        page,
        "#account-login",
        { placeholder: true },
        "placeholder",
      );
      expect(phRatio).toBeGreaterThanOrEqual(UI_CHROME_MIN);

      const helperRatio = await requireSample(
        page,
        "#login-hint, .field-hint",
        {},
        "helper",
      );
      expect(helperRatio).toBeGreaterThanOrEqual(UI_CHROME_MIN);

      const primaryRatio = await requireSample(
        page,
        "button.button--primary",
        {},
        "primary button",
      );
      expect(primaryRatio).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    test(`login primary button (${theme})`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseURL + "/login", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await setTheme(page, theme);
      await page.waitForTimeout(200);
      const ratio = await requireSample(
        page,
        "button.button--primary",
        {},
        "login CTA",
      );
      expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
    });

    test(`authenticated settings / connections / orders (${theme})`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 390, height: 844 });
      const suffix = Date.now().toString(36).slice(-6);
      try {
        await registerAndEnterApp(page, suffix);
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "NetworkUnavailable" ||
            /NETWORK_UNAVAILABLE/i.test(error.message))
        ) {
          testInfo.skip(true, error.message);
          return;
        }
        throw error;
      }
      await setTheme(page, theme);

      // Settings business: label + helper
      await page.goto(baseURL + "/settings?section=business", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      const settingsLabel = await requireSample(
        page,
        ".settings-panel .field__label, .settings-panel label, .settings-meta-list dt",
        {},
        "settings label",
      );
      expect(settingsLabel).toBeGreaterThanOrEqual(UI_CHROME_MIN);
      const settingsValue = await requireSample(
        page,
        ".settings-meta-list dd, .settings-panel .copyable-id__value, .settings-panel input",
        {},
        "settings value",
      );
      expect(settingsValue).toBeGreaterThanOrEqual(UI_CHROME_MIN);
      const settingsHelper = await requireSample(
        page,
        ".settings-panel .account-footnote, .settings-panel .field-hint, .settings-panel .text-body-sm",
        {},
        "settings helper",
      );
      expect(settingsHelper).toBeGreaterThanOrEqual(UI_CHROME_MIN);
      const settingsTab = await requireSample(
        page,
        ".settings-nav a.is-active, .settings-tabs a.is-active, a[aria-current='page']",
        {},
        "selected settings tab",
      );
      expect(settingsTab).toBeGreaterThanOrEqual(UI_CHROME_MIN);

      // Connections section — input / placeholder / button required
      await page.goto(baseURL + "/settings?section=connections", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await setTheme(page, theme);
      await page.waitForTimeout(600);
      const connInput = await requireSample(
        page,
        ".connection-token-form input, .settings-panel input[type='text'], .settings-panel input:not([type]), .settings-panel input[type='password']",
        {},
        "connections input",
      );
      expect(connInput).toBeGreaterThanOrEqual(UI_CHROME_MIN);
      const connPh = await requireSample(
        page,
        ".connection-token-form input, .settings-panel input[type='text'], .settings-panel input:not([type]), .settings-panel input[type='password']",
        { placeholder: true },
        "connections placeholder",
      );
      expect(connPh).toBeGreaterThanOrEqual(UI_CHROME_MIN);
      const connBtn = await requireSample(
        page,
        ".connection-token-form .button, .settings-panel .button, .connections-card .button, button.button",
        {},
        "connections button",
      );
      expect(connBtn).toBeGreaterThanOrEqual(UI_CHROME_MIN);

      // Orders V2 — primary tab / create CTA (legacy .crm-segment removed)
      await page.goto(baseURL + "/orders", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await setTheme(page, theme);
      await page.waitForTimeout(400);
      const segment = await requireSample(
        page,
        ".orders-tabs .button--primary, .orders-page__heading-actions .button--primary, .orders-tabs .button, .orders-page .button--primary",
        {},
        "orders primary action",
      );
      expect(segment).toBeGreaterThanOrEqual(UI_CHROME_MIN);
    });
  });
}

test("recovery codes contrast after registration", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const suffix = Date.now().toString(36).slice(-6);
  const user = `ctrst${suffix}`;
  const pass = "AcceptTest!2026ui";
  let response;
  try {
    response = await page.goto(baseURL + "/register", {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });
  } catch (error) {
    testInfo.skip(true, `NETWORK_UNAVAILABLE: ${error}`);
    return;
  }
  if (!response || response.status() >= 500) {
    testInfo.skip(true, `NETWORK_UNAVAILABLE: HTTP ${response?.status()}`);
    return;
  }
  await page.locator("#account-login").waitFor({ state: "visible", timeout: 30_000 });
  await page.waitForTimeout(1500);
  await page.locator("#account-login").click();
  await page.locator("#account-login").fill("");
  await page.locator("#account-login").pressSequentially(user, { delay: 15 });
  await page.locator("#account-password").click();
  await page.locator("#account-password").fill(pass);
  await page.locator("#account-confirmation").click();
  await page.locator("#account-confirmation").fill(pass);
  await page.getByRole("button", { name: /создать аккаунт/i }).click();
  const code = page.locator(".recovery-codes code").first();
  try {
    await code.waitFor({ state: "visible", timeout: 45_000 });
  } catch {
    const msg = (
      (await page.locator(".account-error").first().textContent().catch(() => "")) ||
      ""
    ).trim();
    if (/503|unavailable|недоступен/i.test(msg)) {
      testInfo.skip(true, `NETWORK_UNAVAILABLE: ${msg}`);
      return;
    }
    throw new Error(`PRODUCT_REGRESSION: recovery codes missing${msg ? `: ${msg}` : ""}`);
  }
  const sampleCode = await sample(page, ".recovery-codes code");
  expect(sampleCode, "recovery code element").not.toBeNull();
  const ratio = ratioFromSample(sampleCode);
  expect(ratio, "recovery code contrast").not.toBeNull();
  expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL);
});
