/**
 * OSINT §25: crawl-фаза discovery на PGlite — очередь, бюджеты, follow-политика,
 * дедуп/циклы, robots, отказы провайдеров, конкурентный claim, resume,
 * провенанс (наблюдения/контекст источника) и статусы run'а.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  followAllowed,
  followDomainsFor,
  runCrawl,
} from "../src/server/intelligence/osint/crawl.ts";
import {
  createDiscoveryRun,
  runDiscovery,
} from "../src/server/intelligence/osint/discovery.ts";
import { mergeDiscoveryBudget } from "../src/server/intelligence/osint/config.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { createRegistry } from "../src/server/intelligence/osint/providers/registry.ts";
import { createMockProvider } from "../src/server/intelligence/osint/providers/mock.ts";
import { normalizePage } from "../src/server/intelligence/osint/extraction/page.ts";
import { createRobotsChecker } from "../src/server/intelligence/osint/robots.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description: "Кафе Ромашка — уютное кафе.\nСайт: https://owner.example/",
  industry: "food",
});

function html(title, body, links = []) {
  const anchors = links.map((href) => `<a href="${href}">ссылка</a>`).join("");
  return `<!doctype html><html><head><title>${title}</title>
<meta name="description" content="Кафе в Барнауле"></head>
<body><p>${body}</p>${anchors}</body></html>`;
}

/** Page-провайдер над фикстурой сайта; без сети, с журналом вызовов. */
function fixtureSite(pages) {
  const calls = [];
  return {
    calls,
    descriptor: {
      id: "fixture_page",
      label: "Fixture",
      types: ["website"],
      intents: ["any"],
      requiresNetwork: true,
      enabledByDefault: true,
      policy: "public_web",
      rateLimitPerMinute: 60,
    },
    async fetchPage(input) {
      calls.push(input.url);
      const entry = pages[input.url];
      if (!entry) return { ok: false, reason: "http_error", detail: "404" };
      if (entry.fail) return { ok: false, reason: entry.fail };
      return {
        ok: true,
        page: normalizePage({
          requestedUrl: input.url,
          finalUrl: input.url,
          status: 200,
          contentType: "text/html",
          body: entry.body,
        }),
      };
    },
  };
}

