import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { encryptSecret } from "../connections/crypto.ts";
import { cancelConnectionDeliveries } from "../outbox/cancel-connection.ts";
import {
  exchangeOAuthCode,
  metaGraph,
} from "./api.ts";
import {
  metaConfigured,
  metaPublicStatus,
  readMetaConfig,
} from "./config.ts";
import type { MetaPlatform } from "../channels/types.ts";

function hashState(state: string) {
  return createHash("sha256").update(state).digest("hex");
}

async function requireBusinessWrite(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
) {
  const row = await db
    .selectFrom("business_member as member")
    .innerJoin("business", "business.id", "member.business_id")
    .select(["business.id", "member.role"])
    .where("business.public_id", "=", publicId)
    .where("business.archived_at", "is", null)
    .where("member.user_id", "=", userId)
    .where("member.status", "=", "active")
    .executeTakeFirst();
  if (!row)
    throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
  if (row.role !== "owner" && row.role !== "admin")
    throw new AppError(
      403,
      "FORBIDDEN",
      "Недостаточно прав для управления подключениями.",
    );
  return row.id;
}

export async function createOAuthState(
  db: Kysely<Database>,
  businessId: string,
  userId: string,
  platform: MetaPlatform,
) {
  if (!metaConfigured())
    throw new AppError(
      503,
      "META_NOT_CONFIGURED",
      "Подключение Meta ещё не настроено на сервере.",
    );
  const state = randomBytes(32).toString("hex");
  const id = randomUUID();
  await db
    .insertInto("meta_oauth_state")
    .values({
      id,
      business_id: businessId,
      user_id: userId,
      platform,
      state_hash: hashState(state),
      status: "pending",
      payload: JSON.stringify({}),
      expires_at: new Date(Date.now() + 10 * 60 * 1000),
      consumed_at: null,
    })
    .execute();
  return {
    state,
    stateId: id,
    ...metaPublicStatus(),
  };
}

export async function consumeOAuthState(
  db: Kysely<Database>,
  state: string,
  platform: MetaPlatform,
  userId: string,
  businessId: string,
) {
  if (typeof state !== "string" || state.length < 16 || state.length > 200)
    throw new AppError(400, "INVALID_OAUTH_STATE", "Сессия авторизации устарела.");
  const row = await db
    .selectFrom("meta_oauth_state")
    .selectAll()
    .where("state_hash", "=", hashState(state))
    .where("platform", "=", platform)
    .where("user_id", "=", userId)
    .where("business_id", "=", businessId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!row || row.expires_at.getTime() < Date.now())
    throw new AppError(400, "INVALID_OAUTH_STATE", "Сессия авторизации устарела.");
  const updated = await db
    .updateTable("meta_oauth_state")
    .set({ status: "consumed", consumed_at: new Date() })
    .where("id", "=", row.id)
    .where("status", "=", "pending")
    .returning("id")
    .executeTakeFirst();
  if (!updated)
    throw new AppError(400, "INVALID_OAUTH_STATE", "Сессия авторизации устарела.");
  return row;
}

