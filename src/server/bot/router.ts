import { messageChunks } from "../outbox/text.ts";
import { AppError } from "../http/errors.ts";
import { bindNotification } from "../notifications/settings.ts";
import type { InboundAttachment } from "../attachments/service.ts";
import { bookingFlow } from "./booking-flow.ts";
import { ordersFlow } from "./orders-flow.ts";
import { customerProfileFlow } from "./customer-profile-flow.ts";
import { leadsFlow } from "./leads-flow.ts";
import type { OutboxButton } from "./types.ts";
import type { Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { getAvailableCustomerActions } from "../solutions/customer-actions.ts";
import { CommunicationService } from "../communications/service.ts";
import { routeChannelAdmin } from "../channel-admin/router.ts";
import { ChannelAdminBindingService } from "../channel-admin/binding.ts";

const FLOW_META = "_flow";

export async function routeBot(
  tx: Transaction<Database>,
  input: {
    businessId: string;
    connectionId: string;
    platform: "telegram" | "vk";
    userId: string;
    username?: string;
    eventId: string;
    text: string;
    attachments?: InboundAttachment[];
  },
) {
  const { businessId, connectionId, platform, userId, eventId } = input;
  const text = input.text.trim();
  const table = platform === "telegram" ? "telegram_dialog" : "vk_dialog";
  const b = await tx
    .selectFrom("business")
    .selectAll()
    .where("id", "=", businessId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (b.archived_at) {
    return;
  }
  const available = await getAvailableCustomerActions(tx, businessId, platform);
  const brand = b.public_name || b.name;
  const menu = [...available.labels];
  const queuePart = async (
    message: string,
    buttons: OutboxButton[] = [],
    attachmentIds: string[] = [],
  ) => {
    const value = {
      connection_id: connectionId,
      message,
      buttons: JSON.stringify(buttons),
      attachment_ids: JSON.stringify(attachmentIds),
      delivered_at: null,
      last_error: null,
    };
    if (platform === "telegram")
      await tx
        .insertInto("telegram_outbox")
        .values({ ...value, chat_id: userId })
        .execute();
    else
      await tx
        .insertInto("vk_outbox")
        .values({ ...value, peer_id: userId })
        .execute();
  };
  const queue = async (
    message: string,
    buttons: OutboxButton[] = [],
    attachmentIds: string[] = [],
  ) => {
    const parts = messageChunks(message);
    for (let i = 0; i < parts.length; i++)
      await queuePart(
        parts[i]!,
        i === parts.length - 1 ? buttons : [],
        i === parts.length - 1 ? attachmentIds : [],
      );
  };
  const current = await tx
    .selectFrom(table)
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("chat_id", "=", userId)
    .executeTakeFirst();
  if (
    platform === "telegram" &&
    current &&
    BigInt(eventId) <= BigInt(current.last_update_id)
  )
    return;
  const save = async (
    mode: string,
    fields: string[] = [],
    answers: Record<string, unknown> = {},
    position = 0,
    snapshot: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const configPayload =
      Object.keys(extra).length > 0
        ? { ...snapshot, [FLOW_META]: extra }
        : snapshot;
    const row = {
      connection_id: connectionId,
      chat_id: userId,
      mode,
      fields: JSON.stringify(fields),
      answers: JSON.stringify(answers),
      position,
      config: JSON.stringify(configPayload),
      last_update_id: eventId,
      updated_at: new Date(),
    };
    await tx
      .insertInto(table)
      .values(row)
      .onConflict((oc) =>
        oc.columns(["connection_id", "chat_id"]).doUpdateSet(row),
      )
      .execute();
  };
  const showMenu = async (message?: string) => {
    // Always re-resolve so disabled solutions disappear immediately.
    const fresh = await getAvailableCustomerActions(tx, businessId, platform);
    menu.length = 0;
    menu.push(...fresh.labels);
    await save("menu");
    const welcome =
      (b.greeting && b.greeting.trim()) ||
      `Добро пожаловать в ${brand}!`;
    // Bot represents the owner's business — never introduce as platform «БизнеСоты».
    const safeWelcome = /бот\s+сервис/i.test(welcome)
      ? `Добро пожаловать в ${brand}!`
      : welcome;
    await queue(
      message ??
        safeWelcome +
          (menu.length
            ? "\n\nЧем можем помочь?"
            : "\n\nПриём обращений пока не настроен. Напишите сообщение — передам команде."),
      menu,
    );
  };
  const denyDisabled = async () => {
    await showMenu("Эта функция временно недоступна.");
  };
  const notifyCode =
    text.match(/^\/start\s+notify_([\w-]{32})$/)?.[1] ??
    text.match(/^notify_([\w-]{32})$/)?.[1];
  if (notifyCode) {
    const ok = await bindNotification(
      tx,
      businessId,
      connectionId,
      userId,
      notifyCode,
    );
    await queue(
      ok
        ? "Уведомления сотрудника подключены."
        : "Код недействителен или истёк. Создайте новый код на сайте.",
    );
    return;
  }
  if (await routeChannelAdmin(tx, input, queue)) return;
  if (text === "/start" || text === "/menu" || text === "Главное меню") {
    const admin = await new ChannelAdminBindingService(tx).resolveAdmin(tx, {
      connectionId,
      businessId,
      platform,
      externalUserId: userId,
    });
    if (admin && !menu.includes("Управление бизнесом"))
      menu.push("Управление бизнесом");
    await showMenu();
    return;
  }
  if (text === "/cancel" || text === "Отмена") {
    await showMenu("Действие отменено. Выберите действие.");
    return;
  }
  const intended = available.match(text);
  const startLead = intended === "leads" || text === "/lead";
  const contactAdmin = intended === "admin_messages";

  // Stale callbacks / labels for disabled solutions must not run.
  if (
    (text === "/lead" ||
      text === available.leadTitle ||
      (available.leadTitle == null && text === "Оставить заявку")) &&
    !available.has("leads")
  ) {
    await denyDisabled();
    return;
  }
  if (
    (text === "Связаться с администратором" ||
      text === "Связаться с администрацией" ||
      text === "Связаться с магазином") &&
    !available.has("admin_messages")
  ) {
    await denyDisabled();
    return;
  }
  if (
    (text === "Каталог" ||
      text === "Корзина" ||
      text === "Мои заказы" ||
      text === "Профиль") &&
    !available.has("orders")
  ) {
    await denyDisabled();
    return;
  }
  if (
    (text === "Записаться" ||
      text === "Мои записи" ||
      text === "Онлайн-запись") &&
    !available.has("booking")
  ) {
    await denyDisabled();
    return;
  }

  // Explicit menu actions may switch away from an unfinished dialogue.
  if (available.has("booking") && !startLead && !contactAdmin) {
    try {
      if (await bookingFlow(tx, input, queue)) return;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.status >= 500 ||
        error.status === 429
      )
        throw error;
      await showMenu(error.message + " Выберите действие заново.");
      return;
    }
  }
  if (available.has("orders") && !startLead && !contactAdmin) {
    try {
      if (await customerProfileFlow(tx, input, queue)) return;
      if (await ordersFlow(tx, input, queue)) return;
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.status >= 500 ||
        error.status === 429
      )
        throw error;
      await showMenu(error.message + " Выберите действие заново.");
      return;
    }
  }
  if (contactAdmin && available.has("admin_messages")) {
    await save("messages");
    await queue("Напишите ваш вопрос.", ["Главное меню"]);
    return;
  }
  if (
    !startLead &&
    current?.mode === "messages" &&
    available.has("admin_messages")
  ) {
    const result = await new CommunicationService(
      tx,
    ).recordInboundInTransaction(tx, {
      businessId,
      platform,
      externalUserId: userId,
      externalUsername: input.username,
      text,
      externalMessageId: connectionId + ":" + eventId,
      connectionId,
      attachments: input.attachments,
    });
    if (result.accepted && !result.duplicate)
      await queue("Сообщение отправлено. Администратор ответит вам здесь.", [
        "Главное меню",
      ]);
    return;
  }
  if (
    !startLead &&
    current?.mode === "messages" &&
    !available.has("admin_messages")
  ) {
    await denyDisabled();
    return;
  }

  try {
    if (
      await leadsFlow(tx, input, {
        queue,
        save,
        showMenu,
        current: current
          ? {
              mode: current.mode,
              fields: current.fields,
              answers: current.answers,
              position: current.position,
              config: current.config,
              updated_at: current.updated_at,
            }
          : null,
        startLead: Boolean(startLead && available.has("leads")),
      })
    ) {
      return;
    }
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      error.status >= 500 ||
      error.status === 429
    )
      throw error;
    await showMenu(error.message + " Выберите действие заново.");
    return;
  }

  await showMenu();
}
