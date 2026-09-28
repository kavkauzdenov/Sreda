import { randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import type { Database, LeadStatus } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { allowed, type Permission } from "../access/permissions.ts";
import { audit } from "../audit/service.ts";
import { normalizeSolutionCode } from "../solutions/catalog.ts";
import { OrderService } from "../orders/service.ts";
import {
  allowedStatusesForFulfillment,
  type OrderStatus,
} from "../orders/schema.ts";
import { BookingService } from "../booking/service.ts";
import {
  ChannelAdminBindingService,
  type ChannelAdminResolved,
  type ChannelPlatform,
} from "./binding.ts";
import {
  clearChannelAdminSession,
  getChannelAdminSession,
  setChannelAdminSession,
  type ChannelAdminSessionDraft,
} from "./session.ts";

type Queue = (message: string, buttons?: string[]) => Promise<void>;

type RouteInput = {
  businessId: string;
  connectionId: string;
  platform: "telegram" | "vk";
  userId: string;
  username?: string;
  eventId: string;
  text: string;
};

const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "processing",
  "waiting_customer",
  "completed",
  "rejected",
  "closed",
];

const ORDER_NEXT: Record<string, string[]> = {
  new: ["accepted", "cancelled"],
  accepted: ["assembling", "cancelled"],
  assembling: ["ready", "cancelled"],
  ready: ["handed_over", "delivered", "cancelled"],
  handed_over: ["completed"],
  delivered: ["completed"],
  completed: [],
  cancelled: [],
};

function nextOrderStatuses(
  status: string,
  fulfillment: string,
): string[] {
  if (
    status === "new" ||
    status === "accepted" ||
    status === "assembling" ||
    status === "ready" ||
    status === "handed_over" ||
    status === "delivered" ||
    status === "completed" ||
    status === "cancelled"
  ) {
    return allowedStatusesForFulfillment(
      status as OrderStatus,
      fulfillment === "delivery" ? "delivery" : "pickup",
    );
  }
  return ORDER_NEXT[status] ?? [];
}

const BTN = {
  home: "🏠 Меню управления",
  business: "🏠 Бизнес / Настройки",
  leads: "📥 Заявки",
  orders: "📦 Заказы",
  bookings: "📅 Записи",
  messages: "💬 Сообщения",
  posts: "📢 Публикации",
  stats: "📊 Статистика",
  site: "🌐 Открыть сайт",
  client: "Режим клиента",
  backAdmin: "← Вернуться в кабинет",
  switchBiz: "Сменить бизнес",
  changeName: "Изменить название",
  changeGreeting: "Изменить приветствие",
  adminEntry: "Управление бизнесом",
} as const;

function extractAdminToken(text: string): string | null {
  return (
    text.match(/^\/start\s+admin_([\w-]+)$/i)?.[1] ??
    text.match(/^admin_([\w-]+)$/i)?.[1] ??
    null
  );
}

function appUrl(): string | null {
  const url = process.env.APP_URL?.trim();
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function activeSolutions(tx: Transaction<Database>, businessId: string) {
  const active = await tx
    .selectFrom("business_solution")
    .select("solution_code")
    .where("business_id", "=", businessId)
    .where("status", "in", ["active", "trial"])
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", new Date())]),
    )
    .execute();
  return new Set(active.map((x) => normalizeSolutionCode(x.solution_code)));
}

function homeButtons(codes: Set<string>) {
  const buttons: string[] = [BTN.business];
  if (codes.has("leads")) buttons.push(BTN.leads);
  if (codes.has("orders")) buttons.push(BTN.orders);
  if (codes.has("booking")) buttons.push(BTN.bookings);
  if (codes.has("admin_messages")) buttons.push(BTN.messages);
  if (codes.has("autopost")) buttons.push(BTN.posts);
  buttons.push(BTN.stats, BTN.site, BTN.switchBiz, BTN.client);
  return buttons;
}

