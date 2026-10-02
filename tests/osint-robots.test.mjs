/**
 * OSINT §25: robots.txt — парсинг групп, перекрытие wildcard конкретным UA,
 * Allow/Disallow с учётом длины правила, кэш и подсчёт загрузок чекером.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createRobotsChecker,
  parseRobots,
  robotsAllows,
} from "../src/server/intelligence/osint/robots.ts";

test("parseRobots: wildcard group, comments, empty Disallow means allow all", () => {
  const rules = parseRobots(`
    # комментарий
    User-agent: *
    Disallow: /private/
    Disallow: /tmp
    Allow: /private/public.html

    User-agent: BizneSotyBot
    Disallow: /only-for-us/
  `);
  assert.deepEqual(rules, {
    allow: [],
    disallow: ["/only-for-us/"],
  }, "группа конкретного UA перекрывает wildcard");

  const wildcard = parseRobots("User-agent: *\nDisallow:");
  assert.deepEqual(wildcard, { allow: [], disallow: [] }, "пустой Disallow разрешает всё");
});

test("robotsAllows: longest match wins, Allow on equal length, anchors and wildcards", () => {
  const rules = parseRobots(
    ["User-agent: *", "Disallow: /private", "Allow: /private/open"].join("\n"),
  );
  assert.equal(robotsAllows(rules, "/private/open/file").allowed, true, "Allow длиннее");
  assert.equal(robotsAllows(rules, "/private/secret").allowed, false, "Disallow длиннее");
  assert.equal(robotsAllows(rules, "/public").allowed, true, "без совпадений — можно");

  const anchored = parseRobots(["User-agent: *", "Disallow: /*.json$"].join("\n"));
  assert.equal(robotsAllows(anchored, "/data.json").allowed, false, "$ anchor");
  assert.equal(robotsAllows(anchored, "/data.jsonx").allowed, true, "$ не совпадает");

  const tie = parseRobots(["User-agent: *", "Disallow: /page", "Allow: /page"].join("\n"));
  assert.equal(robotsAllows(tie, "/page").allowed, true, "при равной длине Allow");

  const catchAll = parseRobots(
    ["User-agent: *", "Disallow: /", "Allow: /index.html"].join("\n"),
  );
  assert.equal(robotsAllows(catchAll, "/index.html").allowed, true, "Allow конкретнее /");
  assert.equal(robotsAllows(catchAll, "/other").allowed, false, "/ покрывает остальное");
});

test("checker caches per origin and counts fetches; dead robots.txt allows", async () => {
  const calls = [];
  const checker = createRobotsChecker({
    fetchFn: async (url) => {
      calls.push(url);
      if (url.includes("blocked.example")) {
        throw new Error("ECONNREFUSED");
      }
      return {
        ok: true,
        status: 200,
        url,
        contentType: "text/plain",
        body: "User-agent: *\nDisallow: /admin",
        truncated: false,
        resolvedIp: "1.2.3.4",
        redirects: 0,
      };
    },
  });

  assert.equal((await checker.isAllowed("https://site.example/admin")).allowed, false);
  assert.equal((await checker.isAllowed("https://site.example/public")).allowed, true);
  assert.equal(calls.length, 1, "второй запрос того же origin взят из кэша");
  assert.equal(checker.fetchedCount(), 1);

  assert.equal(
    (await checker.isAllowed("https://blocked.example/anything")).allowed,
    true,
    "недоступный robots.txt не блокирует (RFC 9309)",
  );
  assert.equal(checker.fetchedCount(), 2);
});
