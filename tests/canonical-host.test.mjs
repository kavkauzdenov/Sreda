import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PUBLIC_ALIAS_HOSTS,
  buildCanonicalLocation,
  decideCanonicalHost,
  isExemptFromCanonicalRedirect,
  isPublicAliasHost,
  normalizeHostname,
  parseAppOrigin,
  resolveRequestHostname,
} from "../src/server/http/canonical-host.ts";

const CANONICAL = "https://biznesoty.ru";

describe("canonical-host policy", () => {
  it("parses APP_URL as exact origin only", () => {
    assert.equal(parseAppOrigin(CANONICAL)?.origin, CANONICAL);
    assert.equal(parseAppOrigin("https://biznesoty.ru/"), null);
    assert.equal(parseAppOrigin("https://biznesoty.ru/path"), null);
    assert.equal(parseAppOrigin("not-a-url"), null);
  });

  it("normalizes hostnames and strips ports", () => {
    assert.equal(normalizeHostname("Biznesoty.RU:443"), "biznesoty.ru");
    assert.equal(normalizeHostname(" biznesoty.online "), "biznesoty.online");
  });

  it("knows public aliases including punycode Cyrillic", () => {
    assert.equal(isPublicAliasHost("biznesoty.online"), true);
    assert.equal(isPublicAliasHost("www.biznesoty.online"), true);
    assert.equal(isPublicAliasHost("www.biznesoty.ru"), true);
    assert.equal(isPublicAliasHost("xn--90aifd0ahuj5f.xn--p1ai"), true);
    assert.equal(isPublicAliasHost("biznesoty.ru"), false);
    assert.ok(PUBLIC_ALIAS_HOSTS.has("xn--90aifd0ahuj5f.xn--p1ai"));
  });

  it("exempts health and webhook paths", () => {
    assert.equal(isExemptFromCanonicalRedirect("/api/health"), true);
    assert.equal(isExemptFromCanonicalRedirect("/api/health/web"), true);
    assert.equal(isExemptFromCanonicalRedirect("/api/health/live"), true);
    assert.equal(
      isExemptFromCanonicalRedirect("/api/telegram/abc-123"),
      true,
    );
    assert.equal(isExemptFromCanonicalRedirect("/api/vk/abc-123"), true);
    assert.equal(isExemptFromCanonicalRedirect("/api/meta/webhook"), true);
    assert.equal(isExemptFromCanonicalRedirect("/login"), false);
    assert.equal(isExemptFromCanonicalRedirect("/api/v1/account"), false);
  });

  it("does not redirect when Host already matches APP_URL", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.ru",
      pathname: "/orders",
      search: "?page=2",
      appUrl: CANONICAL,
    });
    assert.deepEqual(d, { action: "pass" });
  });

  it("308-redirects alias GET preserving path and query", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.online",
      pathname: "/login",
      search: "?next=/orders",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "redirect");
    if (d.action === "redirect") {
      assert.equal(d.status, 308);
      assert.equal(d.location, "https://biznesoty.ru/login?next=/orders");
    }
  });

  it("308-redirects Cyrillic/punycode alias", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "xn--90aifd0ahuj5f.xn--p1ai",
      pathname: "/settings",
      search: "",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "redirect");
    if (d.action === "redirect") {
      assert.equal(d.location, "https://biznesoty.ru/settings");
    }
  });

  it("308-redirects www to apex canonical", () => {
    const d = decideCanonicalHost({
      method: "HEAD",
      hostname: "www.biznesoty.ru",
      pathname: "/dashboard",
      search: "",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "redirect");
    if (d.action === "redirect") {
      assert.equal(d.location, "https://biznesoty.ru/dashboard");
    }
  });

  it("does not create a redirect loop on canonical host", () => {
    for (const path of ["/", "/login", "/api/v1/account"]) {
      const d = decideCanonicalHost({
        method: "GET",
        hostname: "biznesoty.ru",
        pathname: path,
        search: "",
        appUrl: CANONICAL,
      });
      assert.equal(d.action, "pass", path);
    }
  });

  it("rejects unsafe methods on alias without becoming trusted origin", () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const d = decideCanonicalHost({
        method,
        hostname: "biznesoty.online",
        pathname: "/api/auth/sign-in/username",
        search: "",
        appUrl: CANONICAL,
      });
      assert.equal(d.action, "reject");
      if (d.action === "reject") {
        assert.equal(d.status, 403);
        assert.equal(d.code, "NON_CANONICAL_HOST");
      }
    }
  });

  it("passes health on alias host without redirecting", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.online",
      pathname: "/api/health/web",
      search: "",
      appUrl: CANONICAL,
    });
    assert.deepEqual(d, { action: "pass" });
  });

  it("passes webhook ingress on alias host", () => {
    const d = decideCanonicalHost({
      method: "POST",
      hostname: "biznesoty.online",
      pathname: "/api/telegram/conn-1",
      search: "",
      appUrl: CANONICAL,
    });
    assert.deepEqual(d, { action: "pass" });
  });

  it("never builds redirect location from request Host / unknown host", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "evil.example",
      pathname: "/login",
      search: "?next=https://evil.example",
      appUrl: CANONICAL,
    });
    assert.deepEqual(d, { action: "pass" });
    assert.equal(
      buildCanonicalLocation(CANONICAL, "/p", "?a=1"),
      "https://biznesoty.ru/p?a=1",
    );
  });

  it("rejects API GET on alias instead of HTML redirect", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.online",
      pathname: "/api/v1/account",
      search: "",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "reject");
  });

  it("CASE landing root on canonical passes", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.ru",
      pathname: "/",
      search: "",
      appUrl: CANONICAL,
    });
    assert.deepEqual(d, { action: "pass" });
  });

  it("CASE alias roots 308 to canonical landing", () => {
    for (const hostname of [
      "biznesoty.online",
      "www.biznesoty.online",
      "www.biznesoty.ru",
      "xn--90aifd0ahuj5f.xn--p1ai",
      "бизнесоты.рф",
    ]) {
      const d = decideCanonicalHost({
        method: "GET",
        hostname,
        pathname: "/",
        search: "",
        appUrl: CANONICAL,
      });
      assert.equal(d.action, "redirect", hostname);
      if (d.action === "redirect") {
        assert.equal(d.status, 308);
        assert.equal(d.location, "https://biznesoty.ru/");
      }
    }
  });

  it("CASE alias login/register preserve path", () => {
    const login = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.online",
      pathname: "/login",
      search: "",
      appUrl: CANONICAL,
    });
    assert.equal(login.action, "redirect");
    if (login.action === "redirect") {
      assert.equal(login.location, "https://biznesoty.ru/login");
    }

    const register = decideCanonicalHost({
      method: "GET",
      hostname: "бизнесоты.рф",
      pathname: "/register",
      search: "",
      appUrl: CANONICAL,
    });
    assert.equal(register.action, "redirect");
    if (register.action === "redirect") {
      assert.equal(register.location, "https://biznesoty.ru/register");
    }
  });

  it("CASE alias login preserves query string", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "biznesoty.online",
      pathname: "/login",
      search: "?next=/orders",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "redirect");
    if (d.action === "redirect") {
      assert.equal(d.location, "https://biznesoty.ru/login?next=/orders");
    }
  });

  it("normalizes Unicode Cyrillic host to punycode alias", () => {
    assert.equal(
      normalizeHostname("бизнесоты.рф"),
      "xn--90aifd0ahuj5f.xn--p1ai",
    );
    assert.equal(isPublicAliasHost("бизнесоты.рф"), true);
  });

  it("308-redirects www.biznesoty.online", () => {
    const d = decideCanonicalHost({
      method: "GET",
      hostname: "www.biznesoty.online",
      pathname: "/register",
      search: "?ref=1",
      appUrl: CANONICAL,
    });
    assert.equal(d.action, "redirect");
    if (d.action === "redirect") {
      assert.equal(d.location, "https://biznesoty.ru/register?ref=1");
    }
  });

  it("resolveRequestHostname prefers Host over forwarded", () => {
    const headers = new Headers({
      host: "biznesoty.ru",
      "x-forwarded-host": "evil.example",
    });
    assert.equal(resolveRequestHostname(headers), "biznesoty.ru");
  });
});