function can(admin: ChannelAdminResolved, permission: Permission) {
  return (
    admin.permissions.includes(permission) || allowed(admin.role, permission)
  );
}

async function ensureSessionBusiness(
  tx: Transaction<Database>,
  bindings: ChannelAdminBindingService,
  platform: ChannelPlatform,
  externalUserId: string,
  sessionBusinessId: string,
) {
  const list = await bindings.listBusinessesForIdentity(
    tx,
    platform,
    externalUserId,
  );
  return list.find((b) => b.businessId === sessionBusinessId) ?? null;
}

async function showHome(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  connectionId: string,
  externalUserId: string,
  platform: ChannelPlatform,
  message?: string,
) {
  const codes = await activeSolutions(tx, admin.businessId);
  await setChannelAdminSession(tx, {
    connectionId,
    externalUserId,
    platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "home",
    step: "",
    draft: {},
  });
  await queue(
    (message ??
      `Управление: ${admin.businessName}\nРоль: ${admin.role}\nВыберите раздел.`) +
      "",
    homeButtons(codes),
  );
}

async function resolveForSessionBusiness(
  tx: Transaction<Database>,
  bindings: ChannelAdminBindingService,
  input: RouteInput,
  businessId: string,
): Promise<ChannelAdminResolved | null> {
  return bindings.resolveAdmin(tx, {
    connectionId: input.connectionId,
    businessId,
    platform: input.platform,
    externalUserId: input.userId,
  });
}

