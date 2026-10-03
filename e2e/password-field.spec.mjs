/**
 * Password field geometry on the login page (§2 UX gate).
 *
 * Guards the actual regression: the toggle used to be absolutely positioned
 * against a wrapper that also contained the <label>, so `top: 5px` measured from
 * the label's top edge and the 44px button floated ABOVE the input.
 *
 * Asserts geometry, not just presence:
 *   - the button box is vertically centred inside the input box;
 *   - the button sits fully inside the input's horizontal bounds;
 *   - typed text never runs under the button (reserved padding is real);
 *   - toggling visibility does not clear the value;
 *   - the button is keyboard reachable with a visible focus ring.
 *
 * Runs at mobile (390x844) and desktop (1280x900). Must not silently skip when
 * the isolated CI app is healthy.
 */
import { test, expect } from "playwright/test";

const baseURL =
  process.env.E2E_BASE_URL || process.env.AUDIT_BASE_URL || "http://127.0.0.1:3000";

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 900 },
];

const SECRET = "Correct!Horse9Battery";

function boxes(page, inputSelector, toggleSelector) {
  return page.evaluate(
    ([inputSel, toggleSel]) => {
      const input = document.querySelector(inputSel);
      const toggle = document.querySelector(toggleSel);
      if (!input || !toggle) return null;
      const i = input.getBoundingClientRect();
      const t = toggle.getBoundingClientRect();
      const style = getComputedStyle(input);
      return {
        input: { x: i.x, y: i.y, w: i.width, h: i.height, top: i.top, bottom: i.bottom, right: i.right },
        toggle: { x: t.x, y: t.y, w: t.width, h: t.height, top: t.top, bottom: t.bottom, right: t.right, left: t.left },
        paddingRight: parseFloat(style.paddingRight) || 0,
        fontSize: parseFloat(style.fontSize) || 0,
      };
    },
    [inputSelector, toggleSelector],
  );
}

for (const viewport of VIEWPORTS) {
  test.describe(`password toggle · ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("кнопка показа пароля центрирована внутри поля", async ({ page }) => {
      const res = await page.goto(baseURL + "/login", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      expect(res, "страница логина недоступна").not.toBeNull();
      expect(res.status(), `HTTP ${res.status()}`).toBeLessThan(500);

      const input = page.locator("#account-password");
      const toggle = page.getByRole("button", { name: /показать пароль/i });
      await input.waitFor({ state: "visible", timeout: 30_000 });
      await toggle.waitFor({ state: "visible", timeout: 30_000 });

      const b = await boxes(page, "#account-password", 'button[aria-label="Показать пароль"]');
      expect(b, "не удалось измерить геометрию").not.toBeNull();

      // Vertically centred: equal gap above and below, within 2px tolerance.
      const gapAbove = b.toggle.top - b.input.top;
      const gapBelow = b.input.bottom - b.toggle.bottom;
      expect(
        Math.abs(gapAbove - gapBelow),
        `кнопка смещена по вертикали: сверху ${gapAbove.toFixed(1)}, снизу ${gapBelow.toFixed(1)}`,
      ).toBeLessThanOrEqual(2);

      // Fully inside the field horizontally — the original bug put it over the label.
      expect(b.toggle.left, "кнопка выходит за левый край поля").toBeGreaterThanOrEqual(b.input.x - 1);
      expect(b.toggle.right, "кнопка выходит за правый край поля").toBeLessThanOrEqual(b.input.right + 1);

      // The button must not sit on top of the label row.
      const label = await page.locator('label[for="account-password"]').boundingBox();
      if (label) {
        expect(
          b.toggle.top < label.y - 1,
          "кнопка оказалась в строке подписи, а не внутри поля",
        ).toBe(false);
      }
    });

    test("введённый текст не перекрывается кнопкой и переживает переключение", async ({ page }) => {
      await page.goto(baseURL + "/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const input = page.locator("#account-password");
      const toggle = page.getByRole("button", { name: /показать пароль/i });
      await input.waitFor({ state: "visible", timeout: 30_000 });
      await toggle.waitFor({ state: "visible", timeout: 30_000 });

      await input.click();
      await input.fill(SECRET);
      expect(await input.inputValue()).toBe(SECRET);

      const b = await boxes(page, "#account-password", 'button[aria-label="Показать пароль"]');
      // Reserved space on the right must be at least the button's own width.
      expect(
        b.paddingRight,
        `зарезервировано ${b.paddingRight}px, кнопка занимает ${b.toggle.w}px — текст уйдёт под кнопку`,
      ).toBeGreaterThanOrEqual(b.toggle.w);

      // Toggle reveals, keeps the value, and stays inside the field.
      await toggle.click();
      await expect(input).toHaveAttribute("type", "text");
      expect(await input.inputValue(), "значение потерялось при показе пароля").toBe(SECRET);

      const after = await boxes(page, "#account-password", 'button[aria-label="Скрыть пароль"]');
      expect(after.toggle.top, "после переключения кнопка уехала").toBeGreaterThanOrEqual(b.input.top - 1);

      await page.getByRole("button", { name: /скрыть пароль/i }).click();
      await expect(input).toHaveAttribute("type", "password");
      expect(await input.inputValue(), "значение потерялось при скрытии пароля").toBe(SECRET);
    });

    test("кнопка доступна с клавиатуры и имеет видимый фокус", async ({ page }) => {
      await page.goto(baseURL + "/login", { waitUntil: "domcontentloaded", timeout: 60_000 });
      const input = page.locator("#account-password");
      await input.waitFor({ state: "visible", timeout: 30_000 });
      const toggle = page.getByRole("button", { name: /показать пароль/i });
      await toggle.waitFor({ state: "visible", timeout: 30_000 });

      await input.focus();
      await page.keyboard.press("Tab");
      await expect(toggle).toBeFocused();

      const outline = await toggle.evaluate((el) => {
        const s = getComputedStyle(el);
        return { width: s.outlineWidth, style: s.outlineStyle };
      });
      expect(
        outline.style,
        "у кнопки нет видимого фокуса (outline-style: none)",
      ).not.toBe("none");
      expect(parseFloat(outline.width), "толщина контура фокуса = 0").toBeGreaterThan(0);

      // Activated by keyboard, the value survives.
      await input.fill(SECRET);
      await page.keyboard.press("Enter");
      await expect(input).toHaveAttribute("type", "text");
      expect(await input.inputValue()).toBe(SECRET);
    });

    test("страница логина не имеет горизонтального переполнения", async ({ page }) => {
      await page.goto(baseURL + "/login", { waitUntil: "networkidle", timeout: 60_000 });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `горизонтальный скролл ${overflow}px`).toBeLessThanOrEqual(1);
    });
  });
}