import test from "node:test";
import assert from "node:assert/strict";

import {
  buildIdentityFromSeed,
  identitySeedFromProfile,
} from "../src/server/intelligence/osint/research/identity-builder.ts";
import {
  dedupeIdentities,
  hasStrongIdentity,
  identityConfidence,
  identitiesOfKind,
  identityWeightTotal,
} from "../src/server/intelligence/osint/research/identity.ts";
import {
  buildInitialHypotheses,
  decayPriority,
} from "../src/server/intelligence/osint/research/hypothesis.ts";
import {
  planQueries,
  queriesForHypothesis,
} from "../src/server/intelligence/osint/research/query-generator.ts";

/* ------------------------------------------------------------------ */
/* Идентичность: надёжность полей (§6)                                 */
/* ------------------------------------------------------------------ */

const base = { name: "Кафе Ромашка", city: "Барнаул" };

test("идентичность строится только из названия и города — этого достаточно", () => {
  const identity = buildIdentityFromSeed(base);
  assert.equal(identity.name, "Кафе Ромашка");
  assert.equal(identity.normalizedName, "кафе ромашка");
  assert.ok(identitiesOfKind(identity, "name").length > 0);
  assert.equal(identitiesOfKind(identity, "phone").length, 0);
});

test("имя — слабая идентичность, оно никогда не опознаёт бизнес само", () => {
  const identity = buildIdentityFromSeed(base);
  const name = identitiesOfKind(identity, "name")[0];
  assert.equal(name.strength, "weak");
  assert.equal(hasStrongIdentity(identity), false, "одно название не даёт сильной опознанности");
});

test("телефон и домен — сильные идентификаторы и опознают бизнес", () => {
  const withPhone = buildIdentityFromSeed({ ...base, phone: "+7 (3852) 55-10-10" });
  const withDomain = buildIdentityFromSeed({ ...base, website: "https://romashka-barnaul.ru/menu" });
  assert.equal(hasStrongIdentity(withPhone), true);
  assert.equal(hasStrongIdentity(withDomain), true);
});

test("уверенность растёт от имени к телефону и домену", () => {
  const nameOnly = identityConfidence(buildIdentityFromSeed(base));
  const withPhone = identityConfidence(
    buildIdentityFromSeed({ ...base, phone: "+73852551010" }),
  );
  const withBoth = identityConfidence(
    buildIdentityFromSeed({
      ...base,
      phone: "+73852551010",
      website: "romashka-barnaul.ru",
    }),
  );
  assert.ok(
    nameOnly < withPhone && withPhone <= withBoth,
    `ожидался рост: ${nameOnly} < ${withPhone} <= ${withBoth}`,
  );
});

test("дубли одного типа не размножают уверенность", () => {
  const one = identityConfidence(
    buildIdentityFromSeed({ ...base, phone: "+73852551001" }),
  );
  const many = identityConfidence(
    buildIdentityFromSeed({
      ...base,
      phones: ["+73852551001", "+73852551002", "+73852551003", "+73852551004"],
    }),
  );
  assert.ok(
    many < one + 0.6,
    `четыре телефона не должны давать уверенность четырёх: ${many} против ${one}`,
  );
});

test("уверенность всегда в границах 0..1", () => {
  const wide = buildIdentityFromSeed({
    name: "Ромашка",
    legalName: 'ООО "Ромашка"',
    city: "Барнаул",
    region: "Алтайский край",
    country: "Россия",
    category: "кафе",
    address: "ул. Ленина, 1",
    phone: "+73852551010",
    phones: ["+73852551011", "+73852551012"],
    email: "info@romashka.ru",
    website: "https://romashka.ru",
    knownDomains: ["romashka.ru", "romashka.pro"],
    knownSocialLinks: ["https://vk.com/romashka"],
    aliases: ["Ромашка", "Кафе Ромашка Бра"],
  });
  const score = identityConfidence(wide);
  assert.ok(score >= 0 && score <= 1, `вне диапазона: ${score}`);
});

test("идентичности дедуплицируются детерминированно", () => {
  const values = dedupeIdentities([
    { kind: "domain", value: "romashka.ru", strength: "strong", origin: "profile" },
    { kind: "domain", value: "romashka.ru", strength: "strong", origin: "source", sourceId: "s1" },
  ]);
  assert.equal(values.length, 1);
  assert.equal(values[0].sourceId, "s1", "повтор должен сохранить источник");
});