export async function routeChannelAdmin(
  tx: Transaction<Database>,
  input: RouteInput,
  queue: Queue,
): Promise<boolean> {
  const bindings = new ChannelAdminBindingService(tx);
  const text = input.text.trim();
  const platform = input.platform;
  const externalUserId = input.userId;

  const token = extractAdminToken(text);
  if (token) {
    try {
      await bindings.consumeChallenge(tx, {
        businessId: input.businessId,
        connectionId: input.connectionId,
        platform,
        externalUserId,
        username: input.username,
        displayName: input.username,
        token,
      });
      const admin = await bindings.resolveAdmin(tx, {
        connectionId: input.connectionId,
        businessId: input.businessId,
        platform,
        externalUserId,
      });
      if (!admin) {
        await queue(
          "Привязка сохранена, но доступ пока недоступен. Проверьте членство в бизнесе.",
        );
        return true;
      }
      await showHome(
        tx,
        queue,
        admin,
        input.connectionId,
        externalUserId,
        platform,
        "Доступ подтверждён. Добро пожаловать в управление бизнесом.",
      );
    } catch (error) {
      if (error instanceof AppError)
        await queue(error.message);
      else throw error;
    }
    return true;
  }

  const wantsAdmin =
    text === "/admin" ||
    text === BTN.adminEntry ||
    text === "Управление бизнесом";

  let session = await getChannelAdminSession(
    tx,
    input.connectionId,
    externalUserId,
    platform,
  );

  let admin =
    (await bindings.resolveAdmin(tx, {
      connectionId: input.connectionId,
      businessId: input.businessId,
      platform,
      externalUserId,
    })) ?? null;

  if (wantsAdmin) {
    const list = await bindings.listBusinessesForIdentity(
      tx,
      platform,
      externalUserId,
    );
    if (list.length === 0) {
      await queue(
        "Этот аккаунт не подтверждён для управления бизнесом.\nПодтвердите на сайте: Настройки → Доступ.",
      );
      return true;
    }
    if (list.length === 1) {
      const only = list[0]!;
      admin = await resolveForSessionBusiness(
        tx,
        bindings,
        input,
        only.businessId,
      );
      if (!admin) {
        await queue(
          "Этот аккаунт не подтверждён для управления бизнесом.\nПодтвердите на сайте: Настройки → Доступ.",
        );
        return true;
      }
      await showHome(
        tx,
        queue,
        admin,
        input.connectionId,
        externalUserId,
        platform,
      );
      return true;
    }
    const preferred =
      list.find((b) => b.businessId === input.businessId) ?? list[0]!;
    const firstAdmin = await resolveForSessionBusiness(
      tx,
      bindings,
      input,
      preferred.businessId,
    );
    if (!firstAdmin) {
      await queue(
        "Этот аккаунт не подтверждён для управления бизнесом.\nПодтвердите на сайте: Настройки → Доступ.",
      );
      return true;
    }
    await setChannelAdminSession(tx, {
      connectionId: input.connectionId,
      externalUserId,
      platform,
      userId: firstAdmin.userId,
      businessId: firstAdmin.businessId,
      mode: "pick_business",
      step: "",
      draft: {
        options: list.map((b) => ({
          id: b.businessId,
          name: b.businessName,
        })),
      },
    });
    await queue(
      "Выберите бизнес:\n" +
        list.map((b, i) => `${i + 1}. ${b.businessName}`).join("\n"),
      list.map((b) => b.businessName),
    );
    return true;
  }

  if (!session && !admin) return false;

  // Session exists or admin for current business — enter admin handling.
  if (session) {
    const access = await ensureSessionBusiness(
      tx,
      bindings,
      platform,
      externalUserId,
      session.businessId,
    );
    if (!access) {
      await clearChannelAdminSession(
        tx,
        input.connectionId,
        externalUserId,
        platform,
      );
      session = null;
      if (!admin) return false;
    } else {
      admin =
        (await resolveForSessionBusiness(
          tx,
          bindings,
          input,
          session.businessId,
        )) ?? admin;
      if (!admin) {
        await clearChannelAdminSession(
          tx,
          input.connectionId,
          externalUserId,
          platform,
        );
        await queue(
          "Доступ отозван. Подтвердите снова на сайте: Настройки → Доступ.",
        );
        return true;
      }
    }
  }

  if (!admin) return false;

  // Client preview: do not intercept as admin except return / home /admin.
  if (session?.mode === "client_preview") {
    if (
      text === BTN.backAdmin ||
      text === BTN.home ||
      text === "/admin" ||
      text === BTN.adminEntry ||
      text === "Управление бизнесом"
    ) {
      await showHome(
        tx,
        queue,
        admin,
        input.connectionId,
        externalUserId,
        platform,
      );
      return true;
    }
    return false;
  }

  // Client mode — keep admin session, hand off to customer bot menu.
  if (text === BTN.client) {
    await setChannelAdminSession(tx, {
      connectionId: input.connectionId,
      externalUserId,
      platform,
      userId: admin.userId,
      businessId: admin.businessId,
      mode: "client_preview",
      step: "",
      draft: {},
    });
    await queue(
      "Вы смотрите интерфейс клиента. Нажмите «← Вернуться в кабинет» или /admin.",
      [BTN.backAdmin, "Главное меню"],
    );
    return true;
  }

  if (text === BTN.home || text === "/admin") {
    await showHome(
      tx,
      queue,
      admin,
      input.connectionId,
      externalUserId,
      platform,
    );
    return true;
  }

  // Pick business
  if (session?.mode === "pick_business" || text === BTN.switchBiz) {
    if (text === BTN.switchBiz) {
      const list = await bindings.listBusinessesForIdentity(
        tx,
        platform,
        externalUserId,
      );
      if (list.length <= 1) {
        await queue(
          list.length === 1
            ? `Сейчас доступен только «${list[0]!.businessName}».`
            : "Нет других бизнесов.",
          homeButtons(await activeSolutions(tx, admin.businessId)),
        );
        return true;
      }
      await setChannelAdminSession(tx, {
        connectionId: input.connectionId,
        externalUserId,
        platform,
        userId: admin.userId,
        businessId: admin.businessId,
        mode: "pick_business",
        draft: {
          options: list.map((b) => ({
            id: b.businessId,
            name: b.businessName,
          })),
        },
      });
      await queue(
        "Выберите бизнес:\n" +
          list.map((b, i) => `${i + 1}. ${b.businessName}`).join("\n"),
        list.map((b) => b.businessName),
      );
      return true;
    }
    const options =
      (session?.draft.options as { id: string; name: string }[] | undefined) ??
      [];
    const picked =
      options.find((o) => o.name === text) ??
      options[Number(text) - 1] ??
      null;
    if (!picked) {
      await queue(
        "Выберите бизнес из списка.",
        options.map((o) => o.name),
      );
      return true;
    }
    const next = await resolveForSessionBusiness(
      tx,
      bindings,
      input,
      picked.id,
    );
    if (!next) {
      await queue("Нет доступа к этому бизнесу.");
      return true;
    }
    await showHome(
      tx,
      queue,
      next,
      input.connectionId,
      externalUserId,
      platform,
      `Переключено на «${next.businessName}».`,
    );
    return true;
  }

  try {
    if (
      text === BTN.business ||
      text === BTN.changeName ||
      text === BTN.changeGreeting ||
      session?.mode === "settings"
    ) {
      return await handleSettings(
        tx,
        queue,
        admin,
        input,
        text,
        session?.mode === "settings" ? session : null,
      );
    }
    if (
      text === BTN.leads ||
      session?.mode === "leads" ||
      session?.mode === "lead_detail"
    ) {
      return await handleLeads(tx, queue, admin, input, text, session);
    }
    if (
      text === BTN.orders ||
      session?.mode === "orders" ||
      session?.mode === "order_detail"
    ) {
      return await handleOrders(tx, queue, admin, input, text, session);
    }
    if (
      text === BTN.bookings ||
      session?.mode === "bookings" ||
      session?.mode === "booking_detail"
    ) {
      return await handleBookings(tx, queue, admin, input, text, session);
    }
    if (text === BTN.messages) {
      const base = appUrl();
      await queue(
        "Откройте Inbox на сайте" +
          (base ? `:\n${base}/messages` : " (раздел Сообщения)."),
        homeButtons(await activeSolutions(tx, admin.businessId)),
      );
      return true;
    }
    if (text === BTN.posts || session?.mode === "posts") {
      return await handlePosts(tx, queue, admin, input);
    }
    if (text === BTN.stats) {
      return await handleStats(tx, queue, admin);
    }
    if (text === BTN.site) {
      const base = appUrl();
      await queue(
        base
          ? `Сайт кабинета:\n${base}`
          : "Откройте кабинет Biznesoty в браузере.",
        homeButtons(await activeSolutions(tx, admin.businessId)),
      );
      return true;
    }

    // Unknown text while in admin session → re-show home
    if (session) {
      await showHome(
        tx,
        queue,
        admin,
        input.connectionId,
        externalUserId,
        platform,
        "Выберите пункт меню.",
      );
      return true;
    }
  } catch (error) {
    if (error instanceof AppError) {
      await queue(
        error.message,
        homeButtons(await activeSolutions(tx, admin.businessId)),
      );
      return true;
    }
    throw error;
  }

  // Admin for current business but no session and unrecognized text — don't steal customer flow
  return false;
}

