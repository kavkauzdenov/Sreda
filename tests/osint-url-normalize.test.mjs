/** OSINT: нормализация URL, регистрируемые домены, host-матчинг. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hostMatches,
  normalizeUrl,
  registrableDomain,
} from "../src/server/intelligence/osint/url.ts";

test("normalizeUrl strips tracking params and keeps meaningful ones", () => {
  const result = normalizeUrl(
    "https://Example.COM:443/path/page/?utm_source=ya&utm_campaign=x&keep=1&fbclid=abc#frag",
  );
  assert.equal(result.ok, true);
  assert.equal(result.url, "https://example.com/path/page?keep=1");
  assert.equal(result.host, "example.com");
  assert.equal(result.registrableDomain, "example.com");
});

test("normalizeUrl orders params deterministically", () => {
  const a = normalizeUrl("https://a.ru/x?b=2&a=1");
  const b = normalizeUrl("https://a.ru/x?a=1&b=2");
  assert.equal(a.ok && b.ok, true);
  assert.equal(a.url, b.url);
});

test("normalizeUrl removes trailing slashes but keeps root", () => {
  assert.equal(normalizeUrl("https://a.ru/").ok && normalizeUrl("https://a.ru/").url, "https://a.ru/");
  assert.equal(normalizeUrl("https://a.ru/news/").url, "https://a.ru/news");
});

test("normalizeUrl rejects non-http schemes and credentials", () => {
  assert.deepEqual(normalizeUrl("ftp://a.ru/f"), { ok: false, reason: "protocol_not_allowed" });
  assert.deepEqual(normalizeUrl("javascript:alert(1)"), {
    ok: false,
    reason: "protocol_not_allowed",
  });
  assert.deepEqual(normalizeUrl("https://user:pass@a.ru/"), {
    ok: false,
    reason: "credentials_in_url",
  });
  assert.deepEqual(normalizeUrl("  "), { ok: false, reason: "empty" });
  assert.equal(normalizeUrl("not a url").ok, false);
});

test("registrableDomain handles two-level suffixes and IPs", () => {
  assert.equal(registrableDomain("www.site.ru"), "site.ru");
  assert.equal(registrableDomain("sub.site.com.ru"), "site.com.ru");
  assert.equal(registrableDomain("a.b.co.uk"), "b.co.uk");
  assert.equal(registrableDomain("127.0.0.1"), null);
  assert.equal(registrableDomain("::1"), null);
  assert.equal(registrableDomain("localhost"), null);
});

test("hostMatches matches exact hosts and subdomains only", () => {
  assert.equal(hostMatches("www.site.ru", "site.ru"), true);
  assert.equal(hostMatches("site.ru", "site.ru"), true);
  assert.equal(hostMatches("notsite.ru", "site.ru"), false);
  assert.equal(hostMatches("ru", "site.ru"), false);
  assert.equal(hostMatches("", "site.ru"), false);
});
