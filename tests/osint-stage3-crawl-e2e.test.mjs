/**
 * OSINT §25 E2E: полный путь на реальном HTTP — OsintService → discovery →
 * очередь → SSRF-safe fetch (node:http фикстура на 127.0.0.1) → парсинг →
 * кандидаты/источники/наблюдения → статус run'а. Отдельно: тот же путь БЕЗ
 * allowPrivateNetworks упирается в SSRF-guard (private_address), а robots.txt
 * фикстуры реально отсекает /contacts.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import { createBuiltinRegistry } from "../src/server/intelligence/osint/providers/builtin.ts";
import { createRobotsChecker } from "../src/server/intelligence/osint/robots.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PHONE_LINE = "Телефон: 8 (3852) 55-10-10 и мы открыты с 9 до 21.";
const HOME_MARKER = "E2E_HOME_MARKER";

function page(title, body, links = []) {
  const anchors = links.map((href) => `<a href="${href}">ссылка</a>`).join("");
  return `<!doctype html><html lang="ru"><head><title>${title}</title>
<meta name="description" content="E2E страница"></head>
<body><p>${body}</p>${anchors}</body></html>`;
}

let server;
let origin;
const hits = [];

before(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url, "http://127.0.0.1").pathname;
    hits.push(path);
    const send = (status, type, body) => {
      response.writeHead(status, { "content-type": type });
      response.end(body);
    };
    if (path === "/robots.txt")
      return send(200, "text/plain", "User-agent: *\nDisallow: /contacts");
    if (path === "/")
      return send(
        200,
        "text/html; charset=utf-8",
        page(
          "Кафе Е2е — официальный сайт",
          `${HOME_MARKER}. Город: Барнаул. ${PHONE_LINE}`,
          [`${origin}/about`, `${origin}/contacts`, "https://other.example/prices"],
        ),
      );
    if (path === "/about")
      return send(
        200,
        "text/html; charset=utf-8",
        page("О нас — Кафе Е2е", `Команда из Барнаула. ${PHONE_LINE}`),
      );
    if (path === "/contacts")
      return send(200, "text/html; charset=utf-8", page("Контакты", "Секция для ботов закрыта."));
    return send(404, "text/plain", "not found");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function makeUser() {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      public_id: "usr_" + id.replaceAll("-", "").slice(0, 16),
      name: "E2E User",
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
      description: `Кафе Е2е — тестовый бизнес.\nГород: Барнаул\n${PHONE_LINE}\nСайт: ${origin}/`,
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

test("Stage 3 E2E: discovery crawls the local fixture end to end", async () => {
  const ownerId = await makeUser();
  const business = await makeBusiness(ownerId, "E2E Crawl");

  const service = new OsintService(db, {
    crawl: true,
    crawlOptions: {
      allowPrivateNetworks: true,
      robots: createRobotsChecker({ deps: { allowPrivateNetworks: true } }),
    },
    registry: createBuiltinRegistry({ webPage: { allowPrivateNetworks: true } }),
  });

  hits.length = 0;
  const outcome = await service.startDiscovery(ownerId, business.public_id);
  assert.equal(outcome.status, "completed", JSON.stringify(outcome.errors));
  assert.ok(outcome.queriesCount > 0, "поисковая фаза отработала");
  assert.ok(outcome.candidatesCount >= 1, "own_urls дал кандидата");

  // --- очередь: домены владельца пройдены, чужой домен и robots — нет ----
  const rows = await db
    .selectFrom("osint_crawl_queue")
    .selectAll()
    .where("run_id", "=", outcome.runId)
    .orderBy("depth", "asc")
    .orderBy("url", "asc")
    .execute();
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  assert.equal(rows.length, 3, `queue: ${JSON.stringify(rows.map((r) => r.url))}`);
  assert.equal(byUrl.get(origin + "/").status, "fetched");
  assert.equal(byUrl.get(origin + "/about").status, "fetched");
  const contacts = byUrl.get(origin + "/contacts");
  assert.equal(contacts.status, "skipped");
  assert.equal(contacts.skip_reason, "robots_disallowed", "robots.txt реально отсёк");
  assert.ok(
    !rows.some((row) => row.url.startsWith("https://other.example/")),
    "чужой домен не попал в очередь",
  );
  assert.ok(!hits.includes("/nothing"), "фикстура отдавала только свои страницы");
  assert.ok(hits.includes("/robots.txt"), "robots.txt запрашивался");

  // --- наблюдение с телом страницы и провенансом -------------------------
  const observations = await db
    .selectFrom("osint_observations")
    .selectAll()
    .where("content", "like", `%${HOME_MARKER}%`)
    .execute();
  assert.equal(observations.length, 1, "тело главной страницы в наблюдении");
  const observation = observations[0];
  assert.equal(observation.kind, "page");
  const metadata = JSON.parse(JSON.stringify(observation.metadata));
  assert.equal(metadata.provider, "web_page");
  assert.equal(metadata.http_status, 200);
  assert.equal(metadata.depth, 0);
  assert.equal(metadata.parser_version, "html-v1");

  // --- источник и контекст -----------------------------------------------
  const source = await db
    .selectFrom("osint_sources")
    .selectAll()
    .where("id", "=", observation.source_id)
    .executeTakeFirstOrThrow();
  assert.ok(source.normalized_url.startsWith(origin));
  const context = await db
    .selectFrom("osint_source_context")
    .selectAll()
    .where("source_id", "=", source.id)
    .executeTakeFirst();
  assert.ok(context, "контекст источника создан");

  // --- snapshot видит завершённый run с crawl-статистикой ----------------
  const snapshot = await service.getSnapshot(ownerId, business.public_id);
  const run = snapshot.runs.find((row) => row.id === outcome.runId);
  assert.equal(run.status, "completed");
  assert.ok(
    snapshot.counts.candidates >= outcome.candidatesCount,
    "кандидаты search- и crawl-фаз в одном счётчике",
  );
  const crawlStats = run.stats?.crawl;
  assert.ok(crawlStats, "stats.crawl записан");
  assert.equal(crawlStats.fetched, 2);
  assert.equal(crawlStats.failed, 0);

  // --- статус-эндпоинт сервиса -------------------------------------------
  const status = await service.getRunStatus(ownerId, business.public_id, outcome.runId);
  assert.equal(status.status, "completed");
  assert.equal(status.queue.total, 3);
  assert.equal(status.queue.fetched, 2);
  assert.equal(status.queue.skipped, 1);
  assert.equal(status.recentFailures.length, 1);
  assert.equal(status.recentFailures[0].skipReason, "robots_disallowed");
});

test("Stage 3 E2E: without allowPrivateNetworks the crawl is blocked by SSRF guard", async () => {
  const ownerId = await makeUser();
  const business = await makeBusiness(ownerId, "E2E SSRF");

  const service = new OsintService(db, { crawl: true });
  const outcome = await service.startDiscovery(ownerId, business.public_id);
  assert.equal(outcome.status, "failed", JSON.stringify(outcome.errors));
  assert.ok(
    outcome.errors.some((value) => value.includes("private_address")),
    `ожидался private_address: ${JSON.stringify(outcome.errors)}`,
  );

  const rows = await db
    .selectFrom("osint_crawl_queue")
    .selectAll()
    .where("run_id", "=", outcome.runId)
    .execute();
  assert.ok(rows.length >= 1);
  assert.ok(
    rows.every((row) => row.status === "failed" || row.status === "skipped"),
    "ни одна страница не прошла мимо SSRF-guard",
  );
});