async function makeUser(name = "User") {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      public_id: "usr_" + id.replaceAll("-", "").slice(0, 16),
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

async function makeBusiness(ownerId, name) {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      timezone: "Europe/Moscow",
      description: "Кафе Ромашка — уютное кафе.\nСайт: https://owner.example/",
      industry: "food",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({ business_id: row.id, user_id: ownerId, role: "owner", status: "active" })
    .execute();
  return row;
}

let ownerId;
before(async () => {
  ownerId = await makeUser("Crawl Owner");
});

/** Run в статусе queued с seed'ами в очереди (как enqueueDiscovery). */
async function makeRun(businessId, seedUrls, budgetInput = {}) {
  return createDiscoveryRun(db, {
    businessId,
    registry: createRegistry(),
    budget: budgetInput,
    profile: PROFILE,
    crawl: true,
    explicitSeeds: seedUrls.map((url) => ({
      url,
      reason: "explicit",
      priority: 110,
    })),
  });
}

async function queueRows(runId) {
  return db
    .selectFrom("osint_crawl_queue")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("depth", "asc")
    .orderBy("url", "asc")
    .execute();
}

const statusCount = (rows, status) =>
  rows.filter((row) => row.status === status).length;

test("crawl walks allowed domains, keeps provenance and skips strangers", async () => {
  const business = await makeBusiness(ownerId, "Crawl Happy");
  const site = fixtureSite({
    "https://owner.example/": {
      body: html(
        "Кафе Ромашка — официальный сайт",
        "Кафе в Барнауле. Телефон 8 (3852) 55-10-10 и мы открыты с 9 до 21.",
        [
          "https://owner.example/about",
          "https://owner.example/menu",
          "https://other.example/prices",
          "https://vk.com/romashka_club",
        ],
      ),
    },
    "https://owner.example/about": {
      body: html("О нас — Кафе Ромашка", "Наша команда."),
    },
    "https://owner.example/menu": {
      body: html("Меню — Кафе Ромашка", "Кофе и выпечка."),
    },
    "https://other.example/prices": {
      body: html("Чужой сайт", "не должен загружаться"),
    },
  });

  const created = await makeRun(business.id, ["https://owner.example/"]);
  const budget = mergeDiscoveryBudget({});
  const stats = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget,
      pageProvider: site,
      followDomains: followDomainsFor(PROFILE, ["https://owner.example/"]),
      followSocialLinks: PROFILE.knownSocialLinks,
      robots: null,
    },
  });

  assert.equal(stats.seeds, 1);
  assert.equal(stats.fetched, 3, "владелец + две внутренние страницы");
  assert.equal(stats.failed, 0);
  assert.equal(stats.linksDiscovered, 2, "чужой домен и соцсеть не тронуты");
  assert.equal(stats.depthReached, 1);
  assert.deepEqual(stats.budgetHits, []);
  assert.ok(
    !site.calls.includes("https://other.example/prices"),
    "чужой сайт не запрашивался",
  );
  assert.ok(
    !site.calls.includes("https://vk.com/romashka_club"),
    "соцсеть вне профиля не запрашивалась",
  );

  const rows = await queueRows(created.runId);
  assert.equal(rows.length, 3, "дедуп по normalized_url: циклов нет");
  assert.equal(statusCount(rows, "fetched"), 3);
  assert.equal(statusCount(rows, "queued"), 0);
  for (const row of rows) {
    assert.ok(row.http_status === 200, `${row.url} http_status`);
    assert.ok(row.from_url === null || row.from_url === "https://owner.example/");
  }

  const candidates = await db
    .selectFrom("osint_source_candidates")
    .selectAll()
    .where("discovery_run_id", "=", created.runId)
    .execute();
  assert.equal(candidates.length, 3);
  const own = candidates.find((row) => row.normalized_url === "https://owner.example/");
  assert.equal(own.status, "accepted", "домен владельца принимается правилом domain_exact");

  const observation = await db
    .selectFrom("osint_observations")
    .selectAll()
    .where("source_id", "in", (eb) =>
      eb
        .selectFrom("osint_entity_sources")
        .select("source_id")
        .where("entity_id", "=", own.entity_id),
    )
    .where("content", "like", "%Телефон%")
    .executeTakeFirst();
  assert.ok(observation, "принятый кандидат дал наблюдение");
  assert.equal(observation.kind, "page");
  assert.match(observation.content, /Кафе в Барнауле/, "тело страницы в content");
  const metadata = JSON.parse(JSON.stringify(observation.metadata));
  assert.equal(metadata.provider, "fixture_page");
  assert.equal(metadata.depth, 0);
  assert.equal(metadata.http_status, 200);
  assert.equal(metadata.parser_version, "html-v1");

  const sourceId = (
    await db
      .selectFrom("osint_entity_sources")
      .select("source_id")
      .where("entity_id", "=", own.entity_id)
      .executeTakeFirstOrThrow()
  ).source_id;
  const context = await db
    .selectFrom("osint_source_context")
    .selectAll()
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
  assert.ok(context, "контекст источника создан");
  assert.equal(context.description, "Кафе в Барнауле");
  const domains = JSON.parse(JSON.stringify(context.domains));
  assert.ok(domains.includes("owner.example"), JSON.stringify(domains));
  assert.ok(domains.includes("vk.com"), "домены всех ссылок страницы сохранены");
  const social = JSON.parse(JSON.stringify(context.social_links));
  assert.deepEqual(social, { urls: ["https://vk.com/romashka_club"] });
});

