import { cancelConnectionDeliveries } from "../outbox/cancel-connection.ts";
import { vkCall } from "../vk/api.ts";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { encryptSecret } from "./crypto.ts";
import { metaConfigured } from "../meta/config.ts";
import { isMetaPlatform } from "../channels/types.ts";

export class ConnectionService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly secret: string,
    private readonly fetchTelegram: typeof fetch = fetch,
  ) {}
  private async business(userId: string, publicId: string, write = true) {
    const row = await this.db
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
    if (write && row.role !== "owner" && row.role !== "admin")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Недостаточно прав для управления подключениями.",
      );
    return row.id;
  }
  private async audit(
    db: Kysely<Database>,
    businessId: string,
    actorUserId: string,
    action: "connection_connected" | "connection_disconnected",
  ) {
    await db
      .insertInto("business_audit_log")
      .values({
        id: randomUUID(),
        business_id: businessId,
        actor_user_id: actorUserId,
        action,
        target_user_id: null,
        details:
          "Сохранение или удаление токена; запуск обработки сообщений отдельно.",
      })
      .execute();
  }
  async list(userId: string, publicId: string) {
    const businessId = await this.business(userId, publicId, false);
    const rows = await this.db
      .selectFrom("business_connection as c")
      .leftJoin("meta_runtime as r", "r.connection_id", "c.id")
      .leftJoin("telegram_runtime as tr", "tr.connection_id", "c.id")
      .leftJoin("vk_runtime as vr", "vr.connection_id", "c.id")
      .select([
        "c.id",
        "c.platform",
        "c.display_name as displayName",
        "c.status",
        "c.created_at as createdAt",
        "c.updated_at as updatedAt",
        "r.display_phone_number as displayPhoneNumber",
        "r.ig_username as igUsername",
        "r.status as metaRuntimeStatus",
        "tr.status as telegramRuntimeStatus",
        "vr.status as vkRuntimeStatus",
        "r.webhook_subscribed as webhookSubscribed",
      ])
      .where("c.business_id", "=", businessId)
      .orderBy("c.platform")
      .execute();
    return rows.map((row) => {
      const runtimeStatus =
        row.platform === "telegram"
          ? row.telegramRuntimeStatus
          : row.platform === "vk"
            ? row.vkRuntimeStatus
            : row.metaRuntimeStatus;
      return {
        id: row.id,
        platform: row.platform,
        displayName: row.displayName,
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        runtimeStatus,
        ...(isMetaPlatform(row.platform)
          ? {
              displayPhoneNumber: row.displayPhoneNumber,
              igUsername: row.igUsername,
              webhookSubscribed: row.webhookSubscribed,
            }
          : {}),
      };
    });
  }
  async connect(userId: string, publicId: string, raw: unknown) {
    const businessId = await this.business(userId, publicId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError(
        400,
        "INVALID_CONNECTION",
        "Проверьте данные подключения.",
      );
    const body = raw as Record<string, unknown>;
    const platform = body.platform;
    const token = body.token;
    if (isMetaPlatform(platform)) {
      if (!metaConfigured())
        throw new AppError(
          503,
          "META_NOT_CONFIGURED",
          "Подключение Meta ещё не настроено на сервере. Используйте OAuth после настройки META_* переменных.",
        );
      throw new AppError(
        400,
        "OAUTH_REQUIRED",
        platform === "whatsapp"
          ? "WhatsApp подключается через Embedded Signup, а не токеном."
          : "Instagram подключается через Facebook Login, а не токеном.",
      );
    }
    if (platform !== "telegram" && platform !== "vk")
      throw new AppError(
        400,
        "INVALID_CONNECTION",
        "Выберите Telegram или VK.",
      );
    if (typeof token !== "string" || token.length < 10 || token.length > 4096)
      throw new AppError(
        400,
        "INVALID_CONNECTION",
        "Проверьте токен подключения.",
      );
    let externalAccountId: string | null = null;
    let displayName = platform === "telegram" ? "Telegram" : "VK";
    let status: "pending" | "connected" = "pending";
    if (platform === "telegram") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await this.fetchTelegram(
          `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`,
          { signal: controller.signal, cache: "no-store", redirect: "error" },
        );
        const payload = (await response.json().catch(() => null)) as {
          ok?: boolean;
          result?: {
            id?: number;
            is_bot?: boolean;
            username?: string;
            first_name?: string;
          };
        } | null;
        if (
          !response.ok ||
          !payload?.ok ||
          !Number.isSafeInteger(payload.result?.id) ||
          !payload.result?.is_bot
        )
          throw new AppError(
            400,
            "INVALID_CONNECTION",
            "Telegram не подтвердил этот токен.",
          );
        externalAccountId = String(payload.result.id);
        displayName = payload.result.username
          ? `@${payload.result.username}`
          : (payload.result.first_name ?? "Telegram");
        status = "connected";
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError(
          503,
          "CHANNEL_UNAVAILABLE",
          "Telegram временно недоступен. Попробуйте позже.",
        );
      } finally {
        clearTimeout(timer);
      }
    }
    if (platform === "vk") {
      const permissions = (await vkCall(
        token,
        "groups.getTokenPermissions",
        {},
        this.fetchTelegram,
      )) as { permissions?: { name: string; setting: number }[] };
      if (
        !permissions.permissions?.some(
          (p) => p.name === "messages" && p.setting > 0,
        ) ||
        !permissions.permissions?.some(
          (p) => p.name === "manage" && p.setting > 0,
        )
      )
        throw new AppError(
          400,
          "VK_PERMISSIONS_REQUIRED",
          "Для ключа сообщества нужны права сообщений и управления.",
        );
      const result = (await vkCall(
        token,
        "groups.getById",
        {},
        this.fetchTelegram,
      )) as { groups?: { id: number; name: string }[] };
      const group = result.groups?.[0];
      if (!group || !Number.isSafeInteger(group.id) || group.id <= 0)
        throw new AppError(
          400,
          "INVALID_CONNECTION",
          "VK не подтвердил сообщество этого токена.",
        );
      externalAccountId = String(group.id);
      displayName = group.name;
      status = "connected";
    }
    const id = randomUUID();
    try {
      await this.db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("business")
          .select("id")
          .where("id", "=", businessId)
          .forUpdate()
          .execute();
        await new ConnectionService(
          tx,
          this.secret,
          this.fetchTelegram,
        ).business(userId, publicId);

        // Reclaim stale/orphaned unique claims before insert.
        if (externalAccountId) {
          await this.reclaimStaleExternalClaim(
            tx,
            userId,
            businessId,
            platform,
            externalAccountId,
          );
        }

        const previous = await tx
          .selectFrom("business_connection")
          .select(["id", "external_account_id"])
          .where("business_id", "=", businessId)
          .where("platform", "=", platform)
          .executeTakeFirst();
        await tx
          .insertInto("business_connection")
          .values({
            id,
            business_id: businessId,
            platform,
            external_account_id: externalAccountId,
            display_name: displayName,
            status,
          })
          .onConflict((oc) =>
            oc
              .columns(["business_id", "platform"])
              .doUpdateSet({
                external_account_id: externalAccountId,
                display_name: displayName,
                status,
                updated_at: new Date(),
              }),
          )
          .execute();
        const connection = await tx
          .selectFrom("business_connection")
          .select("id")
          .where("business_id", "=", businessId)
          .where("platform", "=", platform)
          .executeTakeFirstOrThrow();
        if (previous && previous.external_account_id !== externalAccountId) {
          await cancelConnectionDeliveries(tx, connection.id);
          await tx
            .deleteFrom("telegram_runtime")
            .where("connection_id", "=", connection.id)
            .execute();
          await tx
            .deleteFrom("vk_runtime")
            .where("connection_id", "=", connection.id)
            .execute();
          await tx
            .updateTable("connection_secret")
            .set({ encrypted_publish_token: null })
            .where("connection_id", "=", connection.id)
            .execute();
        } else if (platform === "telegram")
          await tx
            .updateTable("telegram_runtime")
            .set({ status: "pending", updated_at: new Date() })
            .where("connection_id", "=", connection.id)
            .execute();
        else
          await tx
            .updateTable("vk_runtime")
            .set({ status: "pending", updated_at: new Date() })
            .where("connection_id", "=", connection.id)
            .execute();
        await tx
          .insertInto("connection_secret")
          .values({
            connection_id: connection.id,
            encrypted_token: encryptSecret(token, this.secret),
            key_version: 2,
          })
          .onConflict((oc) =>
            oc
              .column("connection_id")
              .doUpdateSet({
                encrypted_token: encryptSecret(token, this.secret),
                key_version: 2,
                updated_at: new Date(),
              }),
          )
          .execute();
        await this.audit(tx, businessId, userId, "connection_connected");
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      if ((error as { code?: string }).code === "23505") {
        throw await this.connectionConflictError(
          userId,
          businessId,
          platform,
          externalAccountId,
        );
      }
      throw error;
    }
    return { ok: true, status };
  }

  /**
   * Release unique (platform, external_account_id) held by archived/disconnected
   * rows so a new tenant can reconnect the same bot after account deletion.
   */
  private async reclaimStaleExternalClaim(
    tx: Transaction<Database>,
    userId: string,
    businessId: string,
    platform: "telegram" | "vk",
    externalAccountId: string,
  ) {
    const holders = await tx
      .selectFrom("business_connection as c")
      .innerJoin("business as b", "b.id", "c.business_id")
      .select([
        "c.id",
        "c.business_id",
        "c.status",
        "b.archived_at",
        "b.public_id",
        "b.name",
      ])
      .where("c.platform", "=", platform)
      .where("c.external_account_id", "=", externalAccountId)
      .execute();

    for (const holder of holders) {
      if (holder.business_id === businessId) continue;
      const stale =
        holder.archived_at != null || holder.status === "disconnected";
      if (stale) {
        await cancelConnectionDeliveries(tx, holder.id);
        await tx
          .deleteFrom("telegram_runtime")
          .where("connection_id", "=", holder.id)
          .execute();
        await tx
          .deleteFrom("vk_runtime")
          .where("connection_id", "=", holder.id)
          .execute();
        await tx
          .deleteFrom("meta_runtime")
          .where("connection_id", "=", holder.id)
          .execute();
        await tx
          .deleteFrom("connection_secret")
          .where("connection_id", "=", holder.id)
          .execute();
        await tx
          .updateTable("business_connection")
          .set({
            status: "disconnected",
            external_account_id: null,
            updated_at: new Date(),
          })
          .where("id", "=", holder.id)
          .execute();
        continue;
      }
      // Live claim elsewhere — resolve structured conflict (no cross-tenant leak).
      throw await this.connectionConflictFromHolder(tx, userId, holder);
    }
  }

  private async connectionConflictError(
    userId: string,
    businessId: string,
    platform: "telegram" | "vk",
    externalAccountId: string | null,
  ) {
    if (!externalAccountId) {
      return new AppError(
        409,
        "CONNECTION_EXISTS",
        "Подключение для этого канала уже сохранено.",
      );
    }
    const holder = await this.db
      .selectFrom("business_connection as c")
      .innerJoin("business as b", "b.id", "c.business_id")
      .select([
        "c.id",
        "c.business_id",
        "c.status",
        "b.archived_at",
        "b.public_id",
        "b.name",
      ])
      .where("c.platform", "=", platform)
      .where("c.external_account_id", "=", externalAccountId)
      .executeTakeFirst();
    if (!holder) {
      return new AppError(
        409,
        "CONNECTION_EXISTS",
        "Подключение уже существует. Обновите страницу и попробуйте снова.",
      );
    }
    if (holder.business_id === businessId) {
      return new AppError(
        409,
        "CONNECTION_EXISTS",
        "Этот канал уже подключён к текущему бизнесу.",
      );
    }
    return this.connectionConflictFromHolder(this.db, userId, holder);
  }

  private async connectionConflictFromHolder(
    db: Kysely<Database>,
    userId: string,
    holder: {
      business_id: string;
      public_id: string;
      name: string;
      status: string;
      archived_at: Date | null;
    },
  ) {
    const membership = await db
      .selectFrom("business_member")
      .select(["role", "status"])
      .where("business_id", "=", holder.business_id)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirst();
    if (membership) {
      return new AppError(
        409,
        "CONNECTION_IN_OTHER_BUSINESS",
        `Этот бот уже подключён к вашему бизнесу «${holder.name}». Отключите его там или выберите другой токен.`,
      );
    }
    return new AppError(
      409,
      "CONNECTION_IN_USE",
      "Этот бот уже используется другим пространством. Подключите другого бота или обратитесь в поддержку.",
    );
  }

  async disconnect(userId: string, publicId: string, platform: unknown) {
    const businessId = await this.business(userId, publicId);
    if (
      platform !== "telegram" &&
      platform !== "vk" &&
      platform !== "whatsapp" &&
      platform !== "instagram"
    )
      throw new AppError(400, "INVALID_CONNECTION", "Неизвестный канал.");
    const row = await this.db
      .selectFrom("business_connection")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", platform)
      .executeTakeFirst();
    if (!row)
      throw new AppError(
        404,
        "CONNECTION_NOT_FOUND",
        "Подключение не найдено.",
      );
    await this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .forUpdate()
        .execute();
      await new ConnectionService(tx, this.secret, this.fetchTelegram).business(
        userId,
        publicId,
      );
      await cancelConnectionDeliveries(tx, row.id);
      await tx
        .deleteFrom("telegram_runtime")
        .where("connection_id", "=", row.id)
        .execute();
      await tx
        .deleteFrom("vk_runtime")
        .where("connection_id", "=", row.id)
        .execute();
      await tx
        .deleteFrom("meta_runtime")
        .where("connection_id", "=", row.id)
        .execute();
      await tx
        .deleteFrom("connection_secret")
        .where("connection_id", "=", row.id)
        .execute();
      await tx
        .updateTable("business_connection")
        .set({
          status: "disconnected",
          external_account_id: null,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .execute();
      await this.audit(tx, businessId, userId, "connection_disconnected");
    });
    return { ok: true };
  }
}
