import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Инварианты файлов миграций.
 *
 * Раннер режет SQL по `;` и выполняет куски как есть. Поэтому `;` внутри
 * `--` комментария разрезает комментарий, и его хвост попадает в SQL —
 * ровно та ошибка, что вызывала «syntax error at or near <русское слово>» в
 * 524 тестах разом. Проверка ловит это до применения, а не после.
 */

const dir = fileURLToPath(new URL("../migrations", import.meta.url));
const files = readdirSync(dir)
  .filter((name) => /^\d+_[\w-]+\.sql$/.test(name))
  .sort();

function read(name) {
  return readFileSync(join(dir, name), "utf8");
}

test("миграции существуют и нумеруются подряд", () => {
  assert.ok(files.length > 0, "нет ни одной миграции");
  const numbers = files.map((name) => Number(name.slice(0, 3)));
  for (let i = 1; i < numbers.length; i += 1) {
    assert.equal(
      numbers[i],
      numbers[i - 1] + 1,
      `пропуск в нумерации: ${files[i - 1]} → ${files[i]}`,
    );
  }
});

test("ни в одной миграции нет `;` внутри строчного комментария", () => {
  for (const name of files) {
    const offenders = read(name)
      .split("\n")
      .map((line, index) => ({ line: index + 1, text: line }))
      .filter(({ text }) => /^\s*--/.test(text) && text.includes(";"));
    assert.deepEqual(
      offenders,
      [],
      `${name}: ` +
        offenders.map((o) => `строка ${o.line}: ${o.text.trim()}`).join(" | "),
    );
  }
});

test("ни в одной миграции нет `;` внутри строкового литерала", () => {
  for (const name of files) {
    const sql = read(name)
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .join("\n");
    // Грубая, но действенная проверка: одинарные кавычки должны пароваться,
    // и ни одна пара не должна содержать `;` между открытием и закрытием.
    const offenders = sql.match(/'[^'\n]*;[^'\n]*'/g) ?? [];
    assert.deepEqual(
      offenders,
      [],
      `${name}: точка с запятой внутри строкового литерала: ${offenders.join(" | ")}`,
    );
  }
});

test("числовые CHECK в миграциях не содержат `$$` процедурных тел", () => {
  // Раннер не умеет $$ ... $$ — это типичный источник тихой поломки.
  for (const name of files) {
    const offenders = read(name)
      .split("\n")
      .filter((line) => !/^\s*--/.test(line) && line.includes("$$"));
    assert.deepEqual(offenders, [], `${name}: недопустимое процедурное тело`);
  }
});

test("075 добавляет таблицы агента и не трогает чужие", () => {
  const sql = read("075_osint_research_agent_v1.sql");
  for (const table of [
    "osint_research_actions",
    "osint_research_hypotheses",
    "osint_source_access",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  // Никаких разрушительных операций по production-данным.
  assert.doesNotMatch(sql, /^\s*(DROP TABLE|TRUNCATE|DELETE FROM)/m);
});

test("глобальная память источников не получает business_id", () => {
  // Инвариант из 070: у глобальной таблицы нет ни business_id, ни FK на тенанта.
  const sql = read("075_osint_research_agent_v1.sql");
  const block = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS osint_source_access"));
  const table = block.slice(0, block.indexOf(");"));
  assert.equal(table.includes("business_id"), false, "business_id в глобальной таблице");
  assert.doesNotMatch(table, /REFERENCES\s+"?user"?/i);
});

test("тенант-скоуп остаётся на действиях и гипотезах", () => {
  const sql = read("075_osint_research_agent_v1.sql");
  for (const table of ["osint_research_actions", "osint_research_hypotheses"]) {
    const block = sql.slice(sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
    const body = block.slice(0, block.indexOf(");"));
    assert.match(
      body,
      /business_id uuid NOT NULL REFERENCES business \(id\) ON DELETE CASCADE/,
      `${table} должен быть tenant-scoped с каскадным удалением`,
    );
  }
});

test("у действий и гипотез есть dedupe-ключ с UNIQUE — идемпотентность на БД", () => {
  const sql = read("075_osint_research_agent_v1.sql");
  assert.match(sql, /osint_research_actions_dedupe UNIQUE \(run_id, dedupe_key\)/);
  assert.match(
    sql,
    /osint_research_hypotheses_dedupe UNIQUE \(run_id, dedupe_key\)/,
  );
});

test("идемпотентность: повторное применение не падает", () => {
  const sql = read("075_osint_research_agent_v1.sql");
  const creates = sql.match(/CREATE TABLE(?! IF NOT EXISTS)/g) ?? [];
  const columns = sql.match(/ADD COLUMN(?! IF NOT EXISTS)/g) ?? [];
  const indexes = sql.match(/CREATE INDEX(?! IF NOT EXISTS)/g) ?? [];
  const uniqueIndexes = sql.match(/CREATE UNIQUE INDEX(?! IF NOT EXISTS)/g) ?? [];
  assert.deepEqual(creates, [], "все CREATE TABLE должны быть IF NOT EXISTS");
  assert.deepEqual(columns, [], "все ADD COLUMN должны быть IF NOT EXISTS");
  assert.deepEqual(indexes, [], "все CREATE INDEX должны быть IF NOT EXISTS");
  assert.deepEqual(uniqueIndexes, [], "все CREATE UNIQUE INDEX должны быть IF NOT EXISTS");
});

test("статус run не расширяется — фаза вынесена в отдельную колонку", () => {
  const sql = read("075_osint_research_agent_v1.sql");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS phase text/);
  assert.doesNotMatch(
    sql,
    /ALTER TABLE osint_discovery_runs ALTER COLUMN status/,
    "статус run зафиксирован контрактом и asserted в тестах",
  );
});
