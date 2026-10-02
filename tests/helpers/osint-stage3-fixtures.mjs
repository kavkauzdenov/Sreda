/**
 * Посадочные данные Stage 3 для интеграционных сьютов.
 *
 * Один общий модуль для `tests/postgres/*` (настоящая PostgreSQL 17) и
 * `tests/http/*` (production routes): один и тот же слой данных вместо
 * продублированного посадочного кода в каждом сьюте.
 *
 * Схему не меняет — пишет только в существующие таблицы Stage 2/3 и
 * использует те же helpers, что и PGlite-юниты (`ensureBusinessEntity`,
 * `buildDiscoveryProfile`), чтобы интеграционный сценарий не отличался
 * от того, что уже проверено на юнитах.
 */
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { buildDiscoveryProfile } from "../../src/server/intelligence/osint/profile.ts";
import { ensureBusinessEntity } from "../../src/server/intelligence/osint/entity-graph.ts";

/** Нормализованные телефонные значения из §24 (сравнимы без учёта формата). */
export const PHONE_A = "73852551010";
export const PHONE_B = "73852552233";

/** Два наблюдения с одним и тем же фактом — материал для corroboration. */
export const RICH_A =
  "Кафе. Телефон: 8 (3852) 55-10-10. Почта: info@romashka.ru. " +
  "Сайт: https://romashka.ru/";
export const RICH_B =
  "Кафе в Барнауле. Телефон: +7 (3852) 55-10-10. Почта: info@romashka.ru. " +
  "Сайт: https://romashka.ru/";

/** Текст без извлекаемых фактов: observation валиден, но claims не даёт. */
export const NO_CLAIM_TEXT = "Обычный текст страницы без координат и контактов.";

/**
 * Короткая метка сценария.
 *
 * Сущности Stage 2 глобальны: `ensureBusinessEntity` резолвит их по
 * `identity_key` (domain/phone). Профиль здесь намеренно без домена и
 * телефона, поэтому ключа нет и каждый новый бизнес получает свою сущность —
 * но уникальная метка делает ожидания теста читаемыми и защищает от
 * склейки `display_name`, если профиль когда-нибудь начнёт детектить домен.
 */
export function uniqueLabel(prefix) {
  return `${prefix} ${randomBytes(3).toString("hex")}`;
}

export async function makeUser(db, name = "User") {
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

/**
 * `role` ограничен CHECK'ом `('owner','admin','operator')` (002) —
 * передавайте только эти значения, если тест не проверяет отказ constraints.
 */
export async function makeBusiness(
  db,
  ownerId,
  name = "Biz",
  { role = "owner", status = "active" } = {},
) {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      public_id: "biz_" + randomUUID().replaceAll("-", "").slice(0, 16),
      name,
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: row.id,
      user_id: ownerId,
      role,
      status,
    })
    .execute();
  return row;
}

/** Пользователь + бизнес + закреплённая за ним глобальная сущность Stage 2. */
export async function scenario(db, prefix) {
  const label = uniqueLabel(prefix);
  const userId = await makeUser(db, label);
  const business = await makeBusiness(db, userId, label);
  const entityId = await ensureBusinessEntity(db, {
    businessId: business.id,
    profile: buildDiscoveryProfile({
      name: label,
      description: `${label} — тестовое заведение.`,
      industry: "food",
    }),
  });
  return { userId, business, entityId, label };
}

export function contentHash(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export async function createSource(db, url) {
  const sourceId = randomUUID();
  const resolved = url ?? `https://src-${sourceId.slice(0, 8)}.example.org/`;
  await db
    .insertInto("osint_sources")
    .values({
      id: sourceId,
      type: "website",
      provider: "mock",
      url: resolved,
      normalized_url: resolved,
      name: "Наблюдаемый источник",
      created_at: new Date(),
      updated_at: new Date(),
    })
    .execute();
  return { sourceId, url: resolved };
}

export async function attachSource(db, entityId, sourceId) {
  await db
    .insertInto("osint_entity_sources")
    .values({
      entity_id: entityId,
      source_id: sourceId,
      confidence: "1",
      created_at: new Date(),
    })
    .execute();
}

/**
 * Одно наблюдение. `contentHash` по умолчанию — sha256(content), как у
 * боевого writer'а; специальное значение передаётся только тестам constraints
 * и битых строк.
 */
export async function addObservation(
  db,
  { entityId, sourceId, content, kind = "page", observedAt, contentHash: hash },
) {
  const observationId = randomUUID();
  await db
    .insertInto("osint_observations")
    .values({
      id: observationId,
      source_id: sourceId,
      entity_id: entityId,
      content,
      content_hash: hash ?? contentHash(content),
      kind,
      observed_at: observedAt,
      created_at: new Date(),
    })
    .execute();
  return observationId;
}

/**
 * Пачка наблюдений одним запросом — нужно для проверки `ASSESSMENT_LIMIT`,
 * где 205 отдельных INSERT'ов только замедляли бы тест.
 *
 * Содержимое различается, потому что `UNIQUE (source_id, content_hash)`
 * держит настоящую гарантию writer'а: один и тот же материал на одном
 * источнике не должен давать вторую строку.
 */
export async function addObservations(db, { entityId, sourceId, count, contentOf }) {
  const ids = [];
  const values = [];
  for (let index = 0; index < count; index += 1) {
    const id = randomUUID();
    const content = contentOf(index);
    ids.push(id);
    values.push({
      id,
      source_id: sourceId,
      entity_id: entityId,
      content,
      content_hash: contentHash(content),
      kind: "page",
      created_at: new Date(),
    });
  }
  await db
    .insertInto("osint_observations")
    .values(values)
    .execute();
  return ids;
}

/**
 * Текст ошибки PostgreSQL вместе с `cause`: Kysely оборачивает ошибку
 * драйвера, и `error.message` одного уровня может не содержать имя
 * ограничения.
 */
export function pgErrorText(error) {
  const parts = [String(error)];
  let cursor = error;
  for (let depth = 0; depth < 4 && cursor; depth += 1) {
    if (cursor.message) parts.push(cursor.message);
    if (cursor.code) parts.push(String(cursor.code));
    cursor = cursor.cause;
  }
  return parts.join(" | ");
}

/** Ожидаемый отказ PostgreSQL: код класса и/или имя ограничения. */
export async function expectPgRejection(run, { code, constraint }) {
  let caught;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "PostgreSQL должна была отклонить запрос");
  const text = pgErrorText(caught);
  if (code) {
    assert.ok(
      text.includes(code),
      `ожидался SQLSTATE ${code}, получено: ${text}`,
    );
  }
  if (constraint) {
    assert.ok(
      text.includes(constraint),
      `ожидалось ограничение ${constraint}, получено: ${text}`,
    );
  }
  return caught;
}
