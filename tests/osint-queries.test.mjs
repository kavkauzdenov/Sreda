/** OSINT: генерация поисковых запросов из профиля (детерминировано). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiscoveryQueries } from "../src/server/intelligence/osint/queries.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";

function profile() {
  return buildDiscoveryProfile({
    name: "Кафе Ромашка",
    description:
      "Кафе Ромашка — уютное кафе.\nГород: Барнаул\nул. Ленина, 10\nТелефон: 8 (3852) 55-10-10\nСайт: https://romashka.ru",
    contact_info: "8 (3852) 55-10-10",
    industry: "food",
  });
}

test("buildDiscoveryProfile extracts city, phone, address, website", () => {
  const p = profile();
  assert.equal(p.businessName, "Кафе Ромашка");
  assert.deepEqual(p.aliases, ["Кафе Ромашка"]);
  assert.equal(p.city, "Барнаул");
  assert.equal(p.address, "ул. Ленина, 10");
  assert.equal(p.website, "https://romashka.ru/");
  assert.deepEqual(p.knownDomains, ["romashka.ru"]);
  assert.ok(p.phones.includes("73852551010"), JSON.stringify(p.phones));
  assert.equal(p.phone, "73852551010");
  assert.ok(typeof p.category === "string" && p.category.length > 0);
});

test("queries are generated from templates, deterministically, without empty placeholders", () => {
  const queries = buildDiscoveryQueries(profile(), { maxQueries: 50 });
  const texts = queries.map((q) => q.text);
  assert.ok(texts.includes("Кафе Ромашка Барнаул"));
  assert.ok(texts.includes("Кафе Ромашка Барнаул отзывы"));
  assert.ok(texts.includes("73852551010"));
  assert.ok(texts.includes("Кафе Ромашка romashka.ru"));
  assert.ok(!texts.some((text) => text.includes("{")), texts.join(" | "));
  assert.ok(!texts.some((text) => /\s{2,}/.test(text)));
  // Без региона в профиле шаблон {region} пропускается.
  assert.ok(!queries.some((q) => q.templateId === "name_region"));
  // Повторный вызов идентичен.
  assert.deepEqual(
    buildDiscoveryQueries(profile(), { maxQueries: 50 }).map((q) => q.text),
    texts,
  );
});

test("maxQueries budget limits output", () => {
  const all = buildDiscoveryQueries(profile(), { maxQueries: 50 });
  const limited = buildDiscoveryQueries(profile(), { maxQueries: 3 });
  assert.equal(limited.length, 3);
  assert.deepEqual(limited, all.slice(0, 3));
});

test("without name no {name} queries are produced", () => {
  const empty = buildDiscoveryProfile({ name: "", description: "Город: Барнаул" });
  const queries = buildDiscoveryQueries(empty, { maxQueries: 50 });
  assert.equal(queries.length, 0);
});

test("phone-only template appears only when profile has a phone", () => {
  const withPhone = buildDiscoveryQueries(profile(), { maxQueries: 50 });
  assert.ok(withPhone.some((q) => q.templateId === "phone_only"));
  const noPhone = buildDiscoveryQueries(
    buildDiscoveryProfile({ name: "Кафе Ромашка", description: "Город: Барнаул" }),
    { maxQueries: 50 },
  );
  assert.ok(!noPhone.some((q) => q.templateId === "phone_only"));
});
