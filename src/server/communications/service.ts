import { requireUuid } from "../http/validation.ts";
import { messageChunks } from "../outbox/text.ts";
import { audit } from "../audit/service.ts";
import {
  recordAttachments,
  type InboundAttachment,
} from "../attachments/service.ts";
import { matchClient, clientActivity } from "../clients/service.ts";
import { notify } from "../notifications/service.ts";
import { requireBusiness } from "../access/permissions.ts";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { whatsappSessionOpen } from "../meta/api.ts";
import { isChannelPlatform } from "../channels/types.ts";

type Platform = "telegram" | "vk" | "whatsapp" | "instagram";
type ConversationStatus = "open" | "assigned" | "closed" | "blocked";

function text(value: unknown, max = 10000) {
  if (typeof value !== "string")
    throw new AppError(400, "INVALID_MESSAGE", "Введите текст сообщения.");
  const result = value.trim();
  if (
    !result ||
    result.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result)
  ) {
    throw new AppError(400, "INVALID_MESSAGE", "Проверьте текст сообщения.");
  }
  return result;
}

export class CommunicationService {
  constructor(private readonly db: Kysely<Database>) {}

  private async resolve(userId: string, publicId: string, write = false) {
    const row = await this.db
      .selectFrom("business_member")
      .innerJoin("business", "business.id", "business_member.business_id")
      .select(["business.id", "business_member.role"])
      .where("business.public_id", "=", publicId)
      .where("business.archived_at", "is", null)
      .where("business_member.user_id", "=", userId)
      .where("business_member.status", "=", "active")
      .executeTakeFirst();
    if (!row)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
    if (
      write &&
      row.role !== "owner" &&
      row.role !== "admin" &&
      row.role !== "operator"
    ) {
      throw new AppError(
        403,
        "FORBIDDEN",
        "Недостаточно прав для работы с сообщениями.",
      );
    }
    return row;
  }