async function handleSettings(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  input: RouteInput,
  text: string,
  session: Awaited<ReturnType<typeof getChannelAdminSession>>,
): Promise<boolean> {
  const codes = await activeSolutions(tx, admin.businessId);
  const buttons = [
    BTN.changeName,
    BTN.changeGreeting,
    BTN.home,
    ...homeButtons(codes).filter((b) => b !== BTN.business),
  ];

  if (session?.step === "name" && text !== BTN.changeName) {
    if (!can(admin, "settings.manage"))
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    const name = text.trim().slice(0, 100);
    if (name.length < 2)
      throw new AppError(400, "INVALID_NAME", "Слишком короткое название.");
    // Re-resolve before mutation
    const fresh = await reResolve(tx, admin, input);
    if (!fresh || !can(fresh, "settings.manage"))
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    await tx
      .updateTable("business")
      .set({ name })
      .where("id", "=", fresh.businessId)
      .execute();
    await audit(tx, fresh.businessId, fresh.userId, "settings_changed", fresh.businessId, {
      channel: input.platform,
      action: "channel_admin_name",
    });
    await showHome(
      tx,
      queue,
      { ...fresh, businessName: name },
      input.connectionId,
      input.userId,
      input.platform,
      "Название обновлено.",
    );
    return true;
  }

  if (session?.step === "greeting" && text !== BTN.changeGreeting) {
    if (!can(admin, "settings.manage"))
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    const greeting = text.trim().slice(0, 2000);
    const fresh = await reResolve(tx, admin, input);
    if (!fresh || !can(fresh, "settings.manage"))
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    await tx
      .updateTable("business")
      .set({ greeting })
      .where("id", "=", fresh.businessId)
      .execute();
    await audit(tx, fresh.businessId, fresh.userId, "settings_changed", fresh.businessId, {
      channel: input.platform,
      action: "channel_admin_greeting",
    });
    await showHome(
      tx,
      queue,
      fresh,
      input.connectionId,
      input.userId,
      input.platform,
      "Приветствие обновлено.",
    );
    return true;
  }

  if (text === BTN.changeName) {
    await setChannelAdminSession(tx, {
      connectionId: input.connectionId,
      externalUserId: input.userId,
      platform: input.platform,
      userId: admin.userId,
      businessId: admin.businessId,
      mode: "settings",
      step: "name",
      draft: {},
    });
    await queue("Введите новое название бизнеса:", ["Отмена", BTN.home]);
    return true;
  }
  if (text === BTN.changeGreeting) {
    await setChannelAdminSession(tx, {
      connectionId: input.connectionId,
      externalUserId: input.userId,
      platform: input.platform,
      userId: admin.userId,
      businessId: admin.businessId,
      mode: "settings",
      step: "greeting",
      draft: {},
    });
    await queue("Введите новый текст приветствия бота:", ["Отмена", BTN.home]);
    return true;
  }
  if (text === "Отмена") {
    await showHome(
      tx,
      queue,
      admin,
      input.connectionId,
      input.userId,
      input.platform,
      "Отменено.",
    );
    return true;
  }

  const b = await tx
    .selectFrom("business")
    .select(["name", "public_name", "greeting", "timezone"])
    .where("id", "=", admin.businessId)
    .executeTakeFirstOrThrow();
  await setChannelAdminSession(tx, {
    connectionId: input.connectionId,
    externalUserId: input.userId,
    platform: input.platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "settings",
    step: "",
    draft: {},
  });
  await queue(
    `Бизнес\nНазвание: ${b.name}\nПубличное: ${b.public_name || "—"}\nЧасовой пояс: ${b.timezone}\nПриветствие: ${b.greeting || "—"}`,
    buttons.slice(0, 4),
  );
  return true;
}