test("юрлицо сильнее названия, но слабее телефона", () => {
  const nameOnly = identityWeightTotal(buildIdentityFromSeed(base));
  const legal = identityWeightTotal(
    buildIdentityFromSeed({ ...base, legalName: 'ООО "Ромашка"' }),
  );
  const phone = identityWeightTotal(
    buildIdentityFromSeed({ ...base, phone: "+73852551010" }),
  );
  assert.ok(legal > nameOnly, `юрлицо должно усиливать: ${legal} > ${nameOnly}`);
  assert.ok(phone > legal, `телефон должен быть сильнее юрлица: ${phone} > ${legal}`);
});

/* ------------------------------------------------------------------ */
/* Гипотезы (§7)                                                       */
/* ------------------------------------------------------------------ */

test("из имени и города рождаются гипотезы первого эшелона", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({ identity });
  const types = hypotheses.map((h) => h.type);
  for (const expected of ["website", "identity", "maps", "social", "reviews", "legal"]) {
    assert.ok(types.includes(expected), `нет гипотезы ${expected}`);
  }
  for (const hypothesis of hypotheses) {
    assert.ok(hypothesis.statement.length > 0, "гипотеза должна формулироваться");
    assert.ok(hypothesis.reason.length > 0, "гипотеза должна объяснять себя");
    assert.ok(hypothesis.dedupeKey.length > 0, "нужен dedupeKey");
  }
});

test("гипотезы отсортированы по убыванию приоритета", () => {
  const hypotheses = buildInitialHypotheses({ identity: buildIdentityFromSeed(base) });
  const priorities = hypotheses.map((h) => h.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test("найденный домен порождает вторй эшелон гипотез", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({
    identity,
    discovered: [{ kind: "domain", value: "romashka-barnaul.ru" }],
  });
  const domainOnes = hypotheses.filter((h) => h.subjectKey === "domain");
  assert.ok(domainOnes.length >= 3, `ожидались гипотезы по домену, получили ${domainOnes.length}`);
  const purposes = new Set(domainOnes.map((h) => h.purpose));
  assert.ok(purposes.has("contact"), "нужна гипотеза про контакты на сайте");
  assert.ok(purposes.has("services"), "нужна гипотеза про услуги на сайте");
});

test("каждая гипотеза объясняет, почему мы её проверяем", () => {
  const hypotheses = buildInitialHypotheses({
    identity: buildIdentityFromSeed(base),
    discovered: [{ kind: "domain", value: "romashka-barnaul.ru" }],
  });
  for (const hypothesis of hypotheses) {
    assert.ok(
      hypothesis.reason.trim().length >= 10,
      `причина слишком краткая: «${hypothesis.reason}»`,
    );
  }
});

test("уже исчерпанная гипотеза не предлагается повторно", () => {
  const identity = buildIdentityFromSeed(base);
  const first = buildInitialHypotheses({ identity });
  const website = first.find((h) => h.type === "website");
  assert.ok(website, "нужна гипотеза про сайт для проверки дедупа");
  const exhausted = new Set([website.dedupeKey]);
  const second = buildInitialHypotheses({ identity, exhausted });
  assert.equal(
    second.some((h) => h.dedupeKey === website.dedupeKey),
    false,
    "исчерпанная гипотеза не должна возвращаться",
  );
});

test("опознанный бизнес понижает приоритет подтверждения", () => {
  const identity = buildIdentityFromSeed({ ...base, phone: "+73852551010" });
  const withPhone = buildInitialHypotheses({ identity }).find((h) => h.type === "identity");
  const withoutPhone = buildInitialHypotheses({ identity: buildIdentityFromSeed(base) }).find(
    (h) => h.type === "identity",
  );
  assert.ok(
    withPhone.priority < withoutPhone.priority,
    `приоритет должен упасть: ${withPhone.priority} < ${withoutPhone.priority}`,
  );
});

test("без названия гипотезы не строятся — нечего искать", () => {
  const hypotheses = buildInitialHypotheses({ identity: buildIdentityFromSeed({ city: "Барнаул" }) });
  assert.deepEqual(hypotheses, []);
});

test("пустая гипотеза снижает приоритет и не исчезает", () => {
  const hypotheses = buildInitialHypotheses({ identity: buildIdentityFromSeed(base) });
  const website = hypotheses.find((h) => h.type === "website");
  const after = decayPriority(website.priority, 1);
  assert.ok(after < website.priority, "приоритет должен упасть после пустой попытки");
  assert.ok(after > 0, "гипотеза не должна обнулиться полностью");
  assert.equal(decayPriority(website.priority, 0), website.priority, "без попыток приоритет неизменен");
});

/* ------------------------------------------------------------------ */
/* Запросы (§8)                                                        */
/* ------------------------------------------------------------------ */

test("гипотеза порождает запросы с назначением и обоснованием", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({ identity });
  const website = hypotheses.find((h) => h.type === "website");
  const queries = queriesForHypothesis(identity, website);
  assert.ok(queries.length > 0, "должен быть хотя бы один запрос");
  for (const query of queries) {
    assert.ok(query.query.length > 0);
    assert.ok(query.purpose.length > 0, "у запроса должно быть назначение");
    assert.ok(query.derivedFrom.length > 0, "запрос должен ссылаться на гипотезу");
    assert.ok(query.dedupeKey.length > 0);
    assert.equal(query.hypothesisKey, website.dedupeKey);
  }
});

test("запросы содержат название и город", () => {
  const identity = buildIdentityFromSeed(base);
  const queries = queriesForHypothesis(
    identity,
    buildInitialHypotheses({ identity }).find((h) => h.type === "identity"),
  );
  assert.ok(
    queries.some((q) => q.query.includes("Кафе Ромашка") && q.query.includes("Барнаул")),
    `ожидался запрос с именем и городом, получили: ${queries.map((q) => q.query).join(" | ")}`,
  );
});

test("проверка домена даёт site:-запросы, а не общие", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({
    identity,
    discovered: [{ kind: "domain", value: "romashka-barnaul.ru" }],
  });
  const domainHypothesis = hypotheses.find((h) => h.subjectKey === "domain");
  const queries = queriesForHypothesis(identity, domainHypothesis);
  assert.ok(queries.length > 0);
  for (const query of queries) {
    assert.match(query.query, /^site:romashka-barnaul\.ru/);
  }
});

