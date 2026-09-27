import { requireUuid } from "../http/validation.ts";
import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { requireBusiness } from "../access/permissions.ts";
import { AppError } from "../http/errors.ts";
export type NotificationType =
  | "lead.created"
  | "message.received"
  | "booking.created"
  | "booking.cancelled"
  | "booking.rescheduled"
  | "booking.upcoming"
  | "order.created"
  | "post.failed"
  | "calendar.reminder"
  | "inventory.low_stock"
  | "invitation.received"
  | "setup.abandoned";

type Db = Kysely<Database> | Transaction<Database>;

export async function notify(
  tx: Transaction<Database>,
  businessId: string,
  type: NotificationType,
  eventKey: string,
  title: string,
  targetPath: string,
  recipientUserIds?: string[],
) {
  const row = await tx
    .insertInto("notification")
    .values({
      id: randomUUID(),
      business_id: businessId,
      type,
      event_key: eventKey,
      title,
      target_path: targetPath,
    })
    .onConflict((oc) => oc.columns(["business_id", "event_key"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!row) return;
  let members = await tx
    .selectFrom("business_member")
    .select("user_id")
    .where("business_id", "=", businessId)
    .where("status", "=", "active")
    .execute();
  if (recipientUserIds?.length)
    members = members.filter((m) => recipientUserIds.includes(m.user_id));
  for (const m of members) {
    const preference = await tx
      .selectFrom("notification_preference")
      .select("enabled")
      .where("business_id", "=", businessId)
      .where("user_id", "=", m.user_id)
      .where("type", "=", type)
      .executeTakeFirst();
    if (preference?.enabled === false) continue;
    await tx
      .insertInto("notification_recipient")
      .values({
        business_id: businessId,
        notification_id: row.id,
        user_id: m.user_id,
        read_at: null,
        resolved_at: null,
      })
      .execute();
  }
}

export async function resolveByEventKey(
  tx: Kysely<Database> | Transaction<Database>,
  businessId: string,
  eventKey: string,
) {
  const rows = await tx
    .selectFrom("notification")
    .select("id")
    .where("business_id", "=", businessId)
    .where("event_key", "=", eventKey)
    .execute();
  if (!rows.length) return;
  const now = new Date();
  await tx
    .updateTable("notification_recipient")
    .set({
      resolved_at: now,
      read_at: sql`coalesce(read_at, ${now})`,
    })
    .where("business_id", "=", businessId)
    .where(
      "notification_id",
      "in",
      rows.map((r) => r.id),
    )
    .where("resolved_at", "is", null)
    .execute();
}

export async function notifyUser(
  tx: Db,
  input: {
    userId: string;
    type: NotificationType;
    eventKey: string;
    title: string;
    body?: string | null;
    targetPath: string;
    businessId?: string | null;
    payload?: unknown;
  },
) {
  await tx
    .insertInto("user_notification")
    .values({
      id: randomUUID(),
      user_id: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      target_path: input.targetPath,
      event_key: input.eventKey,
      business_id: input.businessId ?? null,
      payload: input.payload ?? {},
      read_at: null,
      resolved_at: null,
    })
    .onConflict((oc) => oc.columns(["user_id", "event_key"]).doNothing())
    .execute();
}

export async function resolveUserByEventKey(
  tx: Db,
  userId: string,
  eventKey: string,
) {
  const now = new Date();
  await tx
    .updateTable("user_notification")
    .set({
      resolved_at: now,
      read_at: sql`coalesce(read_at, ${now})`,
    })
    .where("user_id", "=", userId)
    .where("event_key", "=", eventKey)
    .where("resolved_at", "is", null)
    .execute();
}

export class NotificationService {
  constructor(private db: Kysely<Database>) {}
  async list(userId: string, publicId: string) {
    const b = await requireBusiness(
      this.db,
      userId,
      publicId,
      "notifications.read",
    );
    return this.db
      .selectFrom("notification as n")
      .innerJoin("notification_recipient as r", "r.notification_id", "n.id")
      .select([
        "n.id",
        "n.type",
        "n.title",
        "n.target_path",
        "n.created_at",
        "r.read_at",
        "r.resolved_at",
      ])
      .where("n.business_id", "=", b.id)
      .where("r.user_id", "=", userId)
      .orderBy("n.created_at", "desc")
      .limit(100)
      .execute();
  }
  /** Unread actionable items: not read and not resolved. */
  async badgeCount(userId: string, publicId: string) {
    const b = await requireBusiness(
      this.db,
      userId,
      publicId,
      "notifications.read",
    );
    const row = await this.db
      .selectFrom("notification as n")
      .innerJoin("notification_recipient as r", "r.notification_id", "n.id")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .where("n.business_id", "=", b.id)
      .where("r.user_id", "=", userId)
      .where("r.read_at", "is", null)
      .where("r.resolved_at", "is", null)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }
  async read(userId: string, publicId: string, id: string) {
    requireUuid(id);
    const b = await requireBusiness(
      this.db,
      userId,
      publicId,
      "notifications.read",
    );
    await this.db
      .updateTable("notification_recipient")
      .set({ read_at: new Date() })
      .where("business_id", "=", b.id)
      .where("user_id", "=", userId)
      .where("notification_id", "=", id)
      .execute();
    return { ok: true };
  }
  async resolve(userId: string, publicId: string, id: string) {
    requireUuid(id);
    const b = await requireBusiness(
      this.db,
      userId,
      publicId,
      "notifications.read",
    );
    const now = new Date();
    await this.db
      .updateTable("notification_recipient")
      .set({
        resolved_at: now,
        read_at: sql`coalesce(read_at, ${now})`,
      })
      .where("business_id", "=", b.id)
      .where("user_id", "=", userId)
      .where("notification_id", "=", id)
      .where("resolved_at", "is", null)
      .execute();
    return { ok: true };
  }
  async markAllRead(userId: string, publicId: string) {
    const b = await requireBusiness(
      this.db,
      userId,
      publicId,
      "notifications.read",
    );
    await this.db
      .updateTable("notification_recipient")
      .set({ read_at: new Date() })
      .where("business_id", "=", b.id)
      .where("user_id", "=", userId)
      .where("read_at", "is", null)
      .execute();
    return { ok: true };
  }
  async listUserInbox(userId: string) {
    return this.db
      .selectFrom("user_notification")
      .select([
        "id",
        "type",
        "title",
        "body",
        "target_path",
        "event_key",
        "business_id",
        "payload",
        "read_at",
        "resolved_at",
        "created_at",
      ])
      .where("user_id", "=", userId)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
  }
  async readUserNotification(userId: string, id: string) {
    requireUuid(id);
    const changed = await this.db
      .updateTable("user_notification")
      .set({ read_at: new Date() })
      .where("user_id", "=", userId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (!changed || Number(changed.numUpdatedRows) !== 1) {
      const exists = await this.db
        .selectFrom("user_notification")
        .select("id")
        .where("user_id", "=", userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!exists)
        throw new AppError(
          404,
          "NOTIFICATION_NOT_FOUND",
          "Уведомление не найдено.",
        );
    }
    return { ok: true };
  }

  async markAllUserNotificationsRead(userId: string) {
    await this.db
      .updateTable("user_notification")
      .set({ read_at: new Date() })
      .where("user_id", "=", userId)
      .where("read_at", "is", null)
      .execute();
    return { ok: true };
  }

  async resolveUserNotification(userId: string, id: string) {
    requireUuid(id);
    const now = new Date();
    const changed = await this.db
      .updateTable("user_notification")
      .set({
        resolved_at: now,
        read_at: sql`coalesce(read_at, ${now})`,
      })
      .where("user_id", "=", userId)
      .where("id", "=", id)
      .where("resolved_at", "is", null)
      .executeTakeFirst();
    if (!changed || Number(changed.numUpdatedRows) !== 1) {
      const exists = await this.db
        .selectFrom("user_notification")
        .select("id")
        .where("user_id", "=", userId)
        .where("id", "=", id)
        .executeTakeFirst();
      if (!exists)
        throw new AppError(
          404,
          "NOTIFICATION_NOT_FOUND",
          "Уведомление не найдено.",
        );
    }
    return { ok: true };
  }
}
