/**
 * OSINT extraction — zod-контракт (§11), deterministic-извлечение, AI-заглушка,
 * применение к графу с guard'ом ownership (§6, §9).
 */
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  emptyExtraction,
  parseExtraction,
} from "../src/server/intelligence/osint/extraction/contract.ts";
import {
  extractDeterministic,
} from "../src/server/intelligence/osint/extraction/deterministic.ts";
import {
  buildExtractionPrompt,
  extractWithAi,
} from "../src/server/intelligence/osint/extraction/ai.ts";
import { applyExtraction } from "../src/server/intelligence/osint/extraction/apply.ts";
import { ensureBusinessEntity } from "../src/server/intelligence/osint/entity-graph.ts";
import { buildDiscoveryProfile } from "../src/server/intelligence/osint/profile.ts";
import { readMentions } from "../src/server/intelligence/osint/mentions.ts";
import { readAttributes } from "../src/server/intelligence/osint/attributes.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

const PROFILE = buildDiscoveryProfile({
  name: "Кафе Ромашка",
  description:
    "Кафе Ромашка в Барнауле\nГород: Барнаул\nТелефон: 8 (3852) 55-10-10\nСайт: https://romashka.ru",
  contact_info: "8 (3852) 55-10-10",
  industry: "food",
});

const validEntity = {
  name: "Кафе Ромашка",
  kind: "business",
  mentionType: "ABOUT",
  evidenceKind: "text_span",
  evidenceText: "Кафе Ромашка в Барнауле",
  confidence: 0.9,
};

