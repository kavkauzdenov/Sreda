/**
 * Clients V2 HTTP-shape / filter contract tests.
 * Full production HTTPS lifecycle lives in tests/http/; this suite covers
 * request validation surfaces that must return 400 (not 500) for bad input.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseListFilters } from "../src/server/clients/list.ts";
import { decideDuplicate } from "../src/server/clients/duplicates.ts";
import { AppError } from "../src/server/http/errors.ts";

test("clients v2 http filters: valid empty params", () => {
  const filters = parseListFilters(new URLSearchParams());
  assert.equal(filters.limit, 50);
  assert.equal(filters.channel, "");
  assert.equal(filters.activity, "");
});

test("clients v2 http filters: reject malformed", () => {
  const cases = [
    ["tagId", "abc"],
    ["assignedUserId", "not-uuid"],
    ["activity", "hacker"],
    ["channel", "test"],
    ["limit", "0"],
    ["limit", "101"],
  ];
  for (const [key, value] of cases) {
    assert.throws(
      () => parseListFilters(new URLSearchParams(`${key}=${value}`)),
      (e) => e instanceof AppError && e.status === 400,
      `${key}=${value}`,
    );
  }
});

test("clients v2 http filters: accept known enums and uuids", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const filters = parseListFilters(
    new URLSearchParams(
      `channel=telegram&activity=today&tagId=${id}&assignedUserId=${id}&limit=25`,
    ),
  );
  assert.equal(filters.channel, "telegram");
  assert.equal(filters.activity, "today");
  assert.equal(filters.tagId, id);
  assert.equal(filters.assignedUserId, id);
  assert.equal(filters.limit, 25);
});

test("clients v2 http: public merged decision is invalid", async () => {
  // decideDuplicate validates decision before DB access for "merged".
  await assert.rejects(
    () =>
      decideDuplicate(
        /** @type {any} */ ({ transaction() {} }),
        "00000000-0000-4000-8000-000000000001",
        "biz",
        {
          clientAId: "11111111-1111-4111-8111-111111111111",
          clientBId: "22222222-2222-4222-8222-222222222222",
          decision: "merged",
        },
      ),
    (e) => e instanceof AppError && e.code === "INVALID_DECISION" && e.status === 400,
  );
});
