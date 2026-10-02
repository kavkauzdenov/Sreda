/**
 * OSINT §25: провайдеры — VK (официальный API, availability, rate limit),
 * web_page (SSRF-safe загрузка страниц), builtin-реестр (кто участвует в run'е).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createVkProvider } from "../src/server/intelligence/osint/providers/vk.ts";
import { createWebPageProvider } from "../src/server/intelligence/osint/providers/web-page.ts";
import { createBuiltinRegistry } from "../src/server/intelligence/osint/providers/builtin.ts";
import { createRegistry } from "../src/server/intelligence/osint/providers/registry.ts";

delete process.env.OSINT_VK_API_TOKEN;
after(() => delete process.env.OSINT_VK_API_TOKEN);

const QUERY = {
  query: { templateId: "name_city", intent: "any", text: "Кафе Ромашка Барнаул" },
  profile: { name: "Кафе Ромашка" },
  limit: 10,
};

function vkOkFetch(items) {
  return async () => ({
    ok: true,
    status: 200,
    url: "https://api.vk.com/method/groups.search",
    contentType: "application/json",
    body: JSON.stringify({ response: { items } }),
    truncated: false,
    resolvedIp: "1.2.3.4",
    redirects: 0,
  });
}

test("vk provider is unavailable without OSINT_VK_API_TOKEN", async () => {
  const provider = createVkProvider({ token: "" });
  assert.deepEqual(provider.availability(), {
    available: false,
    reason: "osint_vk_token_missing",
  });
  assert.equal(provider.descriptor.policy, "official_api");
  await assert.rejects(
    () => provider.search(QUERY),
    /provider_not_configured/,
    "без токена поиска нет — ошибку получает вызывающий, не пользователь",
  );
});

test("vk provider maps groups.search items to results", async () => {
  const provider = createVkProvider({
    token: "test-token",
    fetchFn: vkOkFetch([
      { id: 1, name: "Кафе Ромашка", screen_name: "romashka_club" },
      { name: "Без идентификатора" },
      { id: 3, screen_name: "club777" },
    ]),
  });
  assert.deepEqual(provider.availability(), { available: true });

  const output = await provider.search(QUERY);
  assert.deepEqual(
    output.results.map((row) => row.url),
    ["https://vk.com/romashka_club", "https://vk.com/club777"],
    "items без screen_name/id пропускаются",
  );
  assert.equal(output.results[0].title, "Кафе Ромашка");
  assert.equal(output.results[0].externalId, "1");
  assert.equal(output.results[0].position, 1);
});

test("vk API errors are surfaced as typed provider errors", async () => {
  const apiError = createVkProvider({
    token: "test-token",
    fetchFn: async () => ({
      ok: true,
      status: 200,
      url: "https://api.vk.com/method/groups.search",
      contentType: "application/json",
      body: JSON.stringify({ error: { error_msg: "Too many requests" } }),
      truncated: false,
      resolvedIp: "1.2.3.4",
      redirects: 0,
    }),
  });
  await assert.rejects(() => apiError.search(QUERY), /vk_api_error:Too many requests/);

  const transportFailed = createVkProvider({
    token: "test-token",
    fetchFn: async () => ({ ok: false, reason: "timeout" }),
  });
  await assert.rejects(() => transportFailed.search(QUERY), /vk_api_timeout/);
});

test("vk rate limit blocks the (per-instance) minute window", async () => {
  const provider = createVkProvider({
    token: "test-token",
    rateLimitPerMinute: 2,
    fetchFn: vkOkFetch([]),
  });
  await provider.search(QUERY);
  await provider.search(QUERY);
  await assert.rejects(() => provider.search(QUERY), /provider_rate_limited/);
});

function htmlDeps(overrides = {}) {
  return {
    lookup: async () => ["93.184.216.34"],
    transport: async () => ({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><head><title>Кафе Ромашка</title></head><body>ok</body></html>",
      truncated: false,
    }),
    ...overrides,
  };
}

test("web_page provider loads HTML and normalizes it into a ParsedPage", async () => {
  const seen = [];
  const provider = createWebPageProvider({
    deps: htmlDeps({
      transport: async (url, init) => {
        seen.push({ url, init });
        return {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: "<html><head><title>Кафе Ромашка</title></head><body>ok</body></html>",
          truncated: false,
        };
      },
    }),
  });

  assert.equal(provider.descriptor.policy, "public_web");
  assert.equal(provider.descriptor.id, "web_page");
  assert.equal(provider.availability, undefined, "page-провайдер всегда доступен");

  const output = await provider.fetchPage({ url: "https://romashka.ru/" });
  assert.equal(output.ok, true);
  assert.equal(output.page.title, "Кафе Ромашка");
  assert.equal(output.page.status, 200);
  assert.deepEqual(
    seen[0].init.acceptContentTypes,
    ["text/html", "application/xhtml+xml", "text/plain"],
    "белый список content-type уходит в транспорт",
  );
});

test("web_page refuses non-HTML content and private networks", async () => {
  const pdf = createWebPageProvider({
    deps: htmlDeps({
      transport: async () => ({
        status: 200,
        headers: { "content-type": "application/pdf" },
        body: "%PDF-1.4",
        truncated: false,
      }),
    }),
  });
  const pdfResult = await pdf.fetchPage({ url: "https://romashka.ru/file" });
  assert.equal(pdfResult.ok, false);
  assert.equal(pdfResult.reason, "unsupported_content_type");

  const leaked = createWebPageProvider({
    deps: {
      lookup: async () => ["127.0.0.1"],
      transport: async () => {
        throw new Error("transport must not be called for private IPs");
      },
    },
  });
  const privateResult = await leaked.fetchPage({ url: "http://localhost:8080/" });
  assert.equal(privateResult.ok, false);
  assert.equal(privateResult.reason, "private_address");
});

test("builtin registry: vk joins the run only with a token, web_page is the crawler", () => {
  const withoutToken = createBuiltinRegistry({ vk: { token: "" } });
  assert.deepEqual(
    withoutToken.descriptorInfo().map((info) => info.descriptor.id),
    ["own_urls", "vk", "web_page"],
  );
  const vkInfo = withoutToken.descriptorInfo().find((info) => info.descriptor.id === "vk");
  assert.deepEqual(vkInfo.availability, {
    available: false,
    reason: "osint_vk_token_missing",
  });

  assert.deepEqual(
    withoutToken.select(null).map((provider) => provider.descriptor.id),
    ["own_urls"],
    "недоступный vk молча исключён из run'а",
  );
  assert.deepEqual(withoutToken.select(["vk"]), [], "явный запрос недоступного — пусто");
  assert.equal(withoutToken.selectPage()?.descriptor.id, "web_page");
  assert.equal(withoutToken.get("web_page"), null, "page-провайдер вне поискового списка");

  const withToken = createBuiltinRegistry({ vk: { token: "t" } });
  assert.deepEqual(
    withToken.select(null).map((provider) => provider.descriptor.id),
    ["own_urls", "vk"],
  );
});

test("registry rejects duplicate ids and filters disabled providers", () => {
  const registry = createRegistry();
  const fake = {
    descriptor: {
      id: "fake",
      label: "Fake",
      types: ["other"],
      intents: ["any"],
      requiresNetwork: false,
      enabledByDefault: true,
      policy: "disabled",
      rateLimitPerMinute: 60,
    },
    async search() {
      return { results: [] };
    },
  };
  registry.register(fake);
  assert.throws(() => registry.register(fake), /already registered/);
  assert.deepEqual(registry.select(null), [], "disabled не участвует по умолчанию");
  assert.deepEqual(
    registry.select(["fake"]),
    [],
    "и явный список не оживляет disabled — политика жёсткая",
  );
});