test("contract accepts a well-formed extraction", () => {
  const result = parseExtraction({
    entities: [validEntity],
    attributes: [
      {
        attribute: "phone",
        value: "73852551010",
        evidenceText: "Телефон: 8 (3852) 55-10-10",
        confidence: 0.95,
      },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.entities.length, 1);
  assert.equal(result.data.attributes.length, 1);
});

test("contract rejects malformed model output instead of crashing", () => {
  const cases = [
    { entities: [{ ...validEntity, confidence: 3 }] },
    { entities: [{ ...validEntity, evidenceText: "" }] },
    { entities: [{ ...validEntity, mentionType: "FRIEND" }] },
    { entities: [{ ...validEntity, kind: "planet" }] },
    { attributes: [{ attribute: "astrology", value: "x", evidenceText: "y", confidence: 1 }] },
    "not an object",
  ];
  for (const input of cases) {
    const result = parseExtraction(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.ok(result.issues.length > 0);
  }
});

test("contract forbids OWNER without explicit evidence (§6)", () => {
  const denied = parseExtraction({
    entities: [{ ...validEntity, mentionType: "OWNER", evidenceKind: "text_span" }],
  });
  assert.equal(denied.ok, false);
  assert.ok(denied.issues.some((issue) => issue.includes("mentionType")));

  const allowed = parseExtraction({
    entities: [{ ...validEntity, mentionType: "OWNER", evidenceKind: "sameAs" }],
  });
  assert.equal(allowed.ok, true, "sameAs достаточен для OWNER");
});

test("deterministic extraction finds phones, emails, urls and profile facts", () => {
  const text = [
    "Кафе Ромашка — уютное кафе.",
    "Телефон: 8 (3852) 55-10-10",
    "Почта: info@romashka.ru",
    "Сайт: https://romashka.ru/menu",
    "Город: Барнаул",
  ].join("\n");

  const result = extractDeterministic({ text, profile: PROFILE });
  const byKind = (attribute) =>
    result.attributes.filter((row) => row.attribute === attribute);

  assert.ok(byKind("phone").length >= 1, "телефон найден");
  assert.ok(
    byKind("phone").some((row) => row.value === "73852551010"),
    "телефон нормализован",
  );
  assert.ok(
    byKind("email").some((row) => row.value === "info@romashka.ru"),
    "email найден",
  );
  assert.ok(
    byKind("website").some((row) => row.value === "romashka.ru"),
    "регистрируемый домен, а не полный URL",
  );
  assert.ok(byKind("city").length >= 1, "город из профиля подтверждён текстом");
  assert.ok(
    result.attributes.every((row) => row.evidenceText.length > 0),
    "у каждого атрибута есть evidence (§9)",
  );
  assert.deepEqual(result.entities, [], "без knownEntityName сущности не выдумываются");
});

test("deterministic extraction on empty text is a safe no-op", () => {
  const result = extractDeterministic({ text: "   " });
  assert.deepEqual(result, emptyExtraction());
});

test("AI adapter is off by default and never performs network calls", async () => {
  const off = await extractWithAi({ text: "Кафе Ромашка" });
  assert.equal(off.used, false);
  assert.deepEqual(off.extraction, emptyExtraction());
  assert.deepEqual(off.issues, []);

  const noTransport = await extractWithAi({ text: "Кафе Ромашка" }, { enabled: true });
  assert.equal(noTransport.used, false, "без инъекции транспорта вызова нет");
});

test("AI adapter validates JSON through the contract and degrades gracefully", async () => {
  const broken = await extractWithAi(
    { text: "текст" },
    { enabled: true, transport: async () => "К сожалению, я не могу помочь" },
  );
  assert.equal(broken.used, true);
  assert.deepEqual(broken.extraction, emptyExtraction());
  assert.deepEqual(broken.issues, ["response_is_not_json"]);

  const malformed = await extractWithAi(
    { text: "текст" },
    { enabled: true, transport: async () => '```json\n{"entities":[{"confidence":9}]}\n```' },
  );
  assert.equal(malformed.used, true);
  assert.ok(malformed.issues.length > 0, "кривая схема отброшена, не уронила пайплайн");

  const good = await extractWithAi(
    { text: "текст" },
    {
      enabled: true,
      transport: async () => JSON.stringify({ entities: [validEntity], attributes: [] }),
    },
  );
  assert.equal(good.issues.length, 0);
  assert.equal(good.extraction.entities.length, 1);

  const fenced = await extractWithAi(
    { text: "текст" },
    {
      enabled: true,
      transport: async () =>
        `Вот ответ:\n\`\`\`json\n${JSON.stringify({ entities: [validEntity], attributes: [] })}\n\`\`\``,
    },
  );
  assert.equal(fenced.extraction.entities.length, 1, "markdown-fence разбирается");

  const failing = await extractWithAi(
    { text: "текст" },
    { enabled: true, transport: async () => { throw new Error("boom"); } },
  );
  assert.ok(failing.issues[0].startsWith("transport_error"));
  assert.deepEqual(failing.extraction, emptyExtraction());
});

test("prompt carries schema, ownership rule and the source text", () => {
  const prompt = buildExtractionPrompt({
    text: "Кафе Ромашка",
    knownEntityName: "Кафе Ромашка",
  });
  assert.ok(prompt.includes("ТОЛЬКО валидным JSON"));
  assert.ok(prompt.includes('"OWNER"'));
  assert.ok(prompt.includes("sameAs"));
  assert.ok(prompt.includes("Кафе Ромашка"));
});

async function makeUser() {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      public_id: "usr_" + id.replaceAll("-", "").slice(0, 16),
      name: "User",
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .execute();
  return id;
}

async function makeBusiness(ownerId) {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name: "Biz",
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({ business_id: row.id, user_id: ownerId, role: "owner", status: "active" })
    .execute();
  return row;
}

async function seedSourceAndObservation(entityId, content) {
  const sourceId = randomUUID();
  const url = `https://obs-${sourceId.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id: sourceId,
      type: "website",
      provider: "mock",
      url,
      normalized_url: url,
      name: "obs",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  const observationId = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: observationId,
      source_id: sourceId,
      entity_id: entityId,
      content,
      content_hash: randomUUID(),
      created_at: new Date(),
    })
    .execute();
  return observationId;
}

test("applyExtraction writes attributes and mentions onto the target entity", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const entityId = await ensureBusinessEntity(db, { businessId: biz.id, profile: PROFILE });
  const observationId = await seedSourceAndObservation(
    entityId,
    "Кафе Ромашка, Барнаул. Телефон 8 (3852) 55-10-10",
  );

  const deterministic = extractDeterministic({
    text: "Кафе Ромашка, Барнаул. Телефон 8 (3852) 55-10-10",
    profile: PROFILE,
    knownEntityName: "Кафе Ромашка",
  });

  const applied = await applyExtraction(db, {
    businessId: biz.id,
    observationId,
    targetEntityId: entityId,
    extraction: deterministic,
    targetAttributes: deterministic.attributes,
  });

  assert.ok(applied.attributesSet >= 2, `attributes=${applied.attributesSet}`);
  assert.equal(applied.mentionsCreated, 1, "mention по совпадающему имени");
  assert.equal(applied.unresolved, 0);

  const mentions = await readMentions(db, entityId);
  assert.equal(mentions.length, 1);
  assert.ok(mentions[0].text_span.length > 0);

  const attributes = await readAttributes(db, entityId);
  assert.ok(attributes.length >= 2);
  assert.ok(attributes.every((row) => row.source_observation_id === observationId));
});

test("applyExtraction refuses ownership mentions and parks foreign names", async () => {
  const uid = await makeUser();
  const biz = await makeBusiness(uid);
  const entityId = await ensureBusinessEntity(db, { businessId: biz.id, profile: PROFILE });
  const observationId = await seedSourceAndObservation(entityId, "текст");
  const mentionsBefore = (await readMentions(db, entityId)).length;

  const applied = await applyExtraction(db, {
    businessId: biz.id,
    observationId,
    targetEntityId: entityId,
    extraction: {
      entities: [
        {
          name: "Кафе Ромашка",
          kind: "business",
          mentionType: "OWNER",
          evidenceKind: "text_span",
          evidenceText: "кто-то так сказал",
          confidence: 0.9,
        },
        {
          name: "Совсем Другая Фирма",
          kind: "business",
          mentionType: "MENTIONS",
          evidenceKind: "text_span",
          evidenceText: "упоминание",
          confidence: 0.9,
        },
      ],
      attributes: [],
    },
  });

  assert.equal(applied.mentionsCreated, 0, "§6: OWNER без явного evidence отброшен");
  assert.equal(applied.unresolved, 1, "§12: чужое имя не создаёт сущность");
  assert.ok(applied.skipped.some((entry) => entry.startsWith("mention_guard")));
  assert.equal(
    (await readMentions(db, entityId)).length,
    mentionsBefore,
    "ничего не добавлено",
  );
});
