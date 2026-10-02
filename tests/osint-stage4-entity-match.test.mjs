/**
 * Stage 4 (§26.6): детерминированное entity resolution — классификация
 * процесса сопоставления, без записи в мосты и без оценки «качества».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  matchEntity,
  resolveEntityMatch,
} from "../src/server/intelligence/osint/entity-match.ts";

const ENTITY = {
  id: "e-1",
  displayName: "Кафе Ромашка",
  phone: null,
  website: null,
  city: null,
  identityKey: null,
};

test("EXACT: домен точен И имя точно", () => {
  const { status, signals } = matchEntity(
    { ...ENTITY, identityKey: "domain:romashka.ru" },
    { names: ["Кафе Ромашка"], phones: [], domains: ["romashka.ru"], cities: [] },
  );
  assert.equal(status, "EXACT");
  const byId = Object.fromEntries(signals.map((signal) => [signal.signal, signal.matched]));
  assert.equal(byId.domain_exact, true);
  assert.equal(byId.name_exact, true);
  assert.equal(byId.city_match, false);
  assert.ok(signals.every((signal) => typeof signal.detail === "string" && signal.detail));
});

test("STRONG: ровно один сильный сигнал — телефон совпал канонически", () => {
  const { status } = matchEntity(
    { ...ENTITY, phone: "8 (3852) 55-10-10" },
    { names: ["Совсем другое имя"], phones: ["73852551010"], domains: [], cities: [] },
  );
  assert.equal(status, "STRONG");
});

test("CANDIDATE: точное имя + совпадение города, без сильных сигналов", () => {
  const { status } = matchEntity(
    { ...ENTITY, city: "Барнаул" },
    { names: ["Кафе Ромашка"], phones: [], domains: [], cities: ["барнаул"] },
  );
  assert.equal(status, "CANDIDATE");
});

test("AMBIGUOUS: похожее имя ≥ порога 0.85 без точного", () => {
  const { status, signals } = matchEntity(ENTITY, {
    names: ["Кафе Ромашки"],
    phones: [],
    domains: [],
    cities: [],
  });
  assert.equal(status, "AMBIGUOUS");
  const similar = signals.find((signal) => signal.signal === "name_similar");
  assert.equal(similar.matched, true);
  assert.match(similar.detail, /0\.8[0-9]|0\.9/);
});

test("NO_MATCH: ни один сигнал не сработал", () => {
  const { status } = matchEntity(ENTITY, {
    names: ["Пекарня Светлана"],
    phones: ["79990000000"],
    domains: ["other.example"],
    cities: ["Новосибирск"],
  });
  assert.equal(status, "NO_MATCH");
});

test("resolveEntityMatch: пустой мост — NO_MATCH с объяснением", () => {
  const result = resolveEntityMatch([], {
    names: ["Кафе Ромашка"],
    phones: [],
    domains: [],
    cities: [],
  });
  assert.equal(result.status, "NO_MATCH");
  assert.equal(result.entityId, null);
  assert.ok(result.explanation.length > 0);
});

test("resolveEntityMatch: равные претенденты принижаются до AMBIGUOUS", () => {
  const twin = (id) => ({
    id,
    displayName: "Кафе Ромашка",
    phone: null,
    website: null,
    city: null,
    identityKey: "domain:romashka.ru",
  });
  const result = resolveEntityMatch([twin("e-1"), twin("e-2")], {
    names: ["Кафе Ромашка"],
    phones: [],
    domains: ["romashka.ru"],
    cities: [],
  });
  assert.equal(result.status, "AMBIGUOUS", "равные EXACT не сливаются");
  assert.equal(result.entityId, null, "выбор не делается автоматически");
  assert.match(result.explanation, /AMBIGUOUS/);
});

test("resolveEntityMatch: лучший класс выигрывает, entityId заполняется", () => {
  const weak = {
    id: "e-weak",
    displayName: "Совсем другое",
    phone: null,
    website: null,
    city: null,
    identityKey: null,
  };
  const strong = {
    ...ENTITY,
    id: "e-strong",
    identityKey: "domain:romashka.ru",
  };
  const result = resolveEntityMatch([weak, strong], {
    names: ["Кафе Ромашка"],
    phones: [],
    domains: ["romashka.ru"],
    cities: [],
  });
  assert.equal(result.status, "EXACT");
  assert.equal(result.entityId, "e-strong");
  assert.ok(result.signals.some((signal) => signal.matched));
});
