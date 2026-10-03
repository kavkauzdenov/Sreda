import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { writePlatformAudit } from "./audit.ts";
import type { AdminActor } from "./require-admin.ts";
import {
  platformAllowed,
  platformPermissions,
  type PlatformAdminRole,
} from "./permissions.ts";

// Kysely alias unions are awkward for shared filter helpers — keep them loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyQuery = { where: (...args: any[]) => any };

type SolutionStatus = Database["business_solution"]["status"];
type ConnectionStatus = Database["business_connection"]["status"];
type ConnectionPlatform = Database["business_connection"]["platform"];
type SuspensionEntity = Database["platform_suspension"]["entity_type"];

const SOLUTION_CODES = [
  "orders",
  "leads",
  "booking",
  "admin_messages",
  "autopost",
] as const;

const ADMIN_ROLES: readonly PlatformAdminRole[] = [
  "SUPER_ADMIN",
  "SUPPORT",
  "MODERATOR",
  "FINANCE",
];

type Alert = {
  severity: "warning" | "error";
  code: string;
  message: string;
  businessPublicId?: string;
  createdAt?: Date;
};

function escapeIlike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function paginate(input?: { page?: number; pageSize?: number }) {
  const page = Math.max(1, Math.floor(Number(input?.page) || 1));
  const pageSize = Math.min(
    50,
    Math.max(1, Math.floor(Number(input?.pageSize) || 20)),
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function requireReason(reason: string | undefined | null, label = "Причина") {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new AppError(
      400,
      "INVALID_REASON",
      `${label} должна быть от 3 до 500 символов.`,
    );
  }
  return trimmed;
}

function isAdminRole(value: string): value is PlatformAdminRole {
  return (ADMIN_ROLES as readonly string[]).includes(value);
}

function isSolutionStatus(value: string): value is SolutionStatus {
  return ["active", "trial", "expired", "disabled"].includes(value);
}

function looksLikeUserPublicId(q: string) {
  return /^usr_[a-f0-9]/i.test(q);
}

function looksLikeBusinessPublicId(q: string) {
  return /^biz_[a-f0-9]/i.test(q);
}

function secretFlag(
  configured: boolean,
): "configured" | "not_configured" {
  return configured ? "configured" : "not_configured";
}

function asNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export class AdminService {
  constructor(private db: Kysely<Database>) {}

  sessionInfo(actor: AdminActor) {
    return {
      id: actor.publicId,
      name: actor.name,
      username: actor.username,
      role: actor.role,
      permissions: platformPermissions(actor.role),
    };
  }

  async dashboard() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const [
      usersTotal,
      businessesTotal,
      businessesActive,
      registrations7d,
      solutionRows,
      connectionRows,
      subscriptionRows,
      ordersCount,
      leadsCount,
      bookingsCount,
      errorConnections,
      tgOutboxProblems,
      vkOutboxProblems,
      health,
      activationRows,
    ] = await Promise.all([
      this.countFrom("user"),
      this.countFrom("business"),
      this.db
        .selectFrom("business")
        .select((eb) => eb.fn.countAll<string>().as("c"))
        .where("archived_at", "is", null)
        .executeTakeFirst()
        .then((r) => asNumber(r?.c)),
      this.db
        .selectFrom("user")
        .select((eb) => eb.fn.countAll<string>().as("c"))
        .where("createdAt", ">=", weekAgo)
        .executeTakeFirst()
        .then((r) => asNumber(r?.c)),
      this.db
        .selectFrom("business_solution")
        .select(["solution_code", (eb) => eb.fn.countAll<string>().as("c")])
        .where("status", "in", ["active", "trial"])
        .where((eb) =>
          eb.or([
            eb("expires_at", "is", null),
            eb("expires_at", ">", now),
          ]),
        )
        .groupBy("solution_code")
        .execute(),
      this.db
        .selectFrom("business_connection")
        .select(["platform", "status", (eb) => eb.fn.countAll<string>().as("c")])
        .where("status", "in", ["connected", "error"])
        .groupBy(["platform", "status"])
        .execute(),
      this.db
        .selectFrom("business_solution")
        .select(["status", (eb) => eb.fn.countAll<string>().as("c")])
        .groupBy("status")
        .execute(),
      this.countFrom("order"),
      this.countFrom("lead"),
      this.countFrom("booking"),
      this.db
        .selectFrom("business_connection as c")
        .innerJoin("business as b", "b.id", "c.business_id")
        .select([
          "c.platform",
          "c.status",
          "c.updated_at",
          "b.public_id as businessPublicId",
          "b.name as businessName",
        ])
        .where("c.status", "=", "error")
        .orderBy("c.updated_at", "desc")
        .limit(20)
        .execute(),
      this.db
        .selectFrom("telegram_outbox")
        .select((eb) => eb.fn.countAll<string>().as("c"))
        .where("delivery_state", "in", ["failed", "uncertain"])
        .where((eb) =>
          eb.or([eb("attempts", ">=", 3), eb("last_error", "is not", null)]),
        )
        .executeTakeFirst()
        .then((r) => asNumber(r?.c)),
      this.db
        .selectFrom("vk_outbox")
        .select((eb) => eb.fn.countAll<string>().as("c"))
        .where("delivery_state", "in", ["failed", "uncertain"])
        .where((eb) =>
          eb.or([eb("attempts", ">=", 3), eb("last_error", "is not", null)]),
        )
        .executeTakeFirst()
        .then((r) => asNumber(r?.c)),
      this.healthSnapshot(),
      this.db
        .selectFrom("product_event")
        .select(["event", (eb) => eb.fn.countAll<string>().as("c")])
        .where("created_at", ">=", weekAgo)
        .groupBy("event")
        .execute()
        .catch(() => [] as { event: string; c: string }[]),
    ]);

    const solutionsActive = {
      orders: 0,
      leads: 0,
      booking: 0,
      admin_messages: 0,
      autopost: 0,
    };
    for (const row of solutionRows) {
      const code =
        row.solution_code === "sales" ? "orders" : row.solution_code;
      if (code in solutionsActive) {
        solutionsActive[code as keyof typeof solutionsActive] += asNumber(
          row.c,
        );
      }
    }

    const connections = {
      telegramConnected: 0,
      telegramError: 0,
      vkConnected: 0,
      vkError: 0,
    };
    for (const row of connectionRows) {
      const n = asNumber(row.c);
      if (row.platform === "telegram" && row.status === "connected")
        connections.telegramConnected = n;
      if (row.platform === "telegram" && row.status === "error")
        connections.telegramError = n;
      if (row.platform === "vk" && row.status === "connected")
        connections.vkConnected = n;
      if (row.platform === "vk" && row.status === "error")
        connections.vkError = n;
    }

    const subscriptions = {
      active: 0,
      trial: 0,
      expired: 0,
      disabled: 0,
    };
    for (const row of subscriptionRows) {
      if (row.status in subscriptions) {
        subscriptions[row.status as keyof typeof subscriptions] = asNumber(
          row.c,
        );
      }
    }

    const alerts: Alert[] = [];
    for (const row of errorConnections) {
      alerts.push({
        severity: "error",
        code: "CONNECTION_ERROR",
        message: `${row.platform}: ошибка подключения у «${row.businessName}»`,
        businessPublicId: row.businessPublicId,
        createdAt: row.updated_at,
      });
    }
    if (tgOutboxProblems > 0) {
      alerts.push({
        severity: "warning",
        code: "TELEGRAM_OUTBOX_PROBLEMS",
        message: `Telegram outbox: ${tgOutboxProblems} сообщений в failed/uncertain`,
      });
    }
    if (vkOutboxProblems > 0) {
      alerts.push({
        severity: "warning",
        code: "VK_OUTBOX_PROBLEMS",
        message: `VK outbox: ${vkOutboxProblems} сообщений в failed/uncertain`,
      });
    }
    for (const [name, status] of Object.entries(health.workers)) {
      if (status === "unavailable") {
        alerts.push({
          severity: "error",
          code: "WORKER_STALE",
          message: `Воркер «${name}» не отвечает (heartbeat старше 60с)`,
        });
      }
    }

    const activationFunnel7d: Record<string, number> = {};
    for (const row of activationRows) {
      activationFunnel7d[row.event] = asNumber(row.c);
    }

    return {
      usersTotal,
      businessesTotal,
      businessesActive,
      registrations7d,
      solutionsActive,
      connections,
      subscriptions,
      activity: {
        orders: ordersCount,
        leads: leadsCount,
        bookings: bookingsCount,
      },
      activationFunnel7d,
      health,
      alerts,
    };
  }

  async listUsers(input: {
    q?: string;
    status?: "active" | "suspended";
    adminOnly?: boolean;
    page?: number;
    pageSize?: number;
  }) {
    const { page, pageSize, offset } = paginate(input);
    let query = this.db
      .selectFrom("user as u")
      .leftJoin("platform_suspension as sus", (join) =>
        join
          .onRef("sus.entity_id", "=", "u.id")
          .on("sus.entity_type", "=", "user")
          .on("sus.lifted_at", "is", null),
      )
      .leftJoin("platform_admin as pa", (join) =>
        join
          .onRef("pa.user_id", "=", "u.id")
          .on("pa.status", "=", "active"),
      )
      .select([
        "u.id",
        "u.public_id as publicId",
        "u.name",
        "u.username",
        "u.email",
        "u.createdAt",
        "pa.role as adminRole",
        "sus.entity_id as suspendedId",
      ])
      .select((eb) =>
        eb
          .selectFrom("session as s")
          .select(sql<Date | null>`max(s."updatedAt")`.as("lastActiveAt"))
          .whereRef("s.userId", "=", "u.id")
          .as("lastActiveAt"),
      )
      .select((eb) =>
        eb
          .selectFrom("business_member as bm")
          .select((eb2) => eb2.fn.countAll<string>().as("n"))
          .whereRef("bm.user_id", "=", "u.id")
          .where("bm.status", "=", "active")
          .as("businessCount"),
      );

    query = this.applyUserSearch(query, input.q);
    if (input.status === "suspended") {
      query = query.where("sus.entity_id", "is not", null);
    } else if (input.status === "active") {
      query = query.where("sus.entity_id", "is", null);
    }
    if (input.adminOnly) {
      query = query.where("pa.user_id", "is not", null);
    }

    const countQuery = this.db
      .selectFrom("user as u")
      .leftJoin("platform_suspension as sus", (join) =>
        join
          .onRef("sus.entity_id", "=", "u.id")
          .on("sus.entity_type", "=", "user")
          .on("sus.lifted_at", "is", null),
      )
      .leftJoin("platform_admin as pa", (join) =>
        join
          .onRef("pa.user_id", "=", "u.id")
          .on("pa.status", "=", "active"),
      )
      .select((eb) => eb.fn.countAll<string>().as("c"));

    let totalQ = countQuery;
    totalQ = this.applyUserSearch(totalQ, input.q);
    if (input.status === "suspended") {
      totalQ = totalQ.where("sus.entity_id", "is not", null);
    } else if (input.status === "active") {
      totalQ = totalQ.where("sus.entity_id", "is", null);
    }
    if (input.adminOnly) {
      totalQ = totalQ.where("pa.user_id", "is not", null);
    }

    const [rows, totalRow] = await Promise.all([
      query
        .orderBy("u.createdAt", "desc")
        .limit(pageSize)
        .offset(offset)
        .execute(),
      totalQ.executeTakeFirst(),
    ]);

    return {
      items: rows.map((row) => ({
        publicId: row.publicId,
        name: row.name,
        username: row.username,
        email: row.email,
        createdAt: row.createdAt,
        lastActiveAt: row.lastActiveAt ?? null,
        businessCount: asNumber(row.businessCount),
        suspended: row.suspendedId != null,
        adminRole: (row.adminRole as PlatformAdminRole | null) ?? null,
      })),
      total: asNumber(totalRow?.c),
      page,
      pageSize,
    };
  }

  async getUser(publicId: string) {
    const user = await this.db
      .selectFrom("user as u")
      .leftJoin("platform_admin as pa", (join) =>
        join
          .onRef("pa.user_id", "=", "u.id")
          .on("pa.status", "=", "active"),
      )
      .select([
        "u.id",
        "u.public_id as publicId",
        "u.name",
        "u.username",
        "u.email",
        "u.createdAt",
        "u.updatedAt",
        "pa.role as adminRole",
      ])
      .where("u.public_id", "=", publicId)
      .executeTakeFirst();
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "Пользователь не найден.");

    const [memberships, suspensions, lastActive, audit] = await Promise.all([
      this.db
        .selectFrom("business_member as bm")
        .innerJoin("business as b", "b.id", "bm.business_id")
        .select([
          "b.public_id as businessPublicId",
          "b.name as businessName",
          "bm.role",
          "bm.status",
          "bm.created_at as createdAt",
          "b.archived_at as archivedAt",
        ])
        .where("bm.user_id", "=", user.id)
        .orderBy("bm.created_at", "desc")
        .execute(),
      this.db
        .selectFrom("platform_suspension")
        .select([
          "reason",
          "created_at as createdAt",
          "lifted_at as liftedAt",
          "created_by as createdBy",
          "lifted_by as liftedBy",
        ])
        .where("entity_type", "=", "user")
        .where("entity_id", "=", user.id)
        .orderBy("created_at", "desc")
        .execute(),
      this.db
        .selectFrom("session")
        .select(sql<Date | null>`max("updatedAt")`.as("lastActiveAt"))
        .where("userId", "=", user.id)
        .executeTakeFirst(),
      this.db
        .selectFrom("platform_admin_audit_log as a")
        .innerJoin("user as admin", "admin.id", "a.admin_user_id")
        .select([
          "a.id",
          "a.action",
          "a.target_type as targetType",
          "a.target_id as targetId",
          "a.reason",
          "a.created_at as createdAt",
          "admin.public_id as adminPublicId",
          "admin.username as adminUsername",
          "a.admin_role as adminRole",
        ])
        .where("a.target_type", "=", "user")
        .where("a.target_id", "=", user.id)
        .orderBy("a.created_at", "desc")
        .limit(50)
        .execute(),
    ]);

    return {
      publicId: user.publicId,
      name: user.name,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      lastActiveAt: lastActive?.lastActiveAt ?? null,
      adminRole: (user.adminRole as PlatformAdminRole | null) ?? null,
      suspended: suspensions.some((s) => s.liftedAt == null),
      businesses: memberships.map((m) => ({
        publicId: m.businessPublicId,
        name: m.businessName,
        role: m.role,
        status: m.status,
        archived: m.archivedAt != null,
        createdAt: m.createdAt,
      })),
      suspensions,
      recentAudit: audit,
    };
  }

  async listBusinesses(input: {
    q?: string;
    industry?: string;
    status?: "active" | "archived" | "suspended";
    telegram?: ConnectionStatus | "any";
    vk?: ConnectionStatus | "any";
    solution?: string;
    page?: number;
    pageSize?: number;
  }) {
    const { page, pageSize, offset } = paginate(input);

    let base = this.db
      .selectFrom("business as b")
      .innerJoin("business_member as owner_m", (join) =>
        join
          .onRef("owner_m.business_id", "=", "b.id")
          .on("owner_m.role", "=", "owner")
          .on("owner_m.status", "=", "active"),
      )
      .innerJoin("user as owner", "owner.id", "owner_m.user_id")
      .leftJoin("platform_suspension as sus", (join) =>
        join
          .onRef("sus.entity_id", "=", "b.id")
          .on("sus.entity_type", "=", "business")
          .on("sus.lifted_at", "is", null),
      )
      .leftJoin("business_connection as tg", (join) =>
        join
          .onRef("tg.business_id", "=", "b.id")
          .on("tg.platform", "=", "telegram"),
      )
      .leftJoin("business_connection as vk", (join) =>
        join
          .onRef("vk.business_id", "=", "b.id")
          .on("vk.platform", "=", "vk"),
      );

    base = this.applyBusinessFilters(base, input);

    const rows = await base
      .select([
        "b.id",
        "b.public_id as publicId",
        "b.name",
        "b.industry",
        "b.business_model as businessModel",
        "b.created_at as createdAt",
        "b.archived_at as archivedAt",
        "owner.name as ownerName",
        "owner.username as ownerUsername",
        "tg.status as telegramStatus",
        "vk.status as vkStatus",
        "sus.entity_id as suspendedId",
      ])
      .orderBy("b.created_at", "desc")
      .limit(pageSize)
      .offset(offset)
      .execute();

    let countBase = this.db
      .selectFrom("business as b")
      .innerJoin("business_member as owner_m", (join) =>
        join
          .onRef("owner_m.business_id", "=", "b.id")
          .on("owner_m.role", "=", "owner")
          .on("owner_m.status", "=", "active"),
      )
      .innerJoin("user as owner", "owner.id", "owner_m.user_id")
      .leftJoin("platform_suspension as sus", (join) =>
        join
          .onRef("sus.entity_id", "=", "b.id")
          .on("sus.entity_type", "=", "business")
          .on("sus.lifted_at", "is", null),
      )
      .leftJoin("business_connection as tg", (join) =>
        join
          .onRef("tg.business_id", "=", "b.id")
          .on("tg.platform", "=", "telegram"),
      )
      .leftJoin("business_connection as vk", (join) =>
        join
          .onRef("vk.business_id", "=", "b.id")
          .on("vk.platform", "=", "vk"),
      );
    countBase = this.applyBusinessFilters(countBase, input);
    const totalRow = await countBase
      .select((eb) => eb.fn.countAll<string>().as("c"))
      .executeTakeFirst();

    const ids = rows.map((r) => r.id);
    const solutionRows =
      ids.length === 0
        ? []
        : await this.db
            .selectFrom("business_solution")
            .select(["business_id", "solution_code", "status", "expires_at"])
            .where("business_id", "in", ids)
            .execute();

    const byBusiness = new Map<string, typeof solutionRows>();
    for (const s of solutionRows) {
      const list = byBusiness.get(s.business_id) ?? [];
      list.push(s);
      byBusiness.set(s.business_id, list);
    }

    return {
      items: rows.map((row) => ({
        publicId: row.publicId,
        name: row.name,
        ownerName: row.ownerName,
        ownerUsername: row.ownerUsername,
        industry: row.industry,
        businessModel: row.businessModel,
        createdAt: row.createdAt,
        solutions: (byBusiness.get(row.id) ?? []).map((s) => ({
          code: s.solution_code === "sales" ? "orders" : s.solution_code,
          status: s.status,
          expiresAt: s.expires_at,
        })),
        telegramStatus: row.telegramStatus ?? null,
        vkStatus: row.vkStatus ?? null,
        suspended: row.suspendedId != null,
        archived: row.archivedAt != null,
      })),
      total: asNumber(totalRow?.c),
      page,
      pageSize,
    };
  }

  async getBusiness(publicId: string) {
    const business = await this.db
      .selectFrom("business as b")
      .selectAll("b")
      .where("b.public_id", "=", publicId)
      .executeTakeFirst();
    if (!business)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");

    const [
      owner,
      members,
      solutions,
      connections,
      secrets,
      tgRuntime,
      vkRuntime,
      counts,
      suspensions,
      audit,
      tgLastError,
      vkLastError,
    ] = await Promise.all([
      this.db
        .selectFrom("business_member as bm")
        .innerJoin("user as u", "u.id", "bm.user_id")
        .select([
          "u.public_id as publicId",
          "u.name",
          "u.username",
          "u.email",
        ])
        .where("bm.business_id", "=", business.id)
        .where("bm.role", "=", "owner")
        .where("bm.status", "=", "active")
        .executeTakeFirst(),
      this.db
        .selectFrom("business_member as bm")
        .innerJoin("user as u", "u.id", "bm.user_id")
        .select([
          "u.public_id as publicId",
          "u.name",
          "u.username",
          "bm.role",
          "bm.status",
          "bm.created_at as createdAt",
        ])
        .where("bm.business_id", "=", business.id)
        .orderBy("bm.created_at", "asc")
        .execute(),
      this.db
        .selectFrom("business_solution")
        .select([
          "solution_code as code",
          "status",
          "starts_at as startsAt",
          "expires_at as expiresAt",
          "created_at as createdAt",
          "updated_at as updatedAt",
        ])
        .where("business_id", "=", business.id)
        .orderBy("solution_code")
        .execute(),
      this.db
        .selectFrom("business_connection")
        .select([
          "id",
          "platform",
          "status",
          "display_name as displayName",
          "external_account_id as externalAccountId",
          "updated_at as updatedAt",
        ])
        .where("business_id", "=", business.id)
        .execute(),
      this.db
        .selectFrom("connection_secret as s")
        .innerJoin(
          "business_connection as c",
          "c.id",
          "s.connection_id",
        )
        .select(["s.connection_id as connectionId"])
        .where("c.business_id", "=", business.id)
        .execute(),
      this.db
        .selectFrom("telegram_runtime as r")
        .innerJoin(
          "business_connection as c",
          "c.id",
          "r.connection_id",
        )
        .select(["r.connection_id", "r.status", "r.updated_at as updatedAt"])
        .where("c.business_id", "=", business.id)
        .execute(),
      this.db
        .selectFrom("vk_runtime as r")
        .innerJoin(
          "business_connection as c",
          "c.id",
          "r.connection_id",
        )
        .select(["r.connection_id", "r.status", "r.updated_at as updatedAt"])
        .where("c.business_id", "=", business.id)
        .execute(),
      Promise.all([
        this.db
          .selectFrom("client")
          .select((eb) => eb.fn.countAll<string>().as("c"))
          .where("business_id", "=", business.id)
          .executeTakeFirst()
          .then((r) => asNumber(r?.c)),
        this.db
          .selectFrom("order")
          .select((eb) => eb.fn.countAll<string>().as("c"))
          .where("business_id", "=", business.id)
          .executeTakeFirst()
          .then((r) => asNumber(r?.c)),
        this.db
          .selectFrom("lead")
          .select((eb) => eb.fn.countAll<string>().as("c"))
          .where("business_id", "=", business.id)
          .executeTakeFirst()
          .then((r) => asNumber(r?.c)),
        this.db
          .selectFrom("booking")
          .select((eb) => eb.fn.countAll<string>().as("c"))
          .where("business_id", "=", business.id)
          .executeTakeFirst()
          .then((r) => asNumber(r?.c)),
      ]),
      this.db
        .selectFrom("platform_suspension")
        .select([
          "reason",
          "created_at as createdAt",
          "lifted_at as liftedAt",
          "created_by as createdBy",
          "lifted_by as liftedBy",
        ])
        .where("entity_type", "=", "business")
        .where("entity_id", "=", business.id)
        .orderBy("created_at", "desc")
        .execute(),
      this.db
        .selectFrom("business_audit_log as a")
        .leftJoin("user as u", "u.id", "a.actor_user_id")
        .select([
          "a.id",
          "a.action",
          "a.actor_type as actorType",
          "a.target_id as targetId",
          "a.details",
          "a.created_at as createdAt",
          "u.public_id as actorPublicId",
          "u.username as actorUsername",
        ])
        .where("a.business_id", "=", business.id)
        .orderBy("a.created_at", "desc")
        .limit(50)
        .execute(),
      this.latestOutboxError("telegram", business.id),
      this.latestOutboxError("vk", business.id),
    ]);

    const secretSet = new Set(secrets.map((s) => s.connectionId));
    const tgRuntimeById = new Map(
      tgRuntime.map((r) => [r.connection_id, r] as const),
    );
    const vkRuntimeById = new Map(
      vkRuntime.map((r) => [r.connection_id, r] as const),
    );

    const channel = (platform: ConnectionPlatform) => {
      const conn = connections.find((c) => c.platform === platform) ?? null;
      if (!conn) {
        return {
          status: null as ConnectionStatus | null,
          displayName: null as string | null,
          externalAccountId: null as string | null,
          secretConfigured: secretFlag(false),
          runtimeStatus: null as string | null,
          lastError: null as string | null,
        };
      }
      const runtime =
        platform === "telegram"
          ? tgRuntimeById.get(conn.id)
          : vkRuntimeById.get(conn.id);
      return {
        status: conn.status,
        displayName: conn.displayName,
        externalAccountId: conn.externalAccountId,
        secretConfigured: secretFlag(secretSet.has(conn.id)),
        runtimeStatus: runtime?.status ?? null,
        lastError:
          platform === "telegram" ? tgLastError : vkLastError,
      };
    };

    const [clients, orders, leads, bookings] = counts;

    return {
      publicId: business.public_id,
      name: business.name,
      industry: business.industry,
      industrySubtype: business.industry_subtype,
      businessModel: business.business_model,
      setupMode: business.setup_mode,
      timezone: business.timezone,
      createdAt: business.created_at,
      archivedAt: business.archived_at,
      archived: business.archived_at != null,
      suspended: suspensions.some((s) => s.liftedAt == null),
      overview: {
        owner: owner ?? null,
        members,
        industry: business.industry,
        businessModel: business.business_model,
        setupMode: business.setup_mode,
        solutions: solutions.map((s) => ({
          ...s,
          code: s.code === "sales" ? "orders" : s.code,
        })),
        telegram: channel("telegram"),
        vk: channel("vk"),
        counts: { clients, orders, leads, bookings },
      },
      subscriptions: solutions.map((s) => ({
        ...s,
        code: s.code === "sales" ? "orders" : s.code,
      })),
      recentAudit: audit,
      platformSuspensions: suspensions,
    };
  }

  async listSubscriptions(input: {
    status?: SolutionStatus;
    page?: number;
    pageSize?: number;
    q?: string;
  }) {
    const { page, pageSize, offset } = paginate(input);
    let query = this.db
      .selectFrom("business_solution as s")
      .innerJoin("business as b", "b.id", "s.business_id")
      .innerJoin("business_member as owner_m", (join) =>
        join
          .onRef("owner_m.business_id", "=", "b.id")
          .on("owner_m.role", "=", "owner")
          .on("owner_m.status", "=", "active"),
      )
      .innerJoin("user as owner", "owner.id", "owner_m.user_id")
      .select([
        "b.public_id as businessPublicId",
        "b.name as businessName",
        "owner.name as ownerName",
        "owner.username as ownerUsername",
        "s.solution_code as solutionCode",
        "s.status",
        "s.starts_at as startsAt",
        "s.expires_at as expiresAt",
        "s.updated_at as updatedAt",
      ]);

    if (input.status) {
      if (!isSolutionStatus(input.status)) {
        throw new AppError(400, "INVALID_STATUS", "Неизвестный статус.");
      }
      query = query.where("s.status", "=", input.status);
    }
    if (input.q?.trim()) {
      const q = input.q.trim();
      const escaped = escapeIlike(q);
      query = query.where((eb) =>
        eb.or([
          ...(looksLikeBusinessPublicId(q)
            ? [
                eb("b.public_id", "=", q),
                eb("b.public_id", "like", q + "%"),
              ]
            : []),
          sql<boolean>`b.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`owner.username ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`s.solution_code ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      );
    }

    let countQ = this.db
      .selectFrom("business_solution as s")
      .innerJoin("business as b", "b.id", "s.business_id")
      .innerJoin("business_member as owner_m", (join) =>
        join
          .onRef("owner_m.business_id", "=", "b.id")
          .on("owner_m.role", "=", "owner")
          .on("owner_m.status", "=", "active"),
      )
      .innerJoin("user as owner", "owner.id", "owner_m.user_id")
      .select((eb) => eb.fn.countAll<string>().as("c"));
    if (input.status) countQ = countQ.where("s.status", "=", input.status);
    if (input.q?.trim()) {
      const q = input.q.trim();
      const escaped = escapeIlike(q);
      countQ = countQ.where((eb) =>
        eb.or([
          ...(looksLikeBusinessPublicId(q)
            ? [
                eb("b.public_id", "=", q),
                eb("b.public_id", "like", q + "%"),
              ]
            : []),
          sql<boolean>`b.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`owner.username ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`s.solution_code ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      );
    }

    const [rows, totalRow] = await Promise.all([
      query
        .orderBy("s.updated_at", "desc")
        .limit(pageSize)
        .offset(offset)
        .execute(),
      countQ.executeTakeFirst(),
    ]);

    return {
      items: rows.map((r) => ({
        ...r,
        solutionCode:
          r.solutionCode === "sales" ? "orders" : r.solutionCode,
      })),
      total: asNumber(totalRow?.c),
      page,
      pageSize,
    };
  }

  async listIntegrations(input: {
    platform?: ConnectionPlatform;
    status?: ConnectionStatus;
    page?: number;
    pageSize?: number;
    q?: string;
  }) {
    const { page, pageSize, offset } = paginate(input);
    let query = this.db
      .selectFrom("business_connection as c")
      .innerJoin("business as b", "b.id", "c.business_id")
      .leftJoin("connection_secret as s", "s.connection_id", "c.id")
      .select([
        "c.id as connectionId",
        "c.platform",
        "c.status",
        "c.display_name as displayName",
        "c.external_account_id as externalAccountId",
        "c.updated_at as updatedAt",
        "c.created_at as createdAt",
        "b.public_id as businessPublicId",
        "b.name as businessName",
        "s.connection_id as secretConnectionId",
      ]);

    if (input.platform === "telegram" || input.platform === "vk") {
      query = query.where("c.platform", "=", input.platform);
    }
    if (
      input.status &&
      ["pending", "connected", "error", "disconnected"].includes(input.status)
    ) {
      query = query.where("c.status", "=", input.status);
    }
    if (input.q?.trim()) {
      const q = input.q.trim();
      const escaped = escapeIlike(q);
      query = query.where((eb) =>
        eb.or([
          ...(looksLikeBusinessPublicId(q)
            ? [
                eb("b.public_id", "=", q),
                eb("b.public_id", "like", q + "%"),
              ]
            : []),
          sql<boolean>`b.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`c.display_name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`c.external_account_id ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      );
    }

    let countQ = this.db
      .selectFrom("business_connection as c")
      .innerJoin("business as b", "b.id", "c.business_id")
      .select((eb) => eb.fn.countAll<string>().as("c"));
    if (input.platform === "telegram" || input.platform === "vk") {
      countQ = countQ.where("c.platform", "=", input.platform);
    }
    if (
      input.status &&
      ["pending", "connected", "error", "disconnected"].includes(input.status)
    ) {
      countQ = countQ.where("c.status", "=", input.status);
    }
    if (input.q?.trim()) {
      const q = input.q.trim();
      const escaped = escapeIlike(q);
      countQ = countQ.where((eb) =>
        eb.or([
          ...(looksLikeBusinessPublicId(q)
            ? [
                eb("b.public_id", "=", q),
                eb("b.public_id", "like", q + "%"),
              ]
            : []),
          sql<boolean>`b.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`c.display_name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`c.external_account_id ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      );
    }

    const [rows, totalRow] = await Promise.all([
      query
        .orderBy("c.updated_at", "desc")
        .limit(pageSize)
        .offset(offset)
        .execute(),
      countQ.executeTakeFirst(),
    ]);

    return {
      items: rows.map((r) => ({
        connectionId: r.connectionId,
        platform: r.platform,
        status: r.status,
        displayName: r.displayName,
        externalAccountId: r.externalAccountId,
        businessPublicId: r.businessPublicId,
        businessName: r.businessName,
        secretConfigured: secretFlag(r.secretConnectionId != null),
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      total: asNumber(totalRow?.c),
      page,
      pageSize,
    };
  }

  async integrationDiagnostics(connectionId: string) {
    const conn = await this.db
      .selectFrom("business_connection as c")
      .innerJoin("business as b", "b.id", "c.business_id")
      .select([
        "c.id",
        "c.platform",
        "c.status",
        "c.display_name as displayName",
        "c.external_account_id as externalAccountId",
        "c.created_at as createdAt",
        "c.updated_at as updatedAt",
        "b.public_id as businessPublicId",
        "b.name as businessName",
        "b.id as businessId",
      ])
      .where("c.id", "=", connectionId)
      .executeTakeFirst();
    if (!conn)
      throw new AppError(404, "CONNECTION_NOT_FOUND", "Подключение не найдено.");

    const secret = await this.db
      .selectFrom("connection_secret")
      .select(["connection_id", "key_version", "updated_at as updatedAt"])
      .where("connection_id", "=", connectionId)
      .executeTakeFirst();

    const runtime =
      conn.platform === "telegram"
        ? await this.db
            .selectFrom("telegram_runtime")
            .select([
              "status",
              "generation",
              "updated_at as updatedAt",
            ])
            .where("connection_id", "=", connectionId)
            .executeTakeFirst()
        : await this.db
            .selectFrom("vk_runtime")
            .select([
              "status",
              "generation",
              "updated_at as updatedAt",
              "server_id as serverId",
              "confirmation_code as confirmationConfigured",
            ])
            .where("connection_id", "=", connectionId)
            .executeTakeFirst();

    const outboxTable =
      conn.platform === "telegram" ? "telegram_outbox" : "vk_outbox";
    const outboxStats = await this.db
      .selectFrom(outboxTable)
      .select([
        "delivery_state as deliveryState",
        (eb) => eb.fn.countAll<string>().as("c"),
      ])
      .where("connection_id", "=", connectionId)
      .groupBy("delivery_state")
      .execute();

    const recentErrors = await this.db
      .selectFrom(outboxTable)
      .select([
        "id",
        "delivery_state as deliveryState",
        "attempts",
        "last_error as lastError",
        "available_at as availableAt",
        "created_at as createdAt",
      ])
      .where("connection_id", "=", connectionId)
      .where((eb) =>
        eb.or([
          eb("delivery_state", "in", ["failed", "uncertain"]),
          eb("last_error", "is not", null),
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(20)
      .execute();

    return {
      connectionId: conn.id,
      platform: conn.platform,
      status: conn.status,
      displayName: conn.displayName,
      externalAccountId: conn.externalAccountId,
      businessPublicId: conn.businessPublicId,
      businessName: conn.businessName,
      createdAt: conn.createdAt,
      updatedAt: conn.updatedAt,
      secretConfigured: secretFlag(secret != null),
      secretKeyVersion: secret?.key_version ?? null,
      secretUpdatedAt: secret?.updatedAt ?? null,
      runtime: runtime
        ? {
            status: runtime.status,
            generation: runtime.generation,
            updatedAt: runtime.updatedAt,
            ...(conn.platform === "vk"
              ? {
                  serverId:
                    "serverId" in runtime ? runtime.serverId : null,
                  confirmationConfigured:
                    "confirmationConfigured" in runtime &&
                    runtime.confirmationConfigured
                      ? "configured"
                      : "not_configured",
                }
              : {}),
          }
        : null,
      outboxByState: Object.fromEntries(
        outboxStats.map((r) => [r.deliveryState, asNumber(r.c)]),
      ),
      recentErrors: recentErrors.map((e) => ({
        id: e.id,
        deliveryState: e.deliveryState,
        attempts: e.attempts,
        lastError: e.lastError,
        availableAt: e.availableAt,
        createdAt: e.createdAt,
      })),
    };
  }

  async listAudit(input: {
    admin?: string;
    action?: string;
    targetType?: string;
    businessPublicId?: string;
    from?: string;
    until?: string;
    page?: number;
    pageSize?: number;
  }) {
    const { page, pageSize, offset } = paginate(input);
    let query = this.db
      .selectFrom("platform_admin_audit_log as a")
      .innerJoin("user as admin", "admin.id", "a.admin_user_id")
      .leftJoin("business as b", "b.id", "a.business_id")
      .select([
        "a.id",
        "a.action",
        "a.target_type as targetType",
        "a.target_id as targetId",
        "a.reason",
        "a.metadata",
        "a.request_id as requestId",
        "a.created_at as createdAt",
        "a.admin_role as adminRole",
        "admin.public_id as adminPublicId",
        "admin.username as adminUsername",
        "admin.name as adminName",
        "b.public_id as businessPublicId",
      ]);

    if (input.admin?.trim()) {
      const admin = input.admin.trim();
      if (looksLikeUserPublicId(admin)) {
        query = query.where((eb) =>
          eb.or([
            eb("admin.public_id", "=", admin),
            eb("admin.public_id", "like", admin + "%"),
          ]),
        );
      } else {
        const escaped = escapeIlike(admin);
        query = query.where(
          sql<boolean>`admin.username ilike ${"%" + escaped + "%"} escape '\\'`,
        );
      }
    }
    if (input.action?.trim()) {
      query = query.where("a.action", "=", input.action.trim());
    }
    if (input.targetType?.trim()) {
      query = query.where("a.target_type", "=", input.targetType.trim());
    }
    if (input.businessPublicId?.trim()) {
      query = query.where(
        "b.public_id",
        "=",
        input.businessPublicId.trim(),
      );
    }
    if (input.from) {
      const from = new Date(input.from);
      if (!Number.isFinite(+from))
        throw new AppError(400, "INVALID_DATE", "Проверьте период.");
      query = query.where("a.created_at", ">=", from);
    }
    if (input.until) {
      const until = new Date(input.until);
      if (!Number.isFinite(+until))
        throw new AppError(400, "INVALID_DATE", "Проверьте период.");
      query = query.where("a.created_at", "<", until);
    }

    let countQ = this.db
      .selectFrom("platform_admin_audit_log as a")
      .innerJoin("user as admin", "admin.id", "a.admin_user_id")
      .leftJoin("business as b", "b.id", "a.business_id")
      .select((eb) => eb.fn.countAll<string>().as("c"));
    if (input.admin?.trim()) {
      const admin = input.admin.trim();
      if (looksLikeUserPublicId(admin)) {
        countQ = countQ.where((eb) =>
          eb.or([
            eb("admin.public_id", "=", admin),
            eb("admin.public_id", "like", admin + "%"),
          ]),
        );
      } else {
        const escaped = escapeIlike(admin);
        countQ = countQ.where(
          sql<boolean>`admin.username ilike ${"%" + escaped + "%"} escape '\\'`,
        );
      }
    }
    if (input.action?.trim())
      countQ = countQ.where("a.action", "=", input.action.trim());
    if (input.targetType?.trim())
      countQ = countQ.where("a.target_type", "=", input.targetType.trim());
    if (input.businessPublicId?.trim())
      countQ = countQ.where(
        "b.public_id",
        "=",
        input.businessPublicId.trim(),
      );
    if (input.from) {
      const from = new Date(input.from);
      countQ = countQ.where("a.created_at", ">=", from);
    }
    if (input.until) {
      const until = new Date(input.until);
      countQ = countQ.where("a.created_at", "<", until);
    }

    const [rows, totalRow] = await Promise.all([
      query
        .orderBy("a.created_at", "desc")
        .limit(pageSize)
        .offset(offset)
        .execute(),
      countQ.executeTakeFirst(),
    ]);

    return {
      items: rows,
      total: asNumber(totalRow?.c),
      page,
      pageSize,
    };
  }

  async search(q: string) {
    const trimmed = typeof q === "string" ? q.trim() : "";
    if (trimmed.length < 2) {
      throw new AppError(
        400,
        "INVALID_SEARCH",
        "Введите не менее 2 символов.",
      );
    }
    const escaped = escapeIlike(trimmed);

    const usersQ = this.db
      .selectFrom("user")
      .select([
        "public_id as publicId",
        "name",
        "username",
        "email",
        "createdAt",
      ])
      .where((eb) =>
        eb.or([
          ...(looksLikeUserPublicId(trimmed)
            ? [
                eb("public_id", "=", trimmed),
                eb("public_id", "like", trimmed + "%"),
              ]
            : []),
          sql<boolean>`name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`username ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`email ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      )
      .orderBy("createdAt", "desc")
      .limit(10);

    const businessesQ = this.db
      .selectFrom("business")
      .select([
        "public_id as publicId",
        "name",
        "industry",
        "created_at as createdAt",
        "archived_at as archivedAt",
      ])
      .where((eb) =>
        eb.or([
          ...(looksLikeBusinessPublicId(trimmed)
            ? [
                eb("public_id", "=", trimmed),
                eb("public_id", "like", trimmed + "%"),
              ]
            : []),
          sql<boolean>`name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`industry ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      )
      .orderBy("created_at", "desc")
      .limit(10);

    const [users, businesses] = await Promise.all([
      usersQ.execute(),
      businessesQ.execute(),
    ]);

    return {
      users,
      businesses: businesses.map((b) => ({
        publicId: b.publicId,
        name: b.name,
        industry: b.industry,
        createdAt: b.createdAt,
        archived: b.archivedAt != null,
      })),
    };
  }

  async suspendEntity(
    actor: AdminActor,
    input: {
      entityType: SuspensionEntity;
      entityPublicId: string;
      reason: string;
    },
  ) {
    if (input.entityType !== "user" && input.entityType !== "business") {
      throw new AppError(400, "INVALID_ENTITY", "Неизвестный тип сущности.");
    }
    const reason = requireReason(input.reason);
    const entity = await this.resolveEntity(
      input.entityType,
      input.entityPublicId,
    );

    const existing = await this.db
      .selectFrom("platform_suspension")
      .select(["lifted_at"])
      .where("entity_type", "=", input.entityType)
      .where("entity_id", "=", entity.id)
      .executeTakeFirst();
    if (existing && existing.lifted_at == null) {
      throw new AppError(
        409,
        "ALREADY_SUSPENDED",
        "Сущность уже приостановлена.",
      );
    }

    await this.db
      .insertInto("platform_suspension")
      .values({
        entity_type: input.entityType,
        entity_id: entity.id,
        reason,
        created_by: actor.userId,
        lifted_at: null,
        lifted_by: null,
      })
      .onConflict((oc) =>
        oc.columns(["entity_type", "entity_id"]).doUpdateSet({
          reason,
          created_by: actor.userId,
          created_at: new Date(),
          lifted_at: null,
          lifted_by: null,
        }),
      )
      .execute();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "entity.suspend",
      targetType: input.entityType,
      targetId: entity.id,
      businessId: input.entityType === "business" ? entity.id : null,
      reason,
      metadata: { publicId: entity.publicId },
      requestId: actor.requestId,
    });

    return { ok: true as const, publicId: entity.publicId };
  }

  async liftSuspension(
    actor: AdminActor,
    input: {
      entityType: SuspensionEntity;
      entityPublicId: string;
      reason: string;
    },
  ) {
    if (input.entityType !== "user" && input.entityType !== "business") {
      throw new AppError(400, "INVALID_ENTITY", "Неизвестный тип сущности.");
    }
    const reason = requireReason(input.reason);
    const entity = await this.resolveEntity(
      input.entityType,
      input.entityPublicId,
    );

    const existing = await this.db
      .selectFrom("platform_suspension")
      .select(["lifted_at"])
      .where("entity_type", "=", input.entityType)
      .where("entity_id", "=", entity.id)
      .executeTakeFirst();
    if (!existing || existing.lifted_at != null) {
      throw new AppError(
        404,
        "SUSPENSION_NOT_FOUND",
        "Активная приостановка не найдена.",
      );
    }

    await this.db
      .updateTable("platform_suspension")
      .set({
        lifted_at: new Date(),
        lifted_by: actor.userId,
      })
      .where("entity_type", "=", input.entityType)
      .where("entity_id", "=", entity.id)
      .where("lifted_at", "is", null)
      .execute();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "entity.lift_suspension",
      targetType: input.entityType,
      targetId: entity.id,
      businessId: input.entityType === "business" ? entity.id : null,
      reason,
      metadata: { publicId: entity.publicId },
      requestId: actor.requestId,
    });

    return { ok: true as const, publicId: entity.publicId };
  }

  async assignAdminRole(
    actor: AdminActor,
    input: { userPublicId: string; role: PlatformAdminRole },
  ) {
    if (!platformAllowed(actor.role, "admin.admins.manage")) {
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    }
    if (!isAdminRole(input.role)) {
      throw new AppError(400, "INVALID_ROLE", "Неизвестная роль.");
    }

    const user = await this.db
      .selectFrom("user")
      .select(["id", "public_id"])
      .where("public_id", "=", input.userPublicId)
      .executeTakeFirst();
    if (!user)
      throw new AppError(404, "USER_NOT_FOUND", "Пользователь не найден.");

    const current = await this.db
      .selectFrom("platform_admin")
      .select(["role", "status"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();

    if (
      current?.status === "active" &&
      current.role === "SUPER_ADMIN" &&
      input.role !== "SUPER_ADMIN"
    ) {
      await this.assertNotLastSuperAdmin(user.id);
    }

    await this.db
      .insertInto("platform_admin")
      .values({
        user_id: user.id,
        role: input.role,
        status: "active",
        created_by: actor.userId,
        revoked_at: null,
      })
      .onConflict((oc) =>
        oc.column("user_id").doUpdateSet({
          role: input.role,
          status: "active",
          revoked_at: null,
          updated_at: new Date(),
        }),
      )
      .execute();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "admin.assign_role",
      targetType: "user",
      targetId: user.id,
      reason: null,
      metadata: {
        publicId: user.public_id,
        role: input.role,
        previousRole: current?.role ?? null,
      },
      requestId: actor.requestId,
    });

    return { ok: true as const, publicId: user.public_id, role: input.role };
  }

  async revokeAdminRole(
    actor: AdminActor,
    input: { userPublicId: string; reason: string },
  ) {
    if (!platformAllowed(actor.role, "admin.admins.manage")) {
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    }
    const reason = requireReason(input.reason);

    const user = await this.db
      .selectFrom("user")
      .select(["id", "public_id"])
      .where("public_id", "=", input.userPublicId)
      .executeTakeFirst();
    if (!user)
      throw new AppError(404, "USER_NOT_FOUND", "Пользователь не найден.");

    const current = await this.db
      .selectFrom("platform_admin")
      .select(["role", "status"])
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (!current || current.status !== "active") {
      throw new AppError(
        404,
        "ADMIN_NOT_FOUND",
        "Администратор не найден.",
      );
    }
    if (current.role === "SUPER_ADMIN") {
      await this.assertNotLastSuperAdmin(user.id);
    }

    await this.db
      .updateTable("platform_admin")
      .set({
        status: "revoked",
        revoked_at: new Date(),
        updated_at: new Date(),
      })
      .where("user_id", "=", user.id)
      .execute();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "admin.revoke_role",
      targetType: "user",
      targetId: user.id,
      reason,
      metadata: {
        publicId: user.public_id,
        previousRole: current.role,
      },
      requestId: actor.requestId,
    });

    return { ok: true as const, publicId: user.public_id };
  }

  async overrideSolution(
    actor: AdminActor,
    input: {
      businessPublicId: string;
      solutionCode: string;
      status: SolutionStatus;
      expiresAt?: string | null;
      reason: string;
    },
  ) {
    if (!platformAllowed(actor.role, "admin.subscriptions.manage")) {
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    }
    const reason = requireReason(input.reason);
    if (!isSolutionStatus(input.status)) {
      throw new AppError(400, "INVALID_STATUS", "Неизвестный статус.");
    }
    const code =
      input.solutionCode === "sales" ? "orders" : input.solutionCode;
    if (
      !(SOLUTION_CODES as readonly string[]).includes(code) &&
      code !== "moderation"
    ) {
      throw new AppError(400, "INVALID_SOLUTION", "Неизвестное решение.");
    }

    let expiresAt: Date | null = null;
    if (input.expiresAt != null && input.expiresAt !== "") {
      expiresAt = new Date(input.expiresAt);
      if (!Number.isFinite(+expiresAt)) {
        throw new AppError(400, "INVALID_DATE", "Проверьте дату окончания.");
      }
    }

    const business = await this.db
      .selectFrom("business")
      .select(["id", "public_id"])
      .where("public_id", "=", input.businessPublicId)
      .executeTakeFirst();
    if (!business)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");

    const previous = await this.db
      .selectFrom("business_solution")
      .select(["status", "expires_at", "starts_at"])
      .where("business_id", "=", business.id)
      .where("solution_code", "=", code)
      .executeTakeFirst();

    await this.db
      .insertInto("business_solution")
      .values({
        business_id: business.id,
        solution_code: code,
        status: input.status,
        starts_at: previous?.starts_at ?? new Date(),
        expires_at: expiresAt,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "solution_code"]).doUpdateSet({
          status: input.status,
          expires_at: expiresAt,
          updated_at: new Date(),
        }),
      )
      .execute();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "subscription.override",
      targetType: "business_solution",
      targetId: `${business.id}:${code}`,
      businessId: business.id,
      reason,
      metadata: {
        businessPublicId: business.public_id,
        solutionCode: code,
        status: input.status,
        expiresAt: expiresAt?.toISOString() ?? null,
        previousStatus: previous?.status ?? null,
      },
      requestId: actor.requestId,
    });

    return {
      ok: true as const,
      businessPublicId: business.public_id,
      solutionCode: code,
      status: input.status,
      expiresAt,
    };
  }

  async retryOutbox(
    actor: AdminActor,
    input: {
      platform: ConnectionPlatform;
      outboxId: string;
      reason: string;
    },
  ) {
    if (
      !platformAllowed(actor.role, "admin.support.manage") &&
      !platformAllowed(actor.role, "admin.integrations.manage")
    ) {
      throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
    }
    const reason = requireReason(input.reason);
    if (input.platform !== "telegram" && input.platform !== "vk") {
      throw new AppError(400, "INVALID_PLATFORM", "Выберите Telegram или VK.");
    }

    const table =
      input.platform === "telegram" ? "telegram_outbox" : "vk_outbox";
    const row = await this.db
      .selectFrom(table)
      .select([
        "id",
        "connection_id",
        "delivery_state",
        "attempts",
        "last_error",
      ])
      .where("id", "=", input.outboxId)
      .executeTakeFirst();
    if (!row)
      throw new AppError(404, "OUTBOX_NOT_FOUND", "Сообщение не найдено.");

    if (
      row.delivery_state === "pending" ||
      row.delivery_state === "sending"
    ) {
      return {
        ok: true as const,
        outboxId: row.id,
        deliveryState: row.delivery_state,
        retried: false,
      };
    }
    if (row.delivery_state === "sent") {
      throw new AppError(
        409,
        "OUTBOX_ALREADY_SENT",
        "Сообщение уже доставлено.",
      );
    }

    await this.db
      .updateTable(table)
      .set({
        delivery_state: "pending",
        available_at: new Date(),
        claimed_at: null,
      })
      .where("id", "=", row.id)
      .where("delivery_state", "in", ["failed", "uncertain"])
      .execute();

    const business = await this.db
      .selectFrom("business_connection as c")
      .select("c.business_id")
      .where("c.id", "=", row.connection_id)
      .executeTakeFirst();

    await writePlatformAudit(this.db, {
      adminUserId: actor.userId,
      adminRole: actor.role,
      action: "outbox.retry",
      targetType: table,
      targetId: row.id,
      businessId: business?.business_id ?? null,
      reason,
      metadata: {
        platform: input.platform,
        previousState: row.delivery_state,
        attempts: row.attempts,
      },
      requestId: actor.requestId,
    });

    return {
      ok: true as const,
      outboxId: row.id,
      deliveryState: "pending" as const,
      retried: true,
    };
  }

  private async countFrom(
    table: "user" | "business" | "order" | "lead" | "booking",
  ) {
    const row = await this.db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<string>().as("c"))
      .executeTakeFirst();
    return asNumber(row?.c);
  }

  private async healthSnapshot() {
    const health: {
      web: "ok";
      database: "ok" | "unavailable";
      workers: Record<string, "ok" | "unavailable" | "disabled">;
      storageConfigured: boolean;
      aiConfigured: boolean;
    } = {
      web: "ok",
      database: "unavailable",
      workers: {
        telegram: "disabled",
        vk: "disabled",
        autopost: "disabled",
        booking_reminders: "disabled",
        background: "disabled",
        osint: "disabled",
      },
      storageConfigured:
        process.env.ATTACHMENT_STORAGE === "s3" &&
        Boolean(process.env.S3_BUCKET),
      aiConfigured: Boolean(process.env.AI_API_TOKEN),
    };

    try {
      await sql`select 1`.execute(this.db);
      health.database = "ok";

      const telegramEnabled =
        process.env.TELEGRAM_WEBHOOKS_ENABLED === "true";
      const vkEnabled = process.env.VK_WEBHOOKS_ENABLED === "true";
      const backgroundEnabled =
        process.env.BACKGROUND_WORKER_ENABLED === "true";
      const required = [
        ...(backgroundEnabled ? ["background", "osint"] : []),
        ...(telegramEnabled ? ["telegram"] : []),
        ...(vkEnabled ? ["vk"] : []),
      ];

      const active = await this.db
        .selectFrom("business_solution as s")
        .innerJoin("business as b", "b.id", "s.business_id")
        .select("s.solution_code")
        .where("b.archived_at", "is", null)
        .where("s.status", "in", ["active", "trial"])
        .where((eb) =>
          eb.or([
            eb("s.expires_at", "is", null),
            eb("s.expires_at", ">", new Date()),
          ]),
        )
        .execute();
      if (active.some((s) => s.solution_code === "booking"))
        required.push("booking_reminders");
      if (active.some((s) => s.solution_code === "autopost"))
        required.push("autopost");

      const beats = await this.db
        .selectFrom("worker_heartbeat")
        .selectAll()
        .execute();
      for (const name of [
        "background",
        "osint",
        "telegram",
        "vk",
        "autopost",
        "booking_reminders",
      ] as const) {
        health.workers[name] = required.includes(name)
          ? beats.some(
              (b) => b.name === name && +b.seen_at > Date.now() - 60_000,
            )
            ? "ok"
            : "unavailable"
          : "disabled";
      }
    } catch {
      health.database = "unavailable";
    }

    return health;
  }

  private async latestOutboxError(
    platform: ConnectionPlatform,
    businessId: string,
  ): Promise<string | null> {
    if (platform === "telegram") {
      const row = await this.db
        .selectFrom("telegram_outbox as o")
        .innerJoin(
          "business_connection as c",
          "c.id",
          "o.connection_id",
        )
        .select("o.last_error")
        .where("c.business_id", "=", businessId)
        .where("c.platform", "=", platform)
        .where("o.last_error", "is not", null)
        .orderBy("o.created_at", "desc")
        .limit(1)
        .executeTakeFirst();
      return row?.last_error ?? null;
    }
    const row = await this.db
      .selectFrom("vk_outbox as o")
      .innerJoin(
        "business_connection as c",
        "c.id",
        "o.connection_id",
      )
      .select("o.last_error")
      .where("c.business_id", "=", businessId)
      .where("c.platform", "=", platform)
      .where("o.last_error", "is not", null)
      .orderBy("o.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.last_error ?? null;
  }

  private applyUserSearch<Q extends AnyQuery>(query: Q, q?: string): Q {
    if (!q?.trim()) return query;
    const trimmed = q.trim();
    const escaped = escapeIlike(trimmed);
    return query.where((eb: {
      or: (v: unknown[]) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (col: any, op: any, val: any): unknown;
    }) =>
      eb.or([
        ...(looksLikeUserPublicId(trimmed)
          ? [
              eb("u.public_id", "=", trimmed),
              eb("u.public_id", "like", trimmed + "%"),
            ]
          : []),
        sql<boolean>`u.name ilike ${"%" + escaped + "%"} escape '\\'`,
        sql<boolean>`u.username ilike ${"%" + escaped + "%"} escape '\\'`,
        sql<boolean>`u.email ilike ${"%" + escaped + "%"} escape '\\'`,
      ]),
    ) as Q;
  }

  private applyBusinessFilters<Q extends AnyQuery>(
    query: Q,
    input: {
      q?: string;
      industry?: string;
      status?: "active" | "archived" | "suspended";
      telegram?: ConnectionStatus | "any";
      vk?: ConnectionStatus | "any";
      solution?: string;
    },
  ): Q {
    let q: Q = query;
    if (input.q?.trim()) {
      const trimmed = input.q.trim();
      const escaped = escapeIlike(trimmed);
      q = q.where((eb: {
        or: (v: unknown[]) => unknown;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (col: any, op: any, val: any): unknown;
      }) =>
        eb.or([
          ...(looksLikeBusinessPublicId(trimmed)
            ? [
                eb("b.public_id", "=", trimmed),
                eb("b.public_id", "like", trimmed + "%"),
              ]
            : []),
          sql<boolean>`b.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`owner.name ilike ${"%" + escaped + "%"} escape '\\'`,
          sql<boolean>`owner.username ilike ${"%" + escaped + "%"} escape '\\'`,
        ]),
      ) as Q;
    }
    if (input.industry?.trim()) {
      q = q.where("b.industry", "=", input.industry.trim()) as Q;
    }
    if (input.status === "archived") {
      q = q.where("b.archived_at", "is not", null) as Q;
    } else if (input.status === "suspended") {
      q = q.where("sus.entity_id", "is not", null) as Q;
    } else if (input.status === "active") {
      q = q
        .where("b.archived_at", "is", null)
        .where("sus.entity_id", "is", null) as Q;
    }
    if (
      input.telegram &&
      input.telegram !== "any" &&
      ["pending", "connected", "error", "disconnected"].includes(
        input.telegram,
      )
    ) {
      q = q.where("tg.status", "=", input.telegram) as Q;
    }
    if (
      input.vk &&
      input.vk !== "any" &&
      ["pending", "connected", "error", "disconnected"].includes(input.vk)
    ) {
      q = q.where("vk.status", "=", input.vk) as Q;
    }
    if (input.solution?.trim()) {
      const code =
        input.solution.trim() === "sales"
          ? "orders"
          : input.solution.trim();
      q = q.where((eb: {
        exists: (v: unknown) => unknown;
        selectFrom: (t: string) => {
          select: (c: string) => {
            whereRef: (a: string, op: string, b: string) => {
              where: (fn: (eb2: {
                or: (v: unknown[]) => unknown;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (col: any, op: any, val: any): unknown;
              }) => unknown) => unknown;
            };
          };
        };
      }) =>
        eb.exists(
          eb
            .selectFrom("business_solution as sol")
            .select("sol.business_id")
            .whereRef("sol.business_id", "=", "b.id")
            .where((eb2) =>
              eb2.or([
                eb2("sol.solution_code", "=", code),
                ...(code === "orders"
                  ? [eb2("sol.solution_code", "=", "sales")]
                  : []),
              ]),
            ),
        ),
      ) as Q;
    }
    return q;
  }

  private async resolveEntity(
    entityType: SuspensionEntity,
    publicId: string,
  ) {
    if (entityType === "user") {
      const row = await this.db
        .selectFrom("user")
        .select(["id", "public_id as publicId"])
        .where("public_id", "=", publicId)
        .executeTakeFirst();
      if (!row)
        throw new AppError(404, "USER_NOT_FOUND", "Пользователь не найден.");
      return row;
    }
    const row = await this.db
      .selectFrom("business")
      .select(["id", "public_id as publicId"])
      .where("public_id", "=", publicId)
      .executeTakeFirst();
    if (!row)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
    return row;
  }

  private async assertNotLastSuperAdmin(userId: string) {
    const others = await this.db
      .selectFrom("platform_admin")
      .select((eb) => eb.fn.countAll<string>().as("c"))
      .where("role", "=", "SUPER_ADMIN")
      .where("status", "=", "active")
      .where("user_id", "!=", userId)
      .executeTakeFirst();
    if (asNumber(others?.c) < 1) {
      throw new AppError(
        409,
        "LAST_SUPER_ADMIN",
        "Нельзя отозвать последнего SUPER_ADMIN.",
      );
    }
  }
}
