import test from "node:test";
import assert from "node:assert/strict";

import {
  assessConflict,
  assessSide,
  hypothesisFromContradiction,
  parseSides,
} from "../src/server/intelligence/osint/research/contradiction-feedback.ts";
import { hypothesesFromFact } from "../src/server/intelligence/osint/research/feedback.ts";
import { confirmedAreasFromFacts } from "../src/server/intelligence/osint/research/stats.ts";

/** Сторона конфликта из указанных источников. */
function side(value, urls, extra = {}) {
  return {
    value,
    sources: urls.map((url, index) => ({
      id: `s${index}-${url}`,
      name: url,
      url,
    })),
    observations: [],
    firstSeen: "2026-01-01T00:00:00Z",
    lastSeen: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

test("assessSide считает поддомены одним источником, а не независимыми", () => {
  // Пять страниц одного каталога — это одно свидетельство.
  const sameSite = assessSide(
    side(
      "Барнаул, ул. Ленина, 1",
      [
        "https://2gis.ru/place/1",
        "https://catalog.ru/item/2",
        "https://catalog.ru/item/3",
        "https://catalog.ru/item/4",
      ],
    ),
  );
  assert.equal(sameSite.independentSources, 2, "2gis.ru + catalog.ru, не четыре страницы");

  // Разные регистrable-домены — независимые свидетельства.
  const different = assessSide(
    side("Барнаул", ["https://a.ru/x", "https://b.com/y", "https://c.org/z"]),
  );
  assert.equal(different.independentSources, 3);
});

test("assessSide выдаёт максимальную авторитетность, а не сумму", () => {
  // Один официальный источник не должен «перевешиваться» десятью мусорными.
  const evidence = assessSide(
    side("Барнаул", [
      "https://official.example/x",
      "https://junk1.example/x",
      "https://junk2.example/x",
      "https://junk3.example/x",
    ]),
  );
  assert.equal(evidence.authority, 1);
  assert.equal(evidence.independentSources, 4);
});

test("assessConflict НЕ сужает круг, когда свидетельства равноценны", () => {
  const assessment = assessConflict([
    side("Барнаул, ул. Ленина, 1", ["https://a.ru/x"]),
    side("Барнаул, ул. Мира, 5", ["https://b.ru/y"]),
  ]);

  assert.equal(assessment.narrowed, false, "один источник против одного — выбирать нельзя");
  assert.equal(assessment.likelyCurrent, null, "победителя назначать нельзя");
  assert.match(assessment.insufficient, /независим/i);
});

test("assessConflict сужает круг при наличии авторитетного источника", () => {
  const assessment = assessConflict([
    side("Барнаул, ул. Ленина, 1", ["https://maps.example/place/official"]),
    side("Барнаул, ул. Мира, 5", ["https://junk.example/x", "https://junk2.example/y"]),
  ]);

  assert.equal(assessment.narrowed, true);
  assert.ok(assessment.likelyCurrent, "должен быть кандидат на актуальность");
  assert.equal(assessment.likelyCurrent.value, "Барнаул, ул. Ленина, 1");
  // Даже сузив круг, модуль обязан признать, что это не доказательство.
  assert.match(assessment.insufficient, /не доказана|историческ/i);
});

test("assessConflict: два независимых источника против одного НЕ сужают круг", () => {
  // Два каталога против одного — это 3 балла против 2. Разрыва в один балл
  // недостаточно: значимого свидетельства (авторитетного источника) нет,
  // поэтому назначать победителя рано.
  const assessment = assessConflict([
    side("Значение А", ["https://a.ru/x"]),
    side("Значение Б", ["https://b.ru/x", "https://c.com/x"]),
  ]);
  assert.equal(assessment.narrowed, false);
  assert.equal(assessment.likelyCurrent, null);
  assert.match(assessment.insufficient, /ещё один независимый/i);
});

test("оценка сторон не зависит от ошибок округления", () => {
  // Регрессия: с дробными весами 1.4 - 0.9 = 0.4999... и сравнение с
  // порогом 0.5 давало другой результат, чем ожидала арифметика.
  const assessment = assessConflict([
    side("Значение А", ["https://a.ru/x"]),
    side("Значение Б", ["https://b.ru/x", "https://c.com/x", "https://d.org/x"]),
  ]);
  // 3 независимых (3 балла) против 1 (1 балл) — разрыв 2, круг сужается.
  assert.equal(assessment.narrowed, true);
  assert.equal(assessment.likelyCurrent.value, "Значение Б");
});

test("assessConflict не падает и не выдумывает конфликт на одной стороне", () => {
  const assessment = assessConflict([side("Значение", ["https://a.ru/x"])]);
  assert.equal(assessment.narrowed, false);
  assert.equal(assessment.likelyCurrent, null);
});

test("hypothesisFromContradiction строит две гипотезы со стабильными ключами", () => {
  const sides = parseSides([
    { value: "Барнаул, ул. Ленина, 1", sources: [{ id: "a", name: "n", url: "https://a.ru" }] },
    { value: "Барнаул, ул. Мира, 5", sources: [{ id: "b", name: "n", url: "https://b.ru" }] },
  ]);

  const first = hypothesisFromContradiction({
    id: "c-1",
    fact_type: "address",
    sides,
    value_count: 2,
    source_count: 2,
  });
  const second = hypothesisFromContradiction({
    id: "c-1",
    fact_type: "address",
    sides,
    value_count: 2,
    source_count: 2,
  });

  assert.equal(first.length, 2, "уточнение актуальности + проверка истории");
  assert.deepEqual(
    first.map((h) => h.dedupeKey).sort(),
    second.map((h) => h.dedupeKey).sort(),
    "повторный проход должен давать те же ключи — иначе гипотезы размножаются",
  );
  assert.deepEqual(
    [...new Set(first.map((h) => h.dedupeKey))],
    first.map((h) => h.dedupeKey),
    "ключи уникальны внутри пачки",
  );
});

test("dedupe-ключ гипотезы о конфликте не зависит от числа значений", () => {
  // osint_intelligence_contradictions UNIQUE (business_id, fact_type):
  // конфликт обновляется на месте, и рост числа значений — это уточнение
  // того же вопроса. Новый набор значений не должен порождать новую гипотезу.
  const base = { id: "c-9", fact_type: "phone", value_count: 2, source_count: 2 };

  const two = hypothesisFromContradiction({
    ...base,
    sides: parseSides([
      { value: "+7 385 255 10 10", sources: [] },
      { value: "+7 385 255 99 99", sources: [] },
    ]),
  });
  const three = hypothesisFromContradiction({
    ...base,
    sides: parseSides([
      { value: "+7 385 255 10 10", sources: [] },
      { value: "+7 385 255 99 99", sources: [] },
      { value: "+7 800 000 00 00", sources: [] },
    ]),
  });

  assert.deepEqual(
    two.map((h) => h.dedupeKey).sort(),
    three.map((h) => h.dedupeKey).sort(),
    "тот же открытый конфликт — та же гипотеза",
  );
});

test("hypothesisFromContradiction игнорирует бессмысленные типы фактов", () => {
  const sides = parseSides([
    { value: "а", sources: [] },
    { value: "б", sources: [] },
  ]);
  const out = hypothesisFromContradiction({
    id: "c-2",
    fact_type: "country",
    sides,
    value_count: 2,
    source_count: 2,
  });
  assert.deepEqual(out, [], "страна не стоит исследования: цена ошибки нулевая");
});

test("parseSides молча отбрасывает мусор из jsonb, не падая", () => {
  assert.deepEqual(parseSides(null), []);
  assert.deepEqual(parseSides("строка"), []);
  assert.deepEqual(parseSides([null, 42, {}, { value: "" }]), []);

  const parsed = parseSides([
    { value: "ок", sources: [{ id: "a", name: "n", url: "https://a.ru" }, null, { name: "без id" }] },
  ]);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].sources.length, 1, "источник без id отбрасывается");
});