test("followAllowed and followDomainsFor implement the §25 follow policy", () => {
  const options = {
    followDomains: followDomainsFor(PROFILE, ["https://seed.example/page"]),
    followSocialLinks: ["https://vk.com/romashka_club"],
  };
  assert.deepEqual(options.followDomains.sort(), ["owner.example", "seed.example"]);
  assert.equal(followAllowed("https://owner.example/x", options), true);
  assert.equal(followAllowed("https://sub.owner.example/x", options), true);
  assert.equal(followAllowed("https://seed.example/deep", options), true);
  assert.equal(followAllowed("https://evil.example/", options), false, "чужой сайт закрыт");
  assert.equal(followAllowed("https://vk.com/romashka_club", options), true, "хост соцсети профиля");
  assert.equal(
    followAllowed("https://vk.com/other_club", options),
    true,
    "политика §25 — по хосту соцсети, не по точной ссылке",
  );
  assert.equal(followAllowed("https://t.me/some_channel", options), false, "хост вне профиля закрыт");
  assert.equal(followAllowed("ftp://owner.example/", options), false, "не http/https");

  // IP/localhost: registrable-домена нет, ключ — сам хост (E2E на фикстуре).
  const ipOptions = {
    followDomains: followDomainsFor(PROFILE, ["http://127.0.0.1:8080/"]),
    followSocialLinks: [],
  };
  assert.ok(ipOptions.followDomains.includes("127.0.0.1"));
  assert.equal(followAllowed("http://127.0.0.1:8080/about", ipOptions), true);
  assert.equal(
    followAllowed("http://127.0.0.1:9999/about", ipOptions),
    true,
    "normalizeUrl отбрасывает порт — IP-обход host-уровневый",
  );
  assert.equal(followAllowed("http://10.0.0.5/about", ipOptions), false);
});

test("maxDepth 0 fetches seeds only and never enqueues links", async () => {
  const business = await makeBusiness(ownerId, "Crawl Depth");
  const site = fixtureSite({
    "https://owner.example/": {
      body: html("Кафе Ромашка", "дом", ["https://owner.example/about"]),
    },
    "https://owner.example/about": { body: html("О нас", "страница") },
  });
  const created = await makeRun(business.id, ["https://owner.example/"]);
  const stats = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({ maxDepth: 0 }),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots: null,
    },
  });
  assert.equal(stats.fetched, 1);
  assert.equal(stats.linksDiscovered, 0);
  assert.equal((await queueRows(created.runId)).length, 1);
});

test("cycles do not multiply the queue; a second crawl run is a no-op", async () => {
  const business = await makeBusiness(ownerId, "Crawl Cycle");
  const site = fixtureSite({
    "https://owner.example/": {
      body: html("Кафе Ромашка", "сам на себя", [
        "https://owner.example/",
        "https://owner.example/about",
      ]),
    },
    "https://owner.example/about": {
      body: html("О нас", "назад", ["https://owner.example/"]),
    },
  });
  const created = await makeRun(business.id, ["https://owner.example/"]);
  const options = {
    budget: mergeDiscoveryBudget({}),
    pageProvider: site,
    followDomains: ["owner.example"],
    followSocialLinks: [],
    robots: null,
  };
  const first = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options,
  });
  assert.equal(first.fetched, 2, "каждая страница ровно один раз");
  assert.equal(new Set(site.calls).size, site.calls.length, "повторных загрузок нет");
  assert.equal((await queueRows(created.runId)).length, 2, "UNIQUE(run_id, normalized_url)");

  const callsBefore = site.calls.length;
  const second = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options,
  });
  assert.equal(second.fetched, 0, "очередь пуста — повторный запуск ничего не делает");
  assert.equal(site.calls.length, callsBefore);
});

test("page and request budgets cut the crawl and are recorded as budgetHits", async () => {
  const business = await makeBusiness(ownerId, "Crawl Budget");
  const urls = [
    "https://owner.example/",
    "https://owner.example/about",
    "https://owner.example/menu",
  ];
  const site = fixtureSite(
    Object.fromEntries(urls.map((url) => [url, { body: html("Кафе Ромашка", "текст") }])),
  );

  const pagesRun = await makeRun(business.id, urls, { maxPages: 1 });
  const pageStats = await runCrawl(db, {
    businessId: business.id,
    runId: pagesRun.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({ maxPages: 1 }),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots: null,
    },
  });
  assert.equal(pageStats.fetched, 1);
  assert.equal(pageStats.skipped, 2);
  assert.deepEqual(pageStats.budgetHits, ["budget_pages"]);
  const pageRows = await queueRows(pagesRun.runId);
  assert.equal(statusCount(pageRows, "skipped"), 2);
  assert.equal(
    pageRows.filter((row) => row.skip_reason === "budget_pages").length,
    2,
    "остаток очереди погашен, а не брошен",
  );

  const requestsRun = await makeRun(business.id, urls, { maxRequests: 1, maxPages: 5 });
  const requestStats = await runCrawl(db, {
    businessId: business.id,
    runId: requestsRun.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({ maxRequests: 1, maxPages: 5 }),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots: null,
    },
  });
  assert.equal(requestStats.fetched, 1);
  assert.equal(requestStats.requestsUsed, 1);
  assert.equal(requestStats.skipped, 2);
  assert.ok(requestStats.budgetHits.includes("budget_requests"));
});