export async function completeWhatsAppEmbeddedSignup(options: {
  db: Kysely<Database>;
  secret: string;
  userId: string;
  publicId: string;
  code: string;
  redirectUri: string;
  state: string;
  wabaId: string;
  phoneNumberId: string;
  transport?: typeof fetch;
}) {
  const businessId = await requireBusinessWrite(
    options.db,
    options.userId,
    options.publicId,
  );
  await consumeOAuthState(
    options.db,
    options.state,
    "whatsapp",
    options.userId,
    businessId,
  );
  if (
    typeof options.wabaId !== "string" ||
    !options.wabaId.trim() ||
    typeof options.phoneNumberId !== "string" ||
    !options.phoneNumberId.trim()
  )
    throw new AppError(
      400,
      "INVALID_WHATSAPP_SIGNUP",
      "Не получены идентификаторы WhatsApp Business. Повторите подключение.",
    );
  const { accessToken } = await exchangeOAuthCode(
    options.code,
    options.redirectUri,
  );
  const phone = await metaGraph<{
    display_phone_number?: string;
    verified_name?: string;
  }>(options.phoneNumberId.trim(), {
    accessToken,
    search: { fields: "display_phone_number,verified_name" },
    transport: options.transport,
  });
  const displayPhone = phone.display_phone_number?.trim() || options.phoneNumberId;
  const displayName =
    phone.verified_name?.trim() ||
    `WhatsApp ${displayPhone}`;
  const connectionId = randomUUID();
  const generation = randomUUID();
  await options.db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", businessId)
      .forUpdate()
      .execute();
    const previous = await tx
      .selectFrom("business_connection")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", "whatsapp")
      .executeTakeFirst();
    await tx
      .insertInto("business_connection")
      .values({
        id: connectionId,
        business_id: businessId,
        platform: "whatsapp",
        external_account_id: options.phoneNumberId.trim(),
        display_name: displayName,
        status: "connected",
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "platform"]).doUpdateSet({
          external_account_id: options.phoneNumberId.trim(),
          display_name: displayName,
          status: "connected",
          updated_at: new Date(),
        }),
      )
      .execute();
    const connection = await tx
      .selectFrom("business_connection")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", "whatsapp")
      .executeTakeFirstOrThrow();
    if (previous && previous.id !== connection.id) {
      await cancelConnectionDeliveries(tx, previous.id);
      await tx
        .deleteFrom("meta_runtime")
        .where("connection_id", "=", previous.id)
        .execute();
    } else if (previous) {
      await cancelConnectionDeliveries(tx, connection.id);
    }
    await tx
      .insertInto("connection_secret")
      .values({
        connection_id: connection.id,
        encrypted_token: encryptSecret(accessToken, options.secret),
        key_version: 2,
      })
      .onConflict((oc) =>
        oc.column("connection_id").doUpdateSet({
          encrypted_token: encryptSecret(accessToken, options.secret),
          key_version: 2,
          updated_at: new Date(),
        }),
      )
      .execute();
    await tx
      .insertInto("meta_runtime")
      .values({
        connection_id: connection.id,
        generation,
        status: "pending",
        waba_id: options.wabaId.trim(),
        phone_number_id: options.phoneNumberId.trim(),
        display_phone_number: displayPhone,
        page_id: null,
        ig_user_id: null,
        ig_username: null,
        webhook_subscribed: false,
        last_error: null,
      })
      .onConflict((oc) =>
        oc.column("connection_id").doUpdateSet({
          generation,
          status: "pending",
          waba_id: options.wabaId.trim(),
          phone_number_id: options.phoneNumberId.trim(),
          display_phone_number: displayPhone,
          page_id: null,
          ig_user_id: null,
          ig_username: null,
          webhook_subscribed: false,
          last_error: null,
          updated_at: new Date(),
        }),
      )
      .execute();
    await tx
      .insertInto("business_audit_log")
      .values({
        id: randomUUID(),
        business_id: businessId,
        actor_user_id: options.userId,
        action: "connection_connected",
        target_user_id: null,
        details: "WhatsApp подключён через Meta Embedded Signup.",
      })
      .execute();
  });
  return { ok: true as const, platform: "whatsapp" as const, displayName };
}

export type InstagramPageCandidate = {
  pageId: string;
  pageName: string;
  igUserId: string;
  igUsername: string | null;
  /** Short-lived page token for finalize — never shown in UI responses after select. */
  accessToken: string;
};

export async function completeInstagramLogin(options: {
  db: Kysely<Database>;
  userId: string;
  publicId: string;
  code: string;
  redirectUri: string;
  state: string;
  transport?: typeof fetch;
}) {
  const businessId = await requireBusinessWrite(
    options.db,
    options.userId,
    options.publicId,
  );
  await consumeOAuthState(
    options.db,
    options.state,
    "instagram",
    options.userId,
    businessId,
  );
  const { accessToken: userToken } = await exchangeOAuthCode(
    options.code,
    options.redirectUri,
  );
  const pages = await metaGraph<{
    data?: {
      id: string;
      name?: string;
      access_token?: string;
      instagram_business_account?: { id: string; username?: string };
    }[];
  }>("me/accounts", {
    accessToken: userToken,
    search: {
      fields:
        "id,name,access_token,instagram_business_account{id,username}",
    },
    transport: options.transport,
  });
  const candidates: InstagramPageCandidate[] = [];
  for (const page of pages.data ?? []) {
    if (
      !page.id ||
      !page.access_token ||
      !page.instagram_business_account?.id
    )
      continue;
    candidates.push({
      pageId: page.id,
      pageName: page.name || page.id,
      igUserId: page.instagram_business_account.id,
      igUsername: page.instagram_business_account.username ?? null,
      accessToken: page.access_token,
    });
  }
  if (!candidates.length)
    throw new AppError(
      400,
      "INSTAGRAM_ACCOUNT_REQUIRED",
      "Не найдена профессиональная страница Instagram, связанная с Facebook Page.",
    );
  return {
    ok: true as const,
    platform: "instagram" as const,
    candidates: candidates.map((c) => ({
      pageId: c.pageId,
      pageName: c.pageName,
      igUserId: c.igUserId,
      igUsername: c.igUsername,
      // Temporary handoff token for selectInstagramAccount only — UI must not display.
      accessToken: c.accessToken,
    })),
  };
}

