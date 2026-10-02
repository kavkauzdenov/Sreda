/**
 * Runtime-интеграция OSINT: OsintService — единственная точка, через которую
 * подсистема подключена к приложению. Цепочка:
 * HTTP → OsintService → osint/discovery → osint/candidates → БД → audit.
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { OsintService } from "../src/server/intelligence/osint-service.ts";
import { createOwnUrlsProvider } from "../src/server/intelligence/osint/providers/own-urls.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { allowed } from "../src/server/access/permissions.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const BUSINESS_DESCRIPTION =
  "Кафе Ромашка — уютное кафе в Барнауле.\nГород: Барнаул\nСайт: https://romashka.ru\nВКонтакте: https://vk.com/romashka_club";

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description: BUSINESS_DESCRIPTION,
  industry: "food",
});

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

async function makeBusiness(ownerId, name = "Biz", description = "") {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      timezone: "Europe/Moscow",
      description,
      industry: description ? "food" : null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({ business_id: row.id, user_id: ownerId, role: "owner", status: "active" })
    .execute();
  return row;
}

async function addMember(businessId, userId, role) {
  await db
    .insertInto("business_member")
    .values({ business_id: businessId, user_id: userId, role, status: "active" })
    .execute();
}

test("own_urls provider returns declared URLs exactly once per instance", async () => {
  const provider = createOwnUrlsProvider();
  assert.equal(provider.descriptor.requiresNetwork, false);
  assert.equal(provider.descriptor.policy, "structured_data");
  assert.equal(provider.descriptor.enabledByDefault, true);

  const input = {
    query: { templateId: "name_city", intent: "any", text: "Кафе Ромашка Барнаул" },
    profile: PROFILE,
    limit: 10,
  };
  const first = await provider.search(input);
  const urls = first.results.map((row) => row.url);
  assert.ok(urls.includes("https://romashka.ru/"), JSON.stringify(urls));
  assert.ok(urls.includes("https://vk.com/romashka_club"), JSON.stringify(urls));
  assert.equal(new Set(urls).size, urls.length, "no duplicate URLs in one response");

  const second = await provider.search(input);
  assert.deepEqual(second.results, [], "one provider instance emits once per run");
});

test("owner can run discovery and read the snapshot", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid, "Кафе Ромашка", BUSINESS_DESCRIPTION);
  const service = new OsintService(db);

  const outcome = await service.startDiscovery(uid, biz.public_id);
  assert.ok(
    ["completed", "partial", "failed"].includes(outcome.status),
    outcome.errors.join(" | "),
  );
  assert.equal(outcome.queriesCount > 0, true, "queries were generated");
  assert.equal(outcome.candidatesCount >= 1, true, "own URLs became candidates");
  assert.equal(outcome.errors.includes("no_providers_available"), false);

  const snapshot = await service.getSnapshot(uid, biz.public_id);
  assert.deepEqual(
    snapshot.providers.map((provider) => provider.id).sort(),
    ["own_urls", "vk", "web_page"],
    "registry exposes the built-in providers",
  );
  assert.equal(
    snapshot.providers.find((provider) => provider.id === "vk").available,
    false,
    "vk is unavailable without OSINT_VK_API_TOKEN (not an error)",
  );
  assert.equal(
    snapshot.providers.find((provider) => provider.id === "web_page").available,
    true,
  );
  assert.equal(snapshot.counts.runs, 1);
  assert.equal(snapshot.counts.candidates, outcome.candidatesCount);
  assert.equal(snapshot.runs[0].status, outcome.status);
  assert.equal(snapshot.counts.entities, 1, "root entity created via the bridge");
  assert.ok(snapshot.entities[0].identityKey?.startsWith("domain:"));
  assert.ok(snapshot.candidates.length >= 1);
  assert.equal(
    snapshot.candidates.every((row) => row.url.startsWith("https://")),
    true,
    "candidate URLs are normalised",
  );
});

test("snapshot of another business never leaks candidates", async () => {
  const uid = await makeUser();
  const bizA = await makeBusiness(uid, "A");
  const bizB = await makeBusiness(uid, "B");
  const service = new OsintService(db);

  await service.startDiscovery(uid, bizA.public_id);
  const snapshotB = await service.getSnapshot(uid, bizB.public_id);

  assert.equal(snapshotB.counts.runs, 0);
  assert.equal(snapshotB.counts.candidates, 0);
  assert.equal(snapshotB.candidates.length, 0);
});

test("operator may read but not start discovery (intelligence.manage)", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const operatorId = await makeUser("Operator");
  await addMember(biz.id, operatorId, "operator");

  const service = new OsintService(db);
  const snapshot = await service.getSnapshot(operatorId, biz.public_id);
  assert.equal(snapshot.counts.runs, 0, "operator can read");

  assert.equal(allowed("operator", "intelligence.manage"), false);
  await assert.rejects(
    () => service.startDiscovery(operatorId, biz.public_id),
    (error) => error.code === "FORBIDDEN" && error.status === 403,
  );

  assert.equal(allowed("owner", "intelligence.manage"), true);
  assert.equal(allowed("admin", "intelligence.manage"), true);
});

test("non-member cannot read or start OSINT", async () => {
  const ownerId = await makeUser();
  const biz = await makeBusiness(ownerId);
  const stranger = await makeUser("Stranger");
  const service = new OsintService(db);

  await assert.rejects(
    () => service.getSnapshot(stranger, biz.public_id),
    (error) => error.code === "BUSINESS_NOT_FOUND" && error.status === 404,
  );
  await assert.rejects(
    () => service.startDiscovery(stranger, biz.public_id),
    (error) => error.code === "BUSINESS_NOT_FOUND" && error.status === 404,
  );
});