test("robots.txt disallows are honoured and counted against the request budget", async () => {
  const business = await makeBusiness(ownerId, "Crawl Robots");
  const site = fixtureSite({
    "https://owner.example/": { body: html("Кафе Ромашка", "главная") },
    "https://owner.example/secret": { body: html("Секрет", "не для ботов") },
  });
  const robots = createRobotsChecker({
    fetchFn: async (url) => ({
      ok: true,
      status: 200,
      url,
      contentType: "text/plain",
      body: "User-agent: *\nDisallow: /secret",
      truncated: false,
      resolvedIp: "1.2.3.4",
      redirects: 0,
    }),
  });
  const created = await makeRun(business.id, [
    "https://owner.example/",
    "https://owner.example/secret",
  ]);
  const stats = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({}),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots,
    },
  });
  assert.equal(stats.fetched, 1);
  assert.equal(stats.skipped, 1);
  assert.ok(stats.robotsFetched >= 1, "robots.txt хотя бы один раз загружен");
  assert.equal(
    stats.requestsUsed,
    stats.robotsFetched + stats.fetched,
    "бюджет запросов = robots + страницы",
  );

  const rows = await queueRows(created.runId);
  const blocked = rows.find((row) => row.url === "https://owner.example/secret");
  assert.equal(blocked.status, "skipped");
  assert.equal(blocked.skip_reason, "robots_disallowed");
  assert.equal(blocked.error, "/secret", "паттерн robots сохранён для отчёта");
  assert.ok(site.calls.every((url) => !url.endsWith("/secret")), "запрещённый URL не запрашивался");
});

test("provider failures map to failed/partial run statuses", async () => {
  // Свежий бизнес на каждый run: сиды собираются при CREATE, а мост
  // бизнес→общая сущность появляется только при execute — иначе прежние
  // источники того же домена протекали бы в seeds нового run'а.
  const deadBusiness = await makeBusiness(ownerId, "Crawl Failures Dead");
  const halfBusiness = await makeBusiness(ownerId, "Crawl Failures Half");
  const aliveBusiness = await makeBusiness(ownerId, "Crawl Failures Alive");
  const search = () => createMockProvider({ id: "mock_search", respond: () => [] });
  const base = (businessId) => ({
    businessId,
    userId: ownerId,
    profile: PROFILE,
    seeds: [{ url: "https://owner.example/", reason: "explicit", priority: 110 }],
  });

  const allDead = await runDiscovery(db, {
    ...base(deadBusiness.id),
    registry: createRegistry([search()], [fixtureSite({})]),
    crawl: {},
  });
  assert.equal(allDead.status, "failed", "ни одной страницы — hardFail");
  assert.ok(allDead.errors.some((value) => value.startsWith("fetch:")));

  const halfAlive = await runDiscovery(db, {
    ...base(halfBusiness.id),
    registry: createRegistry(
      [search()],
      [
        fixtureSite({
          "https://owner.example/": { body: html("Кафе Ромашка", "живая") },
          "https://owner.example/about": { fail: "http_error" },
        }),
      ],
    ),
    crawl: {},
    seeds: [
      { url: "https://owner.example/", reason: "explicit", priority: 110 },
      { url: "https://owner.example/about", reason: "explicit", priority: 110 },
    ],
  });
  assert.equal(halfAlive.status, "partial", "есть и успехи, и отказы — partial");

  const alive = await runDiscovery(db, {
    ...base(aliveBusiness.id),
    registry: createRegistry(
      [search()],
      [
        fixtureSite({
          "https://owner.example/": { body: html("Кафе Ромашка", "живая") },
          "https://owner.example/about": { body: html("О нас", "живая") },
        }),
      ],
    ),
    crawl: {},
  });
  assert.equal(alive.status, "completed", JSON.stringify(alive.errors));
  const runRow = await db
    .selectFrom("osint_discovery_runs")
    .select(["stats", "status"])
    .where("id", "=", alive.runId)
    .executeTakeFirstOrThrow();
  assert.equal(runRow.status, "completed");
  const crawlStats = JSON.parse(JSON.stringify(runRow.stats)).crawl;
  assert.equal(crawlStats.fetched, 1, "crawl-статистика лежит в stats.run'а");
});

