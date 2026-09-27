/**
 * Orders V2 HTTP-shape / filter contract tests.
 * Full production HTTPS lifecycle lives in tests/http/; this suite covers
 * request validation surfaces that must return 400 (not 500) for bad input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseOrderListFilters,
  encodeOrderCursor,
  decodeOrderCursor,
} from "../src/server/orders/list.ts";

test("orders v2 http filters: valid empty params", () => {
  const filters = parseOrderListFilters(new URLSearchParams());
  assert.equal(filters.limit, 50);
  assert.equal(filters.status, "");
  assert.equal(filters.source, "");
  assert.equal(filters.fulfillment, "");
  assert.equal(filters.date, "");
  assert.equal(filters.assignedUserId, "");
  assert.equal(filters.search, "");
});

test("orders v2 http filters: reject malformed", () => {
  const cases = [
    ["status", "hacker"],
    ["source", "test"],
    ["channel", "sms"],
    ["fulfillment", "courier"],
    ["date", "yesterday"],
    ["period", "all"],
    ["assignedUserId", "not-uuid"],
    ["assigned", "abc"],
    ["limit", "0"],
    ["limit", "101"],
    ["limit", "1.5"],
    ["cursor", "!!!"],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => parseOrderListFilters(new URLSearchParams(`${key}=${value}`)),
      (e) =>
        e &&
        e.status === 400 &&
        (e.code === "INVALID_FILTER" || e.code === "INVALID_CURSOR"),
      `${key}=${value}`,
    );
  }
});

test("orders v2 http filters: accept known enums and uuids", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const filters = parseOrderListFilters(
    new URLSearchParams(
      `status=new&source=telegram&fulfillment=pickup&date=today&assignedUserId=${id}&limit=25&search=Анна`,
    ),
  );
  assert.equal(filters.status, "new");
  assert.equal(filters.source, "telegram");
  assert.equal(filters.fulfillment, "pickup");
  assert.equal(filters.date, "today");
  assert.equal(filters.assignedUserId, id);
  assert.equal(filters.limit, 25);
  assert.equal(filters.search, "Анна");
});

test("orders v2 http filters: assigned none/unassigned aliases", () => {
  for (const value of ["none", "unassigned"]) {
    const filters = parseOrderListFilters(
      new URLSearchParams(`assignedUserId=${value}`),
    );
    assert.equal(filters.assignedUserId, "none");
  }
});

test("orders v2 http filters: channel and period aliases", () => {
  const filters = parseOrderListFilters(
    new URLSearchParams("channel=vk&period=7d&q=чай"),
  );
  assert.equal(filters.source, "vk");
  assert.equal(filters.date, "7d");
  assert.equal(filters.search, "чай");
});

test("orders v2 http: cursor round-trip and reject bad id", () => {
  const id = "22222222-2222-4222-8222-222222222222";
  const cursor = encodeOrderCursor(new Date("2024-01-01T00:00:00.000Z"), id);
  const decoded = decodeOrderCursor(cursor);
  assert.equal(decoded.id, id);
  const filters = parseOrderListFilters(
    new URLSearchParams(`cursor=${encodeURIComponent(cursor)}`),
  );
  assert.equal(filters.cursor, cursor);

  const badCursor = Buffer.from(
    JSON.stringify({ t: "2024-01-01T00:00:00.000Z", id: "not-uuid" }),
    "utf8",
  ).toString("base64url");
  assert.throws(
    () => parseOrderListFilters(new URLSearchParams(`cursor=${badCursor}`)),
    (e) => e && e.status === 400,
  );
});