async function reResolve(
  tx: Transaction<Database>,
  admin: ChannelAdminResolved,
  input: RouteInput,
) {
  return new ChannelAdminBindingService(tx).resolveAdmin(tx, {
    connectionId: input.connectionId,
    businessId: admin.businessId,
    platform: input.platform,
    externalUserId: input.userId,
  });
}

async function handleLeads(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  input: RouteInput,
  text: string,
  session: Awaited<ReturnType<typeof getChannelAdminSession>>,
): Promise<boolean> {
  if (!can(admin, "leads.write"))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав для заявок.");
  const codes = await activeSolutions(tx, admin.businessId);
  if (!codes.has("leads")) {
    await queue("Решение «Заявки» не активно.", homeButtons(codes));
    return true;
  }

  if (session?.mode === "lead_detail" && session.draft.leadId) {
    const leadId = String(session.draft.leadId);
    if (LEAD_STATUSES.includes(text as LeadStatus)) {
      const fresh = await reResolve(tx, admin, input);
      if (!fresh || !can(fresh, "leads.write"))
        throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
      const current = await tx
        .selectFrom("lead")
        .selectAll()
        .where("business_id", "=", fresh.businessId)
        .where("id", "=", leadId)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
      const next = text as LeadStatus;
      await tx
        .updateTable("lead")
        .set({
          status: next,
          updated_at: new Date(),
          ...(next === "processing"
            ? {
                processing_by: fresh.userId,
                processing_at: current.processing_at ?? new Date(),
              }
            : next === "new"
              ? { processing_by: null, processing_at: null }
              : {}),
        })
        .where("business_id", "=", fresh.businessId)
        .where("id", "=", leadId)
        .execute();
      await tx
        .insertInto("lead_status_history")
        .values({
          id: randomUUID(),
          business_id: fresh.businessId,
          lead_id: leadId,
          from_status: current.status,
          to_status: next,
          actor_user_id: fresh.userId,
          note: "",
        })
        .execute();
      const leadAuditAction =
        next === "processing"
          ? "lead_taken"
          : next === "completed" ||
              next === "rejected" ||
              next === "closed"
            ? "lead_closed"
            : null;
      if (leadAuditAction) {
        await audit(
          tx,
          fresh.businessId,
          fresh.userId,
          leadAuditAction,
          leadId,
          {
            channel: input.platform,
            from: current.status,
            to: next,
          },
        );
      }
      await queue(`Статус заявки: ${next}`, [
        ...LEAD_STATUSES,
        BTN.leads,
        BTN.home,
      ]);
      return true;
    }
  }

  if (session?.mode === "leads" || session?.mode === "lead_detail") {
    const map = (session.draft.leads as { id: string; label: string }[]) ?? [];
    const hit = map.find((l) => l.label === text || l.id === text);
    if (hit) {
      const lead = await tx
        .selectFrom("lead")
        .selectAll()
        .where("business_id", "=", admin.businessId)
        .where("id", "=", hit.id)
        .executeTakeFirst();
      if (!lead) throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
      await setChannelAdminSession(tx, {
        connectionId: input.connectionId,
        externalUserId: input.userId,
        platform: input.platform,
        userId: admin.userId,
        businessId: admin.businessId,
        mode: "lead_detail",
        draft: { leadId: lead.id, leads: map },
      });
      await queue(
        `Заявка\n${lead.name}\nСтатус: ${lead.status}\n${lead.phone || ""}\n${lead.message || ""}`.trim(),
        [...LEAD_STATUSES, BTN.leads, BTN.home],
      );
      return true;
    }
  }

  const leads = await tx
    .selectFrom("lead")
    .select(["id", "name", "status", "created_at"])
    .where("business_id", "=", admin.businessId)
    .orderBy("created_at", "desc")
    .limit(10)
    .execute();
  const labels = leads.map(
    (l, i) => `${i + 1}. ${l.name} (${l.status})`,
  );
  const draft: ChannelAdminSessionDraft = {
    leads: leads.map((l, i) => ({ id: l.id, label: labels[i]! })),
  };
  await setChannelAdminSession(tx, {
    connectionId: input.connectionId,
    externalUserId: input.userId,
    platform: input.platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "leads",
    draft,
  });
  await queue(
    leads.length
      ? "Последние заявки:\n" + labels.join("\n")
      : "Заявок пока нет.",
    [...labels, BTN.home],
  );
  return true;
}

