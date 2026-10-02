/**
 * OSINT §25: HTML-парсер и нормализация страницы — провенанс каждого поля,
 * лимиты, дедуп ссылок, contentHash, text/plain-ветка.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HTML_PARSER_VERSION,
  decodeEntities,
  parseAttributes,
  parseHtml,
  textOf,
} from "../src/server/intelligence/osint/extraction/html.ts";
import { normalizePage } from "../src/server/intelligence/osint/extraction/page.ts";

test("decodeEntities handles named, numeric and hex entities", () => {
  assert.equal(decodeEntities("Cafe &amp; Bar &lt;b&gt;"), "Cafe & Bar <b>");
  assert.equal(decodeEntities("№&#8470; &#x2116;"), "№№ №");
  assert.equal(decodeEntities("plain &unknown; text"), "plain &unknown; text");
});

test("parseAttributes tolerates quoting styles and unquoted values", () => {
  const attrs = parseAttributes(
    ` rel="canonical" href='/path' data-x=raw target = "_blank"`,
  );
  assert.equal(attrs.rel, "canonical");
  assert.equal(attrs.href, "/path");
  assert.equal(attrs["data-x"], "raw");
  assert.equal(attrs.target, "_blank");
});

test("parseHtml extracts title, meta, canonical, base, lang, links and JSON-LD", () => {
  const html = `
    <!doctype html>
    <!-- комментарий с <title>не должен попасть</title> -->
    <html lang="ru">
      <head>
        <base href="https://example.com/sub/">
        <title>Кафе &amp; Ромашка</title>
        <meta name="description" content="Уютное кафе в Барнауле">
        <meta property="og:title" content="Romashka">
        <link rel="canonical" href="/canonical-page">
        <link rel="me" href="https://vk.com/romashka_club">
        <script type="application/ld+json">
          {"@type":"LocalBusiness","name":"Кафе Ромашка","url":"https://romashka.ru/",
           "sameAs":["https://vk.com/romashka_club"],"telephone":"+7 3852 55-10-10",
           "email":"hi@romashka.ru"}
        </script>
        <script type="application/ld+json">{ broken json }</script>
      </head>
      <body>
        <style>.x { color: red }</style>
        <h1>Кафе Ромашка</h1>
        <p>Телефон: 8 (3852) 55-10-10, почта sales@romashka.ru</p>
        <a href="/about">О нас</a>
        <a href="https://other.example/dir">Внешняя</a>
        <a href="/icon"><svg/></a>
      </body>
    </html>`;
  const parsed = parseHtml(html);

  assert.equal(parsed.parserVersion, HTML_PARSER_VERSION);
  assert.equal(parsed.title, "Кафе & Ромашка");
  assert.equal(parsed.description, "Уютное кафе в Барнауле");
  assert.equal(parsed.canonical, "/canonical-page");
  assert.equal(parsed.baseUrl, "https://example.com/sub/");
  assert.equal(parsed.language, "ru");

  const metas = new Map(parsed.meta.map((entry) => [entry.key, entry.value]));
  assert.equal(metas.get("og:title"), "Romashka");

  assert.equal(parsed.jsonLd.length, 1, "битый JSON-LD пропускается целиком");
  assert.deepEqual(parsed.jsonLd[0].types, ["localbusiness"]);

  const hrefs = parsed.links.map((link) => link.href);
  assert.ok(hrefs.includes("/about"));
  assert.ok(hrefs.includes("https://other.example/dir"));
  assert.ok(hrefs.includes("/canonical-page"), "canonical попадает в ссылки");
  const icon = parsed.links.find((link) => link.href === "/icon");
  assert.equal(icon.textPresent, false, "иконочная ссылка без текста");

  assert.ok(parsed.text.includes("Кафе Ромашка"));
  assert.ok(!parsed.text.includes("color: red"), "style вырезан из текста");
  assert.equal(textOf("  a <b>b</b>  "), "a b");
});

const HTML_PAGE = `<!doctype html>
<html lang="ru">
<head>
  <title>Кафе Ромашка — официальный сайт</title>
  <meta name="description" content="Кафе в Барнауле, ул. Ленина">
  <link rel="canonical" href="https://romashka.ru/main">
  <script type="application/ld+json">
    {"@type":"LocalBusiness","name":"Кафе Ромашка","url":"https://romashka.ru/",
     "sameAs":["https://vk.com/romashka_club","https://instagram.com/romashka"]}
  </script>
</head>
<body>
  <h1>Кафе Ромашка</h1>
  <p>Мы на улице Ленина. Телефон 8 (3852) 55-10-10 и мы открыты с 9 до 21.</p>
  <p>Почта: hello@romashka.ru</p>
  <a href="/menu">Меню</a>
  <a href="https://romashka.ru/menu">Меню ещё раз</a>
  <a href="https://vk.com/romashka_club">ВКонтакте</a>
</body>
</html>`;

function pageInput(overrides = {}) {
  return {
    requestedUrl: "https://romashka.ru/",
    finalUrl: "https://romashka.ru/",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: HTML_PAGE,
    ...overrides,
  };
}

test("normalizePage assigns an origin to every extracted field", () => {
  const page = normalizePage(pageInput());

  assert.equal(page.type, "html");
  assert.equal(page.parserVersion, HTML_PARSER_VERSION);
  assert.equal(page.title, "Кафе Ромашка — официальный сайт");
  assert.equal(page.description, "Кафе в Барнауле, ул. Ленина");
  assert.equal(page.canonicalUrl, "https://romashka.ru/main");
  assert.equal(page.language, "ru");
  assert.equal(page.status, 200);
  assert.equal(page.contentHash.length, 64, "sha256 материала");
  assert.ok(page.textLength > page.text.length || page.textLength >= 0);

  // Дедуп ссылок: /menu встречается дважды, но по двум разным URL
  // (относительный и абсолютный нормализуются в один).
  const menuUrls = page.links.filter((link) => link.url === "https://romashka.ru/menu");
  assert.equal(menuUrls.length, 1, "нормализованный URL не дублируется");
  assert.ok(page.links.some((link) => link.origin === "canonical_link"));
  assert.ok(page.links.some((link) => link.origin === "anchor"));
  assert.ok(page.links.some((link) => link.origin === "jsonld_url"));

  const phone = page.contacts.find((contact) => contact.kind === "phone");
  assert.ok(phone, "телефон извлечён из текста");
  assert.equal(phone.origin, "visible_text");
  const email = page.contacts.find((contact) => contact.kind === "email");
  assert.ok(email, "email извлечён из текста");

  assert.ok(page.domains.some((entry) => entry.domain === "romashka.ru"));
  assert.ok(page.sameAs.includes("https://vk.com/romashka_club"));
  assert.equal(page.structured[0].types.includes("localbusiness"), true);
});

test("contentHash changes when the page material changes", () => {
  const first = normalizePage(pageInput());
  const second = normalizePage(pageInput({ body: HTML_PAGE.replace("Ленина", "Ленина, 10") }));
  const repeat = normalizePage(pageInput());
  assert.equal(first.contentHash, repeat.contentHash, "детерминирована");
  assert.notEqual(first.contentHash, second.contentHash, "иначе — новый hash");
});

test("text/plain body becomes a typed text page without links", () => {
  const page = normalizePage(
    pageInput({
      contentType: "text/plain",
      body: "Кафе Ромашка\nГород: Барнаул\nСайт: https://romashka.ru",
    }),
  );
  assert.equal(page.type, "text");
  assert.equal(page.title, "Кафе Ромашка", "первая строка — заголовок");
  assert.equal(page.links.length, 0, "текст не разбирается на ссылки");
  assert.equal(page.canonicalUrl, null);
  assert.ok(page.text.includes("Барнаул"));
});

test("truncate options bound text and links", () => {
  const page = normalizePage(pageInput({ maxTextLength: 10, maxLinks: 2 }));
  assert.equal(page.text.length, 10);
  assert.ok(page.textLength > 10, "полная длина сохранена");
  assert.ok(page.links.length <= 2);
});

test("og: fallbacks kick in when the plain tags are missing", () => {
  const page = normalizePage(
    pageInput({
      body: `<!doctype html><html><head>
        <meta property="og:title" content="Romashka OG">
        <meta property="og:description" content="Описание из OG">
      </head><body>x</body></html>`,
    }),
  );
  assert.equal(page.title, "Romashka OG");
  assert.equal(page.description, "Описание из OG");
});