  async listConversations(
    userId: string,
    publicId: string,
    status?: ConversationStatus,
    page = 0,
    platform?: Platform,
  ) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
      throw new AppError(400, "INVALID_PAGE", "Проверьте страницу.");
    const businessId = (await this.resolve(userId, publicId)).id;
    if (status && !["open", "assigned", "closed", "blocked"].includes(status)) {
      throw new AppError(400, "INVALID_STATUS", "Неизвестный статус диалога.");
    }
    if (platform && !isChannelPlatform(platform))
      throw new AppError(400, "INVALID_PLATFORM", "Неизвестная площадка.");
    let query = this.db
      .selectFrom("communication_conversation")
      .select([
        "id",
        "platform",
        "external_user_id as externalUserId",
        "external_username as externalUsername",
        "client_id as clientId",
        "status",
        "assigned_member_user_id as assignedMemberUserId",
        "last_message_at as lastMessageAt",
        "last_inbound_at as lastInboundAt",
        "created_at as createdAt",
      ])
      .where("business_id", "=", businessId)
      .orderBy("last_message_at", "desc")
      .orderBy("id", "desc")
      .limit(100)
      .offset(page * 100);
    if (status) query = query.where("status", "=", status) as typeof query;
    if (platform)
      query = query.where("platform", "=", platform) as typeof query;
    const conversations = await query.execute();
    return Promise.all(
      conversations.map(async (row) => {
        const read = await this.db
          .selectFrom("conversation_read_state")
          .select("read_at")
          .where("conversation_id", "=", row.id)
          .where("user_id", "=", userId)
          .executeTakeFirst();
        const unread = await this.db
          .selectFrom("communication_message")
          .select((eb) => eb.fn.countAll<string>().as("count"))
          .where("conversation_id", "=", row.id)
          .where("direction", "=", "inbound")
          .where("created_at", ">", read?.read_at ?? new Date(0))
          .executeTakeFirstOrThrow();
        const last = await this.db
          .selectFrom("communication_message")
          .select(["text", "direction", "created_at"])
          .where("conversation_id", "=", row.id)
          .orderBy("created_at", "desc")
          .limit(1)
          .executeTakeFirst();
        const employee = row.assignedMemberUserId
          ? await this.db
              .selectFrom("user")
              .select("name")
              .where("id", "=", row.assignedMemberUserId)
              .executeTakeFirst()
          : null;
        const client = row.clientId
          ? await this.db
              .selectFrom("client")
              .select("name")
              .where("business_id", "=", businessId)
              .where("id", "=", row.clientId)
              .executeTakeFirst()
          : null;
        const waitingSince =
          row.status !== "closed" &&
          row.status !== "blocked" &&
          last?.direction === "inbound" &&
          (row.lastInboundAt ?? last.created_at)
            ? (row.lastInboundAt ?? last.created_at).toISOString()
            : null;
        return {
          ...row,
          clientName: client?.name,
          unread: Number(unread.count),
          lastMessage: last?.text ?? "",
          assignedName: employee?.name,
          lastMessageAt: row.lastMessageAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          waitingSince,
          lastInboundAt: row.lastInboundAt
            ? row.lastInboundAt.toISOString()
            : null,
        };
      }),
    );
  }

  async listMessages(
    userId: string,
    publicId: string,
    conversationId: string,
    page = 0,
  ) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
      throw new AppError(400, "INVALID_PAGE", "Проверьте страницу.");
    requireUuid(conversationId);
    const businessId = (await this.resolve(userId, publicId)).id;
    const conversation = await this.db
      .selectFrom("communication_conversation")
      .select("id")
      .where("id", "=", conversationId)
      .where("business_id", "=", businessId)
      .executeTakeFirst();
    if (!conversation)
      throw new AppError(404, "CONVERSATION_NOT_FOUND", "Диалог не найден.");
    const rows = await this.db
      .selectFrom("communication_message")
      .select([
        "id",
        "direction",
        "text",
        "external_message_id as externalMessageId",
        "actor_user_id as actorUserId",
        "moderation_status as moderationStatus",
        "delivery_status as deliveryStatus",
        "created_at as createdAt",
      ])
      .where("conversation_id", "=", conversationId)
      .where("business_id", "=", businessId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(500)
      .offset(page * 500)
      .execute();
    const latest = rows[0]?.createdAt;
    if (latest)
      await this.db
        .insertInto("conversation_read_state")
        .values({
          business_id: businessId,
          conversation_id: conversationId,
          user_id: userId,
          read_at: latest,
        })
        .onConflict((oc) =>
          oc.columns(["conversation_id", "user_id"]).doUpdateSet((eb) => ({
            read_at: eb.fn<Date>("greatest", [
              eb.ref("conversation_read_state.read_at"),
              eb.val(latest),
            ]),
          })),
        )
        .execute();
    return Promise.all(
      rows.reverse().map(async (row) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        attachments: await this.db
          .selectFrom("communication_attachment as ca")
          .innerJoin("attachment as a", "a.id", "ca.attachment_id")
          .select([
            "a.id",
            "a.type",
            "a.filename",
            "a.mime_type as mime",
            "a.size_bytes as size",
          ])
          .where("ca.message_id", "=", row.id)
          .where("ca.business_id", "=", businessId)
          .execute(),
      })),
    );
  }

  async sendMessage(
    userId: string,
    publicId: string,
    conversationId: string,
    raw: unknown,
  ) {
    await this.resolve(userId, publicId, true);
    requireUuid(conversationId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError(400, "INVALID_MESSAGE", "Проверьте сообщение.");
    const body = raw as Record<string, unknown>;
    const attachmentIds = Array.isArray(body.attachments)
      ? [...new Set(body.attachments.map(String))]
      : [];
    if (
      attachmentIds.length > 10 ||
      attachmentIds.some(
        (id) =>
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            id,
          ),
      )
    )
      throw new AppError(400, "INVALID_ATTACHMENT", "Проверьте вложения.");
    const message = text(body.text || (attachmentIds.length ? "Вложение" : ""));
    requireUuid(conversationId);
    const businessId = (await this.resolve(userId, publicId)).id;
      const conversation = await this.db
      .selectFrom("communication_conversation")
      .select(["id", "platform", "external_user_id", "last_inbound_at"])
      .where("id", "=", conversationId)
      .where("business_id", "=", businessId)
      .executeTakeFirst();
    if (!conversation)
      throw new AppError(404, "CONVERSATION_NOT_FOUND", "Диалог не найден.");
    if (
      conversation.platform === "whatsapp" &&
      !whatsappSessionOpen(conversation.last_inbound_at)
    )
      throw new AppError(
        409,
        "WHATSAPP_WINDOW_CLOSED",
        "Окно свободных ответов WhatsApp (24 часа после сообщения клиента) закрыто. Отправьте шаблонное сообщение или дождитесь нового обращения клиента.",
      );
    const row = await this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "messages.write");
      const current = await tx
        .selectFrom("communication_conversation")
        .selectAll()
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (
        current.status === "blocked" ||
        (current.assigned_member_user_id &&
          current.assigned_member_user_id !== userId)
      )
        throw new AppError(
          409,
          "CONVERSATION_ASSIGNED",
          "Диалог недоступен для ответа или взят другим сотрудником.",
        );
      const requestKey =
        typeof body.requestKey === "string" ? body.requestKey : null;
      if (requestKey && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))
        throw new AppError(400, "INVALID_REQUEST_KEY", "Обновите страницу.");
      if (requestKey) {
        const duplicate = await tx
          .selectFrom("communication_message")
          .selectAll()
          .where("business_id", "=", businessId)
          .where("request_key", "=", requestKey)
          .executeTakeFirst();
        if (duplicate) {
          const priorFiles = await tx
            .selectFrom("communication_attachment")
            .select("attachment_id")
            .where("message_id", "=", duplicate.id)
            .execute();
          if (
            JSON.stringify(priorFiles.map((f) => f.attachment_id).sort()) !==
            JSON.stringify([...attachmentIds].sort())
          )
            throw new AppError(
              409,
              "REQUEST_CONFLICT",
              "Этот запрос уже использован.",
            );
          if (
            duplicate.text !== message ||
            duplicate.conversation_id !== conversationId
          )
            throw new AppError(
              409,
              "REQUEST_CONFLICT",
              "Этот запрос уже использован.",
            );
          return duplicate;
        }
      }
      if (attachmentIds.length) {
        const files = await tx
          .selectFrom("attachment")
          .select("id")
          .where("business_id", "=", businessId)
          .where("id", "in", attachmentIds)
          .execute();
        if (files.length !== attachmentIds.length)
          throw new AppError(400, "INVALID_ATTACHMENT", "Вложение недоступно.");
      }
      const inserted = await tx
        .insertInto("communication_message")
        .values({
          id: randomUUID(),
          conversation_id: conversationId,
          business_id: businessId,
          direction: "outbound",
          text: message,
          request_key: requestKey,
          delivery_status: "queued",
          external_message_id: null,
          actor_user_id: userId,
          moderation_status: "allowed",
          created_at: new Date(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const connection = await tx
        .selectFrom("business_connection as c")
        .select(["c.id", "c.status"])
        .where("c.business_id", "=", businessId)
        .where("c.platform", "=", conversation.platform)
        .executeTakeFirst();
      const runtime = connection
        ? conversation.platform === "telegram"
          ? await tx
              .selectFrom("telegram_runtime")
              .select("status")
              .where("connection_id", "=", connection.id)
              .executeTakeFirst()
          : conversation.platform === "vk"
            ? await tx
                .selectFrom("vk_runtime")
                .select("status")
                .where("connection_id", "=", connection.id)
                .executeTakeFirst()
            : await tx
                .selectFrom("meta_runtime")
                .select("status")
                .where("connection_id", "=", connection.id)
                .executeTakeFirst()
        : undefined;
      if (
        !connection ||
        connection.status !== "connected" ||
        runtime?.status !== "ready"
      ) {
        throw new AppError(
          409,
          "CHANNEL_PAUSED",
          "Канал временно недоступен. Повторите отправку позже.",
        );
      }
      for (const attachment_id of attachmentIds)
        await tx
          .insertInto("communication_attachment")
          .values({
            business_id: businessId,
            message_id: inserted.id,
            attachment_id,
          })
          .execute();
      const jobs = [
        ...(body.text
          ? messageChunks(message).map((part) => ({
              message: part,
              ids: [] as string[],
            }))
          : []),
        ...attachmentIds.map((id) => ({ message: "", ids: [id] })),
      ];
      if (!jobs.length) jobs.push({ message, ids: [] });
      for (const job of jobs) {
        const values = {
          communication_message_id: inserted.id,
          connection_id: connection.id,
          message: job.message,
          attachment_ids: JSON.stringify(job.ids),
          delivered_at: null,
          last_error: null,
        };
        if (conversation.platform === "telegram")
          await tx
            .insertInto("telegram_outbox")
            .values({ ...values, chat_id: conversation.external_user_id })
            .execute();
        else if (conversation.platform === "vk")
          await tx
            .insertInto("vk_outbox")
            .values({ ...values, peer_id: conversation.external_user_id })
            .execute();
        else
          await tx
            .insertInto("meta_outbox")
            .values({
              ...values,
              recipient_id: conversation.external_user_id,
            })
            .execute();
      }
      if (current.status !== "assigned")
        await audit(
          tx,
          businessId,
          userId,
          "conversation_taken",
          conversationId,
        );
      await tx
        .updateTable("communication_conversation")
        .set({
          status: "assigned",
          assigned_member_user_id: userId,
          last_message_at: new Date(),
        })
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .execute();
      return inserted;
    });
    return {
      id: row.id,
      conversationId,
      platform: conversation.platform,
      direction: row.direction,
      text: row.text,
      createdAt: row.created_at.toISOString(),
      deliveryStatus: row.delivery_status,
    };
  }

  /** Staff-only note — never queued to Telegram/VK/Meta outbox. */
  async addInternalNote(
    userId: string,
    publicId: string,
    conversationId: string,
    raw: unknown,
  ) {
    await this.resolve(userId, publicId, true);
    requireUuid(conversationId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError(400, "INVALID_NOTE", "Проверьте текст заметки.");
    const body = raw as Record<string, unknown>;
    const note = text(body.text);
    if (!note || note.length > 4000)
      throw new AppError(
        400,
        "INVALID_NOTE",
        "Внутренняя заметка — от 1 до 4000 символов.",
      );
    const businessId = (await this.resolve(userId, publicId)).id;
    const row = await this.db.transaction().execute(async (tx) => {
      await requireBusiness(tx, userId, publicId, "messages.write");
      const conversation = await tx
        .selectFrom("communication_conversation")
        .select("id")
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirst();
      if (!conversation)
        throw new AppError(404, "CONVERSATION_NOT_FOUND", "Диалог не найден.");
      const inserted = await tx
        .insertInto("communication_message")
        .values({
          id: randomUUID(),
          conversation_id: conversationId,
          business_id: businessId,
          direction: "internal",
          text: note,
          external_message_id: null,
          actor_user_id: userId,
          moderation_status: "allowed",
          delivery_status: "sent",
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await audit(
        tx,
        businessId,
        userId,
        "conversation_internal_note",
        conversationId,
        { message_id: inserted.id },
      );
      return inserted;
    });
    return {
      id: row.id,
      conversationId,
      direction: "internal" as const,
      text: row.text,
      createdAt: row.created_at.toISOString(),
      deliveryStatus: row.delivery_status,
    };
  }

  async closeConversation(
    userId: string,
    publicId: string,
    conversationId: string,
    raw: unknown,
  ) {
    await this.resolve(userId, publicId, true);
    requireUuid(conversationId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError(400, "INVALID_MESSAGE", "Проверьте сообщение.");
    const body = raw as Record<string, unknown>;
    const closingMessage = text(
      body.message ||
        "Спасибо за обращение! Диалог закрыт. Если появятся новые вопросы — напишите нам.",
      4000,
    );
    const requestKey =
      typeof body.requestKey === "string" ? body.requestKey : null;
    if (requestKey && !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))
      throw new AppError(400, "INVALID_REQUEST_KEY", "Обновите страницу.");

    const businessId = (await this.resolve(userId, publicId)).id;
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "messages.write");

      const current = await tx
        .selectFrom("communication_conversation")
        .selectAll()
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "CONVERSATION_NOT_FOUND", "Диалог не найден.");
      if (
        current.assigned_member_user_id &&
        current.assigned_member_user_id !== userId
      )
        throw new AppError(
          409,
          "CONVERSATION_ASSIGNED",
          "Диалог уже взял другой сотрудник.",
        );

      if (current.status === "closed") {
        return {
          id: current.id,
          status: current.status,
          closedAt: current.closed_at?.toISOString() ?? null,
          notification: "already_closed" as const,
        };
      }

      const connection = await tx
        .selectFrom("business_connection")
        .select(["id", "status"])
        .where("business_id", "=", businessId)
        .where("platform", "=", current.platform)
        .executeTakeFirst();

      const runtime = connection
        ? current.platform === "telegram"
          ? await tx
              .selectFrom("telegram_runtime")
              .select("status")
              .where("connection_id", "=", connection.id)
              .executeTakeFirst()
          : current.platform === "vk"
            ? await tx
                .selectFrom("vk_runtime")
                .select("status")
                .where("connection_id", "=", connection.id)
                .executeTakeFirst()
            : await tx
                .selectFrom("meta_runtime")
                .select("status")
                .where("connection_id", "=", connection.id)
                .executeTakeFirst()
        : undefined;

      const channelReady =
        connection?.status === "connected" &&
        runtime?.status === "ready" &&
        !(
          current.platform === "whatsapp" &&
          !whatsappSessionOpen(current.last_inbound_at)
        );

      const now = new Date();
      const messageRow = await tx
        .insertInto("communication_message")
        .values({
          id: randomUUID(),
          conversation_id: conversationId,
          business_id: businessId,
          direction: "outbound",
          text: closingMessage,
          request_key: requestKey,
          delivery_status: channelReady ? "queued" : "failed",
          external_message_id: null,
          actor_user_id: userId,
          moderation_status: "allowed",
          created_at: now,
        })
        .returning(["id", "delivery_status"])
        .executeTakeFirstOrThrow();

      if (channelReady && connection) {
        const values = {
          communication_message_id: messageRow.id,
          connection_id: connection.id,
          message: closingMessage,
          attachment_ids: JSON.stringify([]),
          delivered_at: null,
          last_error: null,
        };
        if (current.platform === "telegram")
          await tx
            .insertInto("telegram_outbox")
            .values({ ...values, chat_id: current.external_user_id })
            .execute();
        else if (current.platform === "vk")
          await tx
            .insertInto("vk_outbox")
            .values({ ...values, peer_id: current.external_user_id })
            .execute();
        else
          await tx
            .insertInto("meta_outbox")
            .values({
              ...values,
              recipient_id: current.external_user_id,
            })
            .execute();
      }

      await tx
        .updateTable("communication_conversation")
        .set({
          status: "closed",
          closed_at: now,
          last_message_at: now,
        })
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .execute();

      await audit(
        tx,
        businessId,
        userId,
        "conversation_closed",
        conversationId,
        {
          closing_message_id: messageRow.id,
          notification_queued: channelReady,
        },
      );
      if (current.client_id)
        await clientActivity(
          tx,
          businessId,
          current.client_id,
          "conversation.closed",
          randomUUID(),
          conversationId,
          userId,
        );

      return {
        id: current.id,
        status: "closed" as const,
        closedAt: now.toISOString(),
        notification: channelReady ? ("queued" as const) : ("failed" as const),
        messageId: messageRow.id,
      };
    });
  }

  async updateStatus(
    userId: string,
    publicId: string,
    conversationId: string,
    raw: unknown,
  ) {
    await this.resolve(userId, publicId, true);
    requireUuid(conversationId);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new AppError(400, "INVALID_STATUS", "Проверьте статус.");
    const status = (raw as Record<string, unknown>).status;
    if (!["open", "assigned", "closed", "blocked"].includes(String(status)))
      throw new AppError(400, "INVALID_STATUS", "Неизвестный статус диалога.");
    const businessId = (await this.resolve(userId, publicId)).id;
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", businessId)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "messages.write");
      const current = await tx
        .selectFrom("communication_conversation")
        .selectAll()
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "CONVERSATION_NOT_FOUND", "Диалог не найден.");
      if (
        current.assigned_member_user_id &&
        current.assigned_member_user_id !== userId
      )
        throw new AppError(
          409,
          "CONVERSATION_ASSIGNED",
          "Диалог уже взял другой сотрудник.",
        );
      let update = tx
        .updateTable("communication_conversation")
        .set({
          status: status as ConversationStatus,
          closed_at: status === "closed" ? new Date() : null,
          ...(status === "assigned"
            ? { assigned_member_user_id: userId }
            : status === "open"
              ? { assigned_member_user_id: null }
              : {}),
        })
        .where("id", "=", conversationId)
        .where("business_id", "=", businessId);
      if (status === "assigned")
        update = update.where((eb) =>
          eb.or([
            eb("assigned_member_user_id", "is", null),
            eb("assigned_member_user_id", "=", userId),
          ]),
        );
      const row = await update
        .returning(["id", "status", "closed_at"])
        .executeTakeFirst();
      if (!row)
        throw new AppError(
          409,
          "CONVERSATION_ASSIGNED",
          "Диалог уже взял другой сотрудник.",
        );
      if (
        current.status !== status &&
        (status === "assigned" || status === "closed")
      ) {
        await audit(
          tx,
          businessId,
          userId,
          status === "assigned" ? "conversation_taken" : "conversation_closed",
          conversationId,
        );
        if (current.client_id)
          await clientActivity(
            tx,
            businessId,
            current.client_id,
            status === "assigned"
              ? "conversation.assigned"
              : "conversation.closed",
            randomUUID(),
            conversationId,
            userId,
          );
      }
      return {
        id: row.id,
        status: row.status,
        closedAt: row.closed_at?.toISOString(),
      };
    });
  }

  async recordInbound(input: {
    businessId: string;
    platform: Platform;
    externalUserId: string;
    externalUsername?: string | null;
    text: string;
    externalMessageId?: string | null;
    connectionId?: string;
    attachments?: InboundAttachment[];
  }) {
    return this.db
      .transaction()
      .execute((tx) => this.recordInboundInTransaction(tx, input));
  }

  async recordInboundInTransaction(
    tx: Transaction<Database>,
    input: {
      businessId: string;
      platform: Platform;
      externalUserId: string;
      externalUsername?: string | null;
      text: string;
      externalMessageId?: string | null;
      connectionId?: string;
      attachments?: InboundAttachment[];
    },
  ) {
    const message = text(
      input.text || ((input.attachments?.length ?? 0) > 0 ? "Вложение" : ""),
    );
    const periodStart = new Date().toISOString().slice(0, 7) + "-01";
    return (async () => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", input.businessId)
        .forUpdate()
        .execute();
      if (input.externalMessageId) {
        const duplicate = await tx
          .selectFrom("communication_message")
          .select(["id", "conversation_id"])
          .where("business_id", "=", input.businessId)
          .where("external_message_id", "=", input.externalMessageId)
          .executeTakeFirst();
        if (duplicate)
          return {
            accepted: true as const,
            duplicate: true as const,
            conversationId: duplicate.conversation_id,
          };
      }
      const blockedConversation = await tx
        .selectFrom("communication_conversation")
        .select("id")
        .where("business_id", "=", input.businessId)
        .where("platform", "=", input.platform)
        .where("external_user_id", "=", input.externalUserId)
        .where("status", "=", "blocked")
        .executeTakeFirst();
      if (blockedConversation)
        return { accepted: false as const, reason: "blocked" as const };
      const blocked = await tx
        .selectFrom("communication_block")
        .select("id")
        .where("business_id", "=", input.businessId)
        .where("platform", "=", input.platform)
        .where("external_user_id", "=", input.externalUserId)
        .where((eb) =>
          eb.or([
            eb("expires_at", "is", null),
            eb("expires_at", ">", new Date()),
          ]),
        )
        .executeTakeFirst();
      if (blocked)
        return { accepted: false as const, reason: "blocked" as const };
      await tx
        .insertInto("communication_quota")
        .values({
          business_id: input.businessId,
          period_start: periodStart,
          inbound_limit: 300,
          inbound_count: 0,
          warned_at_percent: 0,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(["business_id", "period_start"]).doNothing(),
        )
        .execute();
      const quota = await tx
        .selectFrom("communication_quota")
        .selectAll()
        .where("business_id", "=", input.businessId)
        .where("period_start", "=", periodStart)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const clientId = await matchClient(tx, input.businessId, {
        identities: [
          {
            kind: input.platform,
            value: input.externalUserId,
            username: input.externalUsername,
          },
        ],
      });
      const previous = await tx
        .selectFrom("communication_conversation")
        .select(["status", "assigned_member_user_id"])
        .where("business_id", "=", input.businessId)
        .where("platform", "=", input.platform)
        .where("external_user_id", "=", input.externalUserId)
        .executeTakeFirst();
      await tx
        .insertInto("communication_conversation")
        .values({
          client_id: clientId,
          id: randomUUID(),
          business_id: input.businessId,
          platform: input.platform,
          external_user_id: input.externalUserId,
          external_username: input.externalUsername ?? null,
          status: "open",
          assigned_member_user_id: null,
          last_message_at: new Date(),
          last_inbound_at: new Date(),
          created_at: new Date(),
          closed_at: null,
        })
        .onConflict((oc) =>
          oc
            .columns(["business_id", "platform", "external_user_id"])
            .doUpdateSet({
              client_id: clientId,
              external_username: input.externalUsername ?? null,
              status: previous?.status === "assigned" ? "assigned" : "open",
              assigned_member_user_id:
                previous?.status === "assigned"
                  ? previous.assigned_member_user_id
                  : null,
              last_message_at: new Date(),
              last_inbound_at: new Date(),
              closed_at: null,
            }),
        )
        .execute();
      const conversation = await tx
        .selectFrom("communication_conversation")
        .select("id")
        .where("business_id", "=", input.businessId)
        .where("platform", "=", input.platform)
        .where("external_user_id", "=", input.externalUserId)
        .executeTakeFirstOrThrow();
      const inserted = await tx
        .insertInto("communication_message")
        .values({
          id: randomUUID(),
          conversation_id: conversation.id,
          business_id: input.businessId,
          direction: "inbound",
          text: message,
          external_message_id: input.externalMessageId ?? null,
          actor_user_id: null,
          moderation_status: "allowed",
          created_at: new Date(),
        })
        .onConflict((oc) =>
          oc.columns(["business_id", "external_message_id"]).doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      if (!inserted)
        return {
          accepted: true as const,
          duplicate: true as const,
          conversationId: conversation.id,
        };
      await tx
        .updateTable("communication_quota")
        .set({
          inbound_count: quota.inbound_count + 1,
          warned_at_percent:
            quota.inbound_count + 1 >= quota.inbound_limit
              ? 100
              : quota.inbound_count + 1 >= Math.ceil(quota.inbound_limit * 0.8)
                ? 80
                : quota.warned_at_percent,
          updated_at: new Date(),
        })
        .where("business_id", "=", input.businessId)
        .where("period_start", "=", periodStart)
        .execute();
      if (
        input.connectionId &&
        input.attachments?.length &&
        (input.platform === "telegram" || input.platform === "vk")
      )
        await recordAttachments(
          tx,
          input.businessId,
          input.connectionId,
          input.platform,
          inserted.id,
          input.attachments,
        );
      await clientActivity(
        tx,
        input.businessId,
        clientId,
        "message.received",
        "message:" + inserted.id,
        conversation.id,
      );
      await notify(
        tx,
        input.businessId,
        "message.received",
        "message:" + inserted.id,
        "Новое обращение",
        "/messages?id=" + conversation.id,
      );
      return {
        accepted: true as const,
        duplicate: false as const,
        conversationId: conversation.id,
        messageId: inserted.id,
      };
    })();
  }
}
