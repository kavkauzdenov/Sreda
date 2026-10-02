/**
 * Stage 4 (§26.5, §26.9): normalization layer и детерминированные
 * fingerprint'ы. Чистые функции — без БД и без сети.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changeFingerprint,
  factFingerprint,
  normalizeFactValue,
} from "../src/server/intelligence/osint/normalize.ts";

test("phone: общий с Stage 3 normalizePhone — 8→7, мусор отбрасывается", () => {
  assert.deepEqual(normalizeFactValue("phone", "8 (3852) 55-10-10"), {
    value: "73852551010",
    key: "73852551010",
  });
  assert.deepEqual(normalizeFactValue("phone", "+7 (999) 222-22-22"), {
    value: "79992222222",
    key: "79992222222",
  });
  assert.equal(normalizeFactValue("phone", "1234"), null, "меньше 10 цифр");
  assert.equal(normalizeFactValue("phone", "нет цифр"), null);
  assert.equal(
    normalizeFactValue("phone", "1234567890123456"),
    null,
    "больше 15 цифр",
  );
});

test("email: домен casefold, локальная часть сохраняется, мусор — null", () => {
  assert.deepEqual(normalizeFactValue("email", "  Info@Romashka.RU "), {
    value: "Info@romashka.ru",
    key: "info@romashka.ru",
  });
  assert.equal(normalizeFactValue("email", "не-почта"), null);
  assert.equal(normalizeFactValue("email", "a@b"), null, "нет точки в домене");
});

test("domain: схема/www/путь отбрасываются, subdomain остаётся доменным", () => {
  assert.deepEqual(
    normalizeFactValue("domain", "HTTPS://WWW.Romashka.ru/path?q=1"),
    { value: "romashka.ru", key: "romashka.ru" },
  );
  assert.deepEqual(normalizeFactValue("domain", "sub.romashka.ru"), {
    value: "sub.romashka.ru",
    key: "sub.romashka.ru",
  });
  assert.equal(normalizeFactValue("domain", "localhost"), null, "нет точки");
  assert.equal(normalizeFactValue("domain", "пример.рф/путь"), null, "не ASCII");
});

test("website: tracking-шум убран, параметры отсортированы, http≡https в key", () => {
  const withNoise = normalizeFactValue(
    "website",
    "https://Romashka.ru/?utm_source=x&b=2&a=1#frag",
  );
  assert.deepEqual(withNoise, {
    value: "https://romashka.ru?a=1&b=2",
    key: "romashka.ru?a=1&b=2",
  });
  const plain = normalizeFactValue("website", "http://romashka.ru/");
  const tls = normalizeFactValue("website", "https://romashka.ru/");
  assert.equal(plain.key, tls.key, "http и https — один факт");
  assert.equal(plain.value, "http://romashka.ru", "схема остаётся в value");
  assert.equal(normalizeFactValue("website", "romashka.ru"), null, "нет схемы");
  assert.equal(
    normalizeFactValue("website", "ftp://romashka.ru/"),
    null,
    "только http/https",
  );
});

test("social: network:handle, www/кейс/path-хвосты схлопываются", () => {
  assert.deepEqual(normalizeFactValue("vk", "https://www.vk.com/Example/"), {
    value: "vk:example",
    key: "vk:example",
  });
  assert.deepEqual(normalizeFactValue("telegram", "T.ME/Romashka"), {
    value: "telegram:romashka",
    key: "telegram:romashka",
  });
  assert.deepEqual(
    normalizeFactValue("instagram", "instagram.com/@Handle"),
    { value: "instagram:handle", key: "instagram:handle" },
  );
  assert.deepEqual(
    normalizeFactValue("youtube", "youtube.com/c/ChannelName"),
    { value: "youtube:c/channelname", key: "youtube:c/channelname" },
  );
  assert.deepEqual(normalizeFactValue("other_social", "https://x.com/some"), {
    value: "other:x.com/some",
    key: "other:x.com/some",
  });
  assert.equal(
    normalizeFactValue("other_social", "https://example.com/page"),
    null,
    "не соцсеть",
  );
});

test("address: ё→е и типовые сокращения, ключ — casefold", () => {
  const result = normalizeFactValue("address", "ул. Ленина,   д. 5");
  assert.equal(result.value, "улица Ленина, дом 5");
  assert.equal(result.key, "улица ленина, дом 5");
  const withYo = normalizeFactValue("address", "пер. Ёжёв");
  assert.equal(withYo.value, "переулок Ежев");
  assert.equal(withYo.key, "переулок ежев");
});

test("свободный текст: value — pretty, key — normalizeText (casefold)", () => {
  const name = normalizeFactValue("business_name", "  Кафе «Ромашка»  ");
  assert.equal(name.value, "Кафе «Ромашка»");
  assert.equal(name.key, "кафе ромашка");
  const hours = normalizeFactValue("opening_hours", "Пн–Пт 9:00–18:00");
  assert.equal(hours.value, "Пн–Пт 9:00–18:00");
  assert.equal(hours.key, "пн пт 9 00 18 00", "ключ — normalizeText(value)");
});

test("идентификаторы и индекс: консервативный trim/casefold, 6 цифр", () => {
  assert.deepEqual(
    normalizeFactValue("tax_identifier", "  ИНН 7701234567  "),
    { value: "ИНН 7701234567", key: "инн 7701234567" },
  );
  assert.deepEqual(normalizeFactValue("postal_code", "123 456"), {
    value: "123456",
    key: "123456",
  });
  assert.equal(normalizeFactValue("business_name", "   "), null, "пусто");
});

test("factFingerprint: детерминирован и чувствителен к каждому полю", () => {
  const base = {
    businessId: "b-1",
    factType: "phone",
    factKey: "79990000000",
    sourceId: "s-1",
  };
  const first = factFingerprint(base);
  assert.equal(first, factFingerprint({ ...base }), "стабильность");
  assert.match(first, /^[0-9a-f]{64}$/, "sha256 hex");
  assert.notEqual(first, factFingerprint({ ...base, businessId: "b-2" }));
  assert.notEqual(first, factFingerprint({ ...base, factType: "email" }));
  assert.notEqual(first, factFingerprint({ ...base, factKey: "79990000001" }));
  assert.notEqual(first, factFingerprint({ ...base, sourceId: "s-2" }));
});

test("changeFingerprint: охватывает переход целиком, пустое ≡ null", () => {
  const base = {
    businessId: "b-1",
    factType: "phone",
    factKey: "79991111111",
    changeKind: "VALUE_CHANGED",
    oldValue: "79990000000",
    newValue: "79991111111",
    sourceId: "s-1",
  };
  const first = changeFingerprint(base);
  assert.equal(first, changeFingerprint({ ...base }), "стабильность");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(
    changeFingerprint({ ...base, oldValue: null }),
    changeFingerprint({ ...base, oldValue: "" }),
    "null и пустая строка — один отпечаток",
  );
  assert.notEqual(first, changeFingerprint({ ...base, changeKind: "FIRST_SEEN" }));
  assert.notEqual(first, changeFingerprint({ ...base, sourceId: null }));
  assert.notEqual(first, changeFingerprint({ ...base, oldValue: "79992222222" }));
});