async function handleOrders(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  input: RouteInput,
  text: string,
  session: Awaited<ReturnType<typeof getChannelAdminSession>>,
): Promise<boolean> {
  if (!can(admin, "orders.write"))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав для заказов.");
  const codes = await activeSolutions(tx, admin.businessId);
  if (!codes.has("orders")) {
    await queue("Решение «Заказы» не активно.", homeButtons(codes));
    return true;
  }

  if (session?.mode === "order_detail" && session.draft.orderId) {
    const orderId = String(session.draft.orderId);
    const nextStatuses = (session.draft.next as string[]) ?? [];
    if (nextStatuses.includes(text)) {
      const fresh = await reResolve(tx, admin, input);
      if (!fresh || !can(fresh, "orders.write"))
        throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
      await new OrderService(tx).transitionStatus(
        fresh.userId,
        fresh.publicBusinessId,
        orderId,
        { status: text, channel: input.platform },
      );
      await queue(`Статус заказа: ${text}`, [BTN.orders, BTN.home]);
      return true;
    }
  }

  if (session?.mode === "orders" || session?.mode === "order_detail") {
    const map = (session.draft.orders as { id: string; label: string }[]) ?? [];
    const hit = map.find((o) => o.label === text || o.id === text);
    if (hit) {
      const order = await tx
        .selectFrom("order")
        .selectAll()
        .where("business_id", "=", admin.businessId)
        .where("id", "=", hit.id)
        .executeTakeFirst();
      if (!order)
        throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");
      const next = nextOrderStatuses(order.status, order.fulfillment);
      await setChannelAdminSession(tx, {
        connectionId: input.connectionId,
        externalUserId: input.userId,
        platform: input.platform,
        userId: admin.userId,
        businessId: admin.businessId,
        mode: "order_detail",
        draft: { orderId: order.id, orders: map, next },
      });
      await queue(
        `Заказ №${order.order_number ?? "—"}\nСтатус: ${order.status}`,
        [...next, BTN.orders, BTN.home],
      );
      return true;
    }
  }

  const orders = await tx
    .selectFrom("order")
    .select(["id", "order_number", "status", "created_at"])
    .where("business_id", "=", admin.businessId)
    .orderBy("created_at", "desc")
    .limit(10)
    .execute();
  const labels = orders.map(
    (o, i) => `${i + 1}. №${o.order_number ?? "—"} (${o.status})`,
  );
  await setChannelAdminSession(tx, {
    connectionId: input.connectionId,
    externalUserId: input.userId,
    platform: input.platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "orders",
    draft: { orders: orders.map((o, i) => ({ id: o.id, label: labels[i]! })) },
  });
  await queue(
    orders.length
      ? "Последние заказы:\n" + labels.join("\n")
      : "Заказов пока нет.",
    [...labels, BTN.home],
  );
  return true;
}

