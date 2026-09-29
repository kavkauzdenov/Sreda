/** OSINT: SSRF-safe fetch — DNS→IP проверка, ручные redirect'ы, лимиты. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPrivateIp, safeFetch } from "../src/server/intelligence/osint/safe-fetch.ts";

test("isPrivateIp covers IPv4 and IPv6 special ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "255.255.255.255",
    "224.0.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "ff02::1",
    "::ffff:192.168.0.1",
    "[::1]",
  ]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: { "content-type": "text/html", ...headers },
    body,
    truncated: false,
  };
}

test("fetches public host and returns body", async () => {
  const calls = [];
  const result = await safeFetch(
    "https://example.com/page",
    {},
    {
      lookup: async () => ["93.184.216.34"],
      transport: async (url, init) => {
        calls.push({ url, init });
        return jsonResponse(200, "<html>ok</html>");
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.body, "<html>ok</html>");
  assert.equal(result.resolvedIp, "93.184.216.34");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect ?? undefined, undefined);
});

test("rejects private addresses before any transport call", async () => {
  let called = false;
  const result = await safeFetch(
    "http://internal.service.local/",
    {},
    {
      lookup: async () => ["10.0.0.5"],
      transport: async () => {
        called = true;
        return jsonResponse(200, "leak");
      },
    },
  );
  assert.deepEqual(result, { ok: false, reason: "private_address", detail: "internal.service.local -> 10.0.0.5" });
  assert.equal(called, false);
});

test("rejects when ANY resolved address is private (mixed A records)", async () => {
  const result = await safeFetch(
    "https://mixed.example/",
    {},
    {
      lookup: async () => ["93.184.216.34", "127.0.0.1"],
      transport: async () => jsonResponse(200, "x"),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "private_address");
});

test("allowPrivateNetworks overrides the guard (tests/dev only)", async () => {
  const result = await safeFetch(
    "http://127.0.0.1:8080/",
    { allowPrivateNetworks: true },
    {
      lookup: async () => ["127.0.0.1"],
      transport: async () => jsonResponse(200, "local"),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.body, "local");
});

test("manual redirects are followed and each hop re-checked", async () => {
  const hops = [];
  const result = await safeFetch(
    "https://a.example/start",
    {},
    {
      lookup: async (host) => {
        if (host === "evil.internal") return ["192.168.0.10"];
        return ["93.184.216.34"];
      },
      transport: async (url) => {
        hops.push(url);
        if (url.includes("/start"))
          return jsonResponse(302, "", { location: "https://a.example/next" });
        return jsonResponse(302, "", { location: "http://evil.internal/steal" });
      },
    },
  );
  assert.deepEqual(result, {
    ok: false,
    reason: "private_address",
    detail: "evil.internal -> 192.168.0.10",
  });
  assert.equal(hops.length, 2);
});

test("redirect limit prevents loops", async () => {
  const result = await safeFetch(
    "https://a.example/loop",
    { maxRedirects: 2 },
    {
      lookup: async () => ["93.184.216.34"],
      transport: async (url) =>
        jsonResponse(302, "", { location: url + "/x" }),
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "redirect_limit");
});

test("http errors and dns failures are reported, not thrown", async () => {
  const notFound = await safeFetch(
    "https://a.example/404",
    {},
    { lookup: async () => ["93.184.216.34"], transport: async () => jsonResponse(404, "no") },
  );
  assert.deepEqual(notFound, { ok: false, reason: "http_error", detail: "404" });

  const dnsFailed = await safeFetch(
    "https://nope.example/",
    {},
    {
      lookup: async () => {
        throw new Error("ENOTFOUND");
      },
      transport: async () => jsonResponse(200, "x"),
    },
  );
  assert.equal(dnsFailed.ok, false);
  assert.equal(dnsFailed.reason, "dns_failed");

  const badProtocol = await safeFetch(
    "ftp://a.example/",
    {},
    {
      lookup: async () => ["93.184.216.34"],
      transport: async () => jsonResponse(200, "x"),
    },
  );
  assert.equal(badProtocol.ok, false);
  assert.equal(badProtocol.reason, "protocol_not_allowed");
});

test("oversized declared body is refused before download", async () => {
  const result = await safeFetch(
    "https://a.example/huge",
    { maxBytes: 100 },
    {
      lookup: async () => ["93.184.216.34"],
      transport: async (url, init) => {
        // default transport honours content-length; simulate the check.
        assert.equal(init.maxBytes, 100);
        return { status: 200, headers: { "content-length": "5000" }, body: "", truncated: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
});
