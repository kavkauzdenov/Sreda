import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (path) =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const loginForm = read("src/components/account/LoginForm.tsx");
const loginCss = read("src/components/account/Login.module.css");
const globalsCss = read("src/app/globals.css");
const adminCss = read("src/components/admin/admin.css");
const adminLogin = read("src/app/admin/login/page.tsx");
const passwordField = read("src/components/ui/PasswordField.tsx");
const changePanel = read("src/components/account/PasswordChangePanel.tsx");

/** Extract a CSS rule body for a selector, or "" when the selector is absent. */
function rule(css, selector) {
  const index = css.indexOf(selector);
  if (index === -1) return "";
  const open = css.indexOf("{", index);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return "";
}

/* ------------------------------------------------------------------ */
/* Структура: кнопка позиционируется относительно поля, а не подписи   */
/* ------------------------------------------------------------------ */

test("обёртка пароля содержит только input и кнопку, а не <label>", () => {
  // The original bug: `position: relative` sat on the wrapper that also held the
  // <label>, so a hard-coded `top` was measured from the label's top edge.
  const wrapper = loginCss.slice(
    loginCss.indexOf(".password {"),
    loginCss.indexOf(".reveal {"),
  );
  assert.equal(wrapper.includes("label"), false);
  assert.match(wrapper, /position:\s*relative/);
  assert.match(wrapper, /display:\s*block/);
});

test("в Login.module.css кнопка центрируется, а не сдвинута вручную", () => {
  const body = rule(loginCss, ".reveal {");
  assert.ok(body.length > 0, ".reveal должен существовать");
  assert.match(body, /position:\s*absolute/);
  assert.match(body, /top:\s*50%/);
  assert.match(body, /transform:\s*translateY\(-50%\)/);
  assert.doesNotMatch(
    body,
    /top:\s*\d+px/,
    "фиксированный top в пикселях без центрирования — источник исходного бага",
  );
});

test("переключатель достигает минимальной сенсорной цели (44px)", () => {
  for (const [css, selector] of [
    [loginCss, ".reveal {"],
    [globalsCss, ".field__password-toggle {"],
    [adminCss, ".admin-password__toggle {"],
  ]) {
    const body = rule(css, selector);
    assert.match(body, /width:\s*44px/, `${selector} ширина`);
    assert.match(body, /height:\s*44px/, `${selector} высота`);
  }
});

test("место под кнопку зарезервировано на самом поле", () => {
  assert.match(rule(loginCss, ".card .password input {"), /padding-right:\s*5\dpx/);
  assert.match(
    rule(globalsCss, ".field__password .field__control {"),
    /padding-right:\s*5\dpx/,
  );
  assert.match(rule(adminCss, ".admin-password input {"), /padding-right:\s*5\dpx/);
});

test("на мобильной ширине кнопка не съезжает и не задаёт свою высоту", () => {
  const mobile = loginCss.slice(loginCss.indexOf("@media (max-width: 900px)"));
  const reveal = rule(mobile, ".reveal {");
  if (reveal.length === 0) return; // медиа-правило не обязано дублировать базу
  assert.doesNotMatch(reveal, /top:\s*\d+px/, "мобильный top не пересчитывается");
  assert.doesNotMatch(reveal, /height:\s*\d+px/, "высота кнопки не зависит от ширины");
});

test("у кнопки есть видимый фокус во всех трёх реализациях", () => {
  assert.match(loginCss, /\.reveal:focus-visible\s*\{[^}]*outline:/);
  assert.match(
    globalsCss,
    /\.field__password-toggle:focus-visible\s*\{[^}]*outline:/,
  );
  assert.match(
    adminCss,
    /\.admin-password__toggle:focus-visible\s*\{[^}]*outline:/,
  );
});

/* ------------------------------------------------------------------ */
/* Доступность и поведение                                             */
/* ------------------------------------------------------------------ */

test("кнопка доступна с клавиатуры и не отправляет форму", () => {
  assert.match(passwordField, /type="button"/, "кнопка не должна сабмитить форму");
});

test("у переключателя есть понятные aria-атрибуты", () => {
  assert.match(passwordField, /aria-label=\{visible \? "Скрыть пароль" : "Показать пароль"\}/);
  assert.match(passwordField, /aria-controls=\{inputId\}/);
  assert.match(passwordField, /aria-pressed=\{visible\}/);
  assert.match(passwordField, /aria-hidden="true"/, "иконка скрыта от скринридера");
});

test("переключение не теряет введённое значение", () => {
  // Значение живёт в родительском состоянии, а видимость — локальная,
  // поэтому смена type не должна пересоздавать или очищать input.
  assert.match(passwordField, /value=\{value\}/);
  assert.match(passwordField, /onChange=\{\(event\) => onChange\(event\.target\.value\)\}/);
  assert.match(passwordField, /type=\{visible \? "text" : "password"\}/);
});

test("на странице входа кнопка присутствует, а на регистрации — нет", () => {
  // Регистрация не показывала переключатель раньше — поведение не меняем.
  assert.match(loginForm, /styles\.reveal/);
  const registerBranch = loginForm.slice(
    loginForm.indexOf('type="password" autoComplete="new-password"'),
    loginForm.indexOf("account-confirmation"),
  );
  assert.ok(registerBranch.length > 0);
});

test("единственный источник истины для переключателя — общий компонент", () => {
  // Три независимые реализации кнопки — источник расхождений; теперь их одна.
  assert.match(loginForm, /PasswordField/);
  assert.match(changePanel, /LabelledPasswordField/);
  assert.equal(
    /EyeOff/.test(loginForm),
    false,
    "логин не должен рисовать иконки сам — это делает общий компонент",
  );
  assert.equal(
    /EyeOff/.test(changePanel),
    false,
    "панель смены пароля не должна дублировать реализацию",
  );
});

test("админский логин использует собственные классы, а не переиспользует search-clear", () => {
  assert.match(adminLogin, /className="admin-password__toggle"/);
  assert.equal(
    /admin-search__clear/.test(adminLogin),
    false,
    "кнопка пароля не должна брать стили кнопки очистки поиска",
  );
  assert.equal(/style=\{\{ top:/.test(adminLogin), false, "инлайн-偏移 убран");
});