async function handleBookings(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  input: RouteInput,
  text: string,
  session: Awaited<ReturnType<typeof getChannelAdminSession>>,
): Promise<boolean> {
  if (!can(admin, "booking.write"))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав для записей.");
  const codes = await activeSolutions(tx, admin.businessId);
  if (!codes.has("booking")) {
    await queue("Решение «Записи» не активно.", homeButtons(codes));
    return true;
  }

  if (session?.mode === "booking_detail" && session.draft.bookingId) {
    const bookingId = String(session.draft.bookingId);
    const revision = Number(session.draft.revision);
    if (["cancel", "complete", "no_show"].includes(text)) {
      const fresh = await reResolve(tx, admin, input);
      if (!fresh || !can(fresh, "booking.write"))
        throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
      await new BookingService(tx).changeInTransaction(
        tx,
        fresh.businessId,
        bookingId,
        { action: text, revision },
        fresh.userId,
      );
      await queue(`Запись: ${text}`, [BTN.bookings, BTN.home]);
      return true;
    }
  }

  if (session?.mode === "bookings" || session?.mode === "booking_detail") {
    const map =
      (session.draft.bookings as { id: string; label: string }[]) ?? [];
    const hit = map.find((b) => b.label === text || b.id === text);
    if (hit) {
      const booking = await tx
        .selectFrom("booking")
        .selectAll()
        .where("business_id", "=", admin.businessId)
        .where("id", "=", hit.id)
        .executeTakeFirst();
      if (!booking)
        throw new AppError(404, "BOOKING_NOT_FOUND", "Запись не найдена.");
      await setChannelAdminSession(tx, {
        connectionId: input.connectionId,
        externalUserId: input.userId,
        platform: input.platform,
        userId: admin.userId,
        businessId: admin.businessId,
        mode: "booking_detail",
        draft: {
          bookingId: booking.id,
          revision: booking.revision,
          bookings: map,
        },
      });
      await queue(
        `Запись\n${booking.starts_at.toISOString()}\nСтатус: ${booking.status}`,
        ["cancel", "complete", "no_show", BTN.bookings, BTN.home],
      );
      return true;
    }
  }

  const bookings = await tx
    .selectFrom("booking")
    .select(["id", "starts_at", "status", "revision"])
    .where("business_id", "=", admin.businessId)
    .where("status", "in", ["pending", "confirmed"])
    .where("starts_at", ">=", new Date())
    .orderBy("starts_at", "asc")
    .limit(10)
    .execute();
  const labels = bookings.map(
    (b, i) =>
      `${i + 1}. ${b.starts_at.toISOString().slice(0, 16)} (${b.status})`,
  );
  await setChannelAdminSession(tx, {
    connectionId: input.connectionId,
    externalUserId: input.userId,
    platform: input.platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "bookings",
    draft: {
      bookings: bookings.map((b, i) => ({ id: b.id, label: labels[i]! })),
    },
  });
  await queue(
    bookings.length
      ? "Ближайшие записи:\n" + labels.join("\n")
      : "Предстоящих записей нет.",
    [...labels, BTN.home],
  );
  return true;
}