test("подтверждение идентичности использует найденный телефон", () => {
  const identity = buildIdentityFromSeed({ ...base, phone: "+7 (3852) 55-10-10" });
  const identityHypothesis = buildInitialHypotheses({ identity }).find(
    (h) => h.type === "identity",
  );
  const queries = queriesForHypothesis(identity, identityHypothesis);
  assert.ok(
    queries.some((q) => q.query.includes("3852") || q.query.includes("+7")),
    `ожидался запрос по телефону: ${queries.map((q) => q.query).join(" | ")}`,
  );
});

test("одинаковые запросы не дублируются", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({ identity });
  const queries = planQueries(identity, hypotheses, 100);
  const keys = queries.map((q) => q.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, "dedupeKey должны быть уникальны");
});

test("бюджет запросов соблюдается", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({ identity });
  assert.ok(planQueries(identity, hypotheses, 5).length <= 5);
  assert.ok(planQueries(identity, hypotheses, 1).length <= 1);
});

test("исчерпанный запрос не планируется повторно", () => {
  const identity = buildIdentityFromSeed(base);
  const hypotheses = buildInitialHypotheses({ identity });
  const first = planQueries(identity, hypotheses, 3);
  assert.ok(first.length > 0);
  const second = planQueries(identity, hypotheses, 100, new Set(first.map((q) => q.dedupeKey)));
  for (const query of first) {
    assert.equal(
      second.some((q) => q.dedupeKey === query.dedupeKey),
      false,
      `запрос «${query.query}» повторён`,
    );
  }
});

test("запросы плана отсортированы по приоритету", () => {
  const identity = buildIdentityFromSeed(base);
  const queries = planQueries(identity, buildInitialHypotheses({ identity }), 50);
  const priorities = queries.map((q) => q.priority);
  assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test("seed из DiscoveryProfile не теряет известные домены", () => {
  const seed = identitySeedFromProfile({
    businessName: "Кафе Ромашка",
    aliases: ["Ромашка"],
    category: "кафе",
    city: "Барнаул",
    region: "Алтайский край",
    country: "Россия",
    phone: "+73852551010",
    phones: ["+73852551010"],
    email: null,
    website: "https://romashka-barnaul.ru",
    address: "ул. Ленина, 1",
    knownDomains: ["romashka-barnaul.ru"],
    knownSocialLinks: ["https://vk.com/romashka"],
  });
  const identity = buildIdentityFromSeed(seed);
  assert.ok(identitiesOfKind(identity, "domain").length > 0);
  assert.ok(identitiesOfKind(identity, "social").length > 0);
  assert.ok(identitiesOfKind(identity, "address").length > 0);
});