test("an aborted signal drains the queue as skipped, not failed", async () => {
  const business = await makeBusiness(ownerId, "Crawl Abort");
  const site = fixtureSite({
    "https://owner.example/": { body: html("Кафе Ромашка", "страница") },
  });
  const created = await makeRun(business.id, [
    "https://owner.example/",
    "https://owner.example/about",
  ]);
  const controller = new AbortController();
  controller.abort(new Error("test_abort"));
  const stats = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({}),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots: null,
      signal: controller.signal,
    },
  });
  assert.equal(site.calls.length, 0, "после abort сеть не трогается");
  assert.equal(stats.fetched, 0);
  assert.equal(stats.failed, 0);
  assert.equal(stats.skipped, 2);
  const rows = await queueRows(created.runId);
  assert.equal(statusCount(rows, "skipped"), 2);
  assert.ok(rows.every((row) => row.skip_reason === "aborted"));
});

test("two concurrent crawls claim disjoint rows — every URL fetched once", async () => {
  const business = await makeBusiness(ownerId, "Crawl Concurrency");
  const urls = Array.from(
    { length: 6 },
    (_, index) => `https://owner.example/page-${index}`,
  );
  const site = fixtureSite(
    Object.fromEntries([
      ["https://owner.example/", { body: html("Кафе Ромашка", "дом") }],
      ...urls.map((url) => [url, { body: html("Кафе Ромашка", "страница") }]),
    ]),
  );
  const created = await makeRun(business.id, ["https://owner.example/", ...urls]);
  const options = {
    budget: mergeDiscoveryBudget({ maxConcurrency: 2 }),
    pageProvider: site,
    followDomains: ["owner.example"],
    followSocialLinks: [],
    robots: null,
  };
  const input = {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options,
  };
  const [first, second] = await Promise.all([runCrawl(db, input), runCrawl(db, input)]);

  const totals = first.fetched + second.fetched;
  assert.equal(totals, 7, "страница загружается ровно один раз на двух воркерах");
  assert.equal(new Set(site.calls).size, site.calls.length, "нет двойных загрузок");
  const rows = await queueRows(created.runId);
  assert.equal(statusCount(rows, "fetched"), 7);
  assert.equal(statusCount(rows, "queued"), 0);
});

test("a row stuck in fetching is not retried; queued rows continue", async () => {
  const business = await makeBusiness(ownerId, "Crawl Resume");
  const site = fixtureSite({
    "https://owner.example/": { body: html("Кафе Ромашка", "дом") },
    "https://owner.example/about": { body: html("О нас", "страница") },
  });
  const created = await makeRun(business.id, [
    "https://owner.example/",
    "https://owner.example/about",
  ]);
  await db
    .updateTable("osint_crawl_queue")
    .set({ status: "fetching", attempts: 1, updated_at: new Date() })
    .where("run_id", "=", created.runId)
    .where("url", "=", "https://owner.example/about")
    .execute();

  const stats = await runCrawl(db, {
    businessId: business.id,
    runId: created.runId,
    entityId: null,
    profile: PROFILE,
    seeds: null,
    options: {
      budget: mergeDiscoveryBudget({}),
      pageProvider: site,
      followDomains: ["owner.example"],
      followSocialLinks: [],
      robots: null,
    },
  });
  assert.equal(stats.fetched, 1, "только queued-строки claim'ятся");
  assert.ok(!site.calls.includes("https://owner.example/about"), "чужой claim не трогаем");

  const stuck = (await queueRows(created.runId)).find(
    (row) => row.url === "https://owner.example/about",
  );
  assert.equal(stuck.status, "fetching");
  assert.equal(stuck.attempts, 1, "attempts воркера-призрака не тронуты");
});