test("гипотеза из факта имеет стабильный ключ, зависящий от факта", () => {
  const fact = {
    id: "f-1",
    factType: "phone",
    factKey: "contact.phone",
    value: "+73852551010",
    sourceId: "s-1",
    sourceTrust: "official",
    observedAt: "2026-02-01T00:00:00Z",
  };
  const a = hypothesesFromFact(fact);
  const b = hypothesesFromFact(fact);
  assert.ok(a.length > 0);
  assert.deepEqual(a.map((h) => h.dedupeKey), b.map((h) => h.dedupeKey));

  // Другой факт должен давать другой ключ — иначе находка окажется
  // основанием для той же гипотезы и потеряется.
  const other = hypothesesFromFact({ ...fact, id: "f-2", value: "+73852559999" });
  const aKeys = a.map((h) => h.dedupeKey).sort().join("|");
  const oKeys = other.map((h) => h.dedupeKey).sort().join("|");
  assert.notEqual(aKeys, oKeys, "разные факты — разные гипотезы");
});

test("confirmedAreasFromFacts не закрывает направление без находок", () => {
  assert.equal(confirmedAreasFromFacts([]).size, 0);

  const confirmed = confirmedAreasFromFacts(["brand_name"]);
  assert.ok(confirmed.has("identity"));
  assert.ok(!confirmed.has("reviews"), "отзывы не подтверждены тем, что найдено название");

  const legal = confirmedAreasFromFacts(["tax_identifier"]);
  assert.ok(legal.has("legal"));
});

test("подтверждённый факт учитывается ровно в своих направлениях", () => {
  const confirmed = confirmedAreasFromFacts(["phone", "address"]);
  assert.ok(confirmed.has("contact"));
  assert.ok(confirmed.has("locations"));
  assert.ok(!confirmed.has("website"));
  assert.ok(!confirmed.has("social"));
});