export async function selectInstagramAccount(options: {
  db: Kysely<Database>;
  secret: string;
  userId: string;
  publicId: string;
  pageId: string;
  igUserId: string;
  accessToken: string;
  igUsername?: string | null;
  pageName?: string | null;
  transport?: typeof fetch;
}) {
  const businessId = await requireBusinessWrite(
    options.db,
    options.userId,
    options.publicId,
  );
  if (
    typeof options.pageId !== "string" ||
    !options.pageId.trim() ||
    typeof options.igUserId !== "string" ||
    !options.igUserId.trim() ||
    typeof options.accessToken !== "string" ||
    options.accessToken.length < 10
  )
    throw new AppError(
      400,
      "INVALID_INSTAGRAM_ACCOUNT",
      "Выберите аккаунт Instagram для подключения.",
    );
  let igUsername = options.igUsername?.trim() || null;
  if (!igUsername) {
    try {
      const ig = await metaGraph<{ username?: string }>(options.igUserId.trim(), {
        accessToken: options.accessToken,
        search: { fields: "username" },
        transport: options.transport,
      });
      igUsername = ig.username?.trim() || null;
    } catch {
      igUsername = null;
    }
  }
  const displayName = igUsername
    ? `@${igUsername.replace(/^@/, "")}`
    : options.pageName?.trim() || "Instagram";
  const connectionId = randomUUID();
  const generation = randomUUID();
  await options.db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", businessId)
      .forUpdate()
      .execute();
    const previous = await tx
      .selectFrom("business_connection")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", "instagram")
      .executeTakeFirst();
    await tx
      .insertInto("business_connection")
      .values({
        id: connectionId,
        business_id: businessId,
        platform: "instagram",
        external_account_id: options.igUserId.trim(),
        display_name: displayName,
        status: "connected",
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "platform"]).doUpdateSet({
          external_account_id: options.igUserId.trim(),
          display_name: displayName,
          status: "connected",
          updated_at: new Date(),
        }),
      )
      .execute();
    const connection = await tx
      .selectFrom("business_connection")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", "instagram")
      .executeTakeFirstOrThrow();
    if (previous) await cancelConnectionDeliveries(tx, connection.id);
    await tx
      .insertInto("connection_secret")
      .values({
        connection_id: connection.id,
        encrypted_token: encryptSecret(options.accessToken, options.secret),
        key_version: 2,
      })
      .onConflict((oc) =>
        oc.column("connection_id").doUpdateSet({
          encrypted_token: encryptSecret(options.accessToken, options.secret),
          key_version: 2,
          updated_at: new Date(),
        }),
      )
      .execute();
    await tx
      .insertInto("meta_runtime")
      .values({
        connection_id: connection.id,
        generation,
        status: "pending",
        waba_id: null,
        phone_number_id: null,
        display_phone_number: null,
        page_id: options.pageId.trim(),
        ig_user_id: options.igUserId.trim(),
        ig_username: igUsername,
        webhook_subscribed: false,
        last_error: null,
      })
      .onConflict((oc) =>
        oc.column("connection_id").doUpdateSet({
          generation,
          status: "pending",
          page_id: options.pageId.trim(),
          ig_user_id: options.igUserId.trim(),
          ig_username: igUsername,
          webhook_subscribed: false,
          last_error: null,
          updated_at: new Date(),
        }),
      )
      .execute();
    await tx
      .insertInto("business_audit_log")
      .values({
        id: randomUUID(),
        business_id: businessId,
        actor_user_id: options.userId,
        action: "connection_connected",
        target_user_id: null,
        details: "Instagram подключён через Facebook Login.",
      })
      .execute();
  });
  return { ok: true as const, platform: "instagram" as const, displayName };
}

export function metaStartPayload(platform: MetaPlatform) {
  const config = readMetaConfig();
  const status = metaPublicStatus();
  if (!status.configured)
    throw new AppError(
      503,
      "META_NOT_CONFIGURED",
      "Подключение Meta ещё не настроено на сервере.",
    );
  if (platform === "whatsapp" && !status.whatsappEmbeddedSignupReady)
    throw new AppError(
      503,
      "WHATSAPP_CONFIG_REQUIRED",
      "Для WhatsApp нужна настройка Embedded Signup (config_id).",
    );
  if (platform === "instagram" && !status.instagramLoginReady)
    throw new AppError(
      503,
      "INSTAGRAM_CONFIG_REQUIRED",
      "Для Instagram нужна настройка Facebook Login (config_id).",
    );
  return {
    ...status,
    platform,
    appId: config.appId,
    configId:
      platform === "whatsapp"
        ? config.whatsappConfigId
        : config.instagramConfigId,
  };
}