async function handlePosts(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
  input: RouteInput,
): Promise<boolean> {
  if (!can(admin, "posts.manage") && !can(admin, "clients.read"))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
  const codes = await activeSolutions(tx, admin.businessId);
  if (!codes.has("autopost")) {
    await queue("Решение «Публикации» не активно.", homeButtons(codes));
    return true;
  }
  const posts = await tx
    .selectFrom("post")
    .select(["id", "status", "scheduled_at", "created_at"])
    .where("business_id", "=", admin.businessId)
    .where("deleted_at", "is", null)
    .orderBy("created_at", "desc")
    .limit(10)
    .execute();
  await setChannelAdminSession(tx, {
    connectionId: input.connectionId,
    externalUserId: input.userId,
    platform: input.platform,
    userId: admin.userId,
    businessId: admin.businessId,
    mode: "posts",
    draft: {},
  });
  await queue(
    posts.length
      ? "Публикации:\n" +
          posts
            .map(
              (p, i) =>
                `${i + 1}. ${p.status}` +
                (p.scheduled_at
                  ? ` @ ${p.scheduled_at.toISOString().slice(0, 16)}`
                  : ""),
            )
            .join("\n")
      : "Публикаций пока нет.",
    homeButtons(codes),
  );
  return true;
}

async function handleStats(
  tx: Transaction<Database>,
  queue: Queue,
  admin: ChannelAdminResolved,
): Promise<boolean> {
  if (!can(admin, "analytics.view") && !can(admin, "clients.read"))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
  const [leads, orders, bookings] = await Promise.all([
    tx
      .selectFrom("lead")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("business_id", "=", admin.businessId)
      .executeTakeFirst(),
    tx
      .selectFrom("order")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("business_id", "=", admin.businessId)
      .executeTakeFirst(),
    tx
      .selectFrom("booking")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("business_id", "=", admin.businessId)
      .where("status", "in", ["pending", "confirmed"])
      .executeTakeFirst(),
  ]);
  await queue(
    `Статистика «${admin.businessName}»\nЗаявки: ${leads?.n ?? 0}\nЗаказы: ${orders?.n ?? 0}\nАктивные записи: ${bookings?.n ?? 0}`,
    homeButtons(await activeSolutions(tx, admin.businessId)),
  );
  return true;
}
