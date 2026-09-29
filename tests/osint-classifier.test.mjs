/** OSINT: детерминированная классификация источников по host-правилам. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyResult } from "../src/server/intelligence/osint/classifier.ts";

function classify(url, extra = {}) {
  return classifyResult({ url, provider: "test", ...extra });
}

test("own website is official", () => {
  const result = classify("https://www.romashka.ru/contacts", {
    knownDomains: ["romashka.ru"],
  });
  assert.equal(result.ok, true);
  assert.equal(result.candidate.type, "website");
  assert.equal(result.candidate.trustLevel, "official");
  assert.equal(result.candidate.host, "www.romashka.ru");
});

test("job and ad boards are rejected", () => {
  const jobs = classify("https://hh.ru/vacancy/123");
  assert.deepEqual(jobs, { ok: false, reason: "jobs_or_ads_board" });
  assert.deepEqual(classify("https://www.avito.ru/barnaul"), {
    ok: false,
    reason: "jobs_or_ads_board",
  });
});

test("search engine result pages are rejected", () => {
  assert.deepEqual(classify("https://yandex.ru/search/?text=cafe"), {
    ok: false,
    reason: "search_page",
  });
  assert.deepEqual(classify("https://google.com/search?q=cafe"), {
    ok: false,
    reason: "search_page",
  });
});

test("maps and directories classified as public_directory", () => {
  const twoGis = classify("https://2gis.ru/barnaul/firm/123");
  assert.equal(twoGis.ok && twoGis.candidate.type, "maps");
  assert.equal(twoGis.candidate.trustLevel, "public_directory");
  const rusprofile = classify("https://www.rusprofile.ru/id/1");
  assert.equal(rusprofile.ok && rusprofile.candidate.type, "directory");
});

test("review platforms and social networks are recognized", () => {
  const otzovik = classify("https://otzovik.com/reviews/x.html");
  assert.equal(otzovik.ok && otzovik.candidate.type, "review_platform");
  assert.equal(otzovik.candidate.trustLevel, "review_platform");
  const vk = classify("https://vk.com/romashka");
  assert.equal(vk.ok && vk.candidate.type, "social_network");
  assert.equal(vk.candidate.trustLevel, "third_party");
});

test("state registry is official, news is third_party", () => {
  const registry = classify("https://egrul.nalog.ru/search");
  assert.equal(registry.ok && registry.candidate.type, "public_registry");
  assert.equal(registry.candidate.trustLevel, "official");
  const news = classify("https://www.kommersant.ru/doc/1");
  assert.equal(news.ok && news.candidate.type, "news");
  assert.equal(news.candidate.trustLevel, "third_party");
});

test("unknown hosts are plain third_party websites with normalized url", () => {
  const result = classify("https://Blog.Example.ru/post/?utm_source=x#top");
  assert.equal(result.ok, true);
  assert.equal(result.candidate.type, "website");
  assert.equal(result.candidate.trustLevel, "third_party");
  assert.equal(result.candidate.normalizedUrl, "https://blog.example.ru/post");
  assert.equal(result.candidate.registrableDomain, "example.ru");
});

test("invalid urls are rejected with reason", () => {
  assert.deepEqual(classify("ftp://a.ru/x"), { ok: false, reason: "protocol_not_allowed" });
  assert.equal(classify("nonsense").ok, false);
});

test("method is derived from intent when provider does not set it", () => {
  const maps = classify("https://2gis.ru/barnaul/firm/1", { intent: "maps" });
  assert.equal(maps.ok && maps.candidate.method, "map");
  const social = classify("https://vk.com/x", { intent: "social" });
  assert.equal(social.ok && social.candidate.method, "social");
  const website = classify("https://example.ru/", { intent: "website" });
  assert.equal(website.ok && website.candidate.method, "search");
});
