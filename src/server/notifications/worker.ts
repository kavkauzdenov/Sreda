import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { hasVerifiedStaffIdentity } from "./staff-destination.ts";
import { loadLeadSetupV2 } from "../leads/setup.ts";

async function queuePlatform(
  db: Kysely<Database>,
  origin: string,
  platform: "telegram" | "vk",
) {
  const next =
    platform === "telegram"
      ? await db
          .selectFrom("notification_recipient as r")
          .innerJoin("notification_binding as n", (j) =>
            j
              .onRef("n.business_id", "=", "r.business_id")
              .onRef("n.user_id", "=", "r.user_id")
              .on("n.platform", "=", "telegram"),
          )
          .innerJoin("notification as e", "e.id", "r.notification_id")
          .select(["r.business_id", "r.user_id", "r.notification_id"])
          .where("r.telegram_queued", "=", false)
          .where("n.chat_id", "is not", null)
          .where("e.created_at", ">=", new Date(Date.now() - 86400000))
          .orderBy("e.created_at")
          .executeTakeFirst()
      : await db
          .selectFrom("notification_recipient as r")
          .innerJoin("notification_binding as n", (j) =>
            j
              .onRef("n.business_id", "=", "r.business_id")
              .onRef("n.user_id", "=", "r.user_id")
              .on("n.platform", "=", "vk"),
          )
          .innerJoin("notification as e", "e.id", "r.notification_id")
          .select(["r.business_id", "r.user_id", "r.notification_id"])
          .where("r.vk_queued", "=", false)
          .where("n.chat_id", "is not", null)
          .where("e.created_at", ">=", new Date(Date.now() - 86400000))
          .orderBy("e.created_at")
          .executeTakeFirst();
  if (!next) return false;
  return db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", next.business_id)
      .forUpdate()
      .execute();
    const r = await tx
      .selectFrom("notification_recipient")
      .select(["telegram_queued", "vk_queued"])
      .where("notification_id", "=", next.notification_id)
      .where("user_id", "=", next.user_id)
      .forUpdate()
      .executeTakeFirst();
    if (!r) return false;
    if (platform === "telegram" ? r.telegram_queued : r.vk_queued) return false;
    const n = await tx
      .selectFrom("notification_binding")
      .selectAll()
      .where("business_id", "=", next.business_id)
      .where("user_id", "=", next.user_id)
      .where("platform", "=", platform)
      .executeTakeFirst();
    if (!n?.chat_id) return false;
    const business = await tx
      .selectFrom("business")
      .select(["name", "public_name"])
      .where("id", "=", next.business_id)
      .executeTakeFirstOrThrow();
    const event = await tx
      .selectFrom("notification")
      .selectAll()
      .where("id", "=", next.notification_id)
      .executeTakeFirstOrThrow();
    const valid = await notificationValid(
      tx,
      next.notification_id,
      next.user_id,
      n.connection_id,
      n.chat_id,
      platform,
    );
    const message =
      (business.public_name || business.name) +
      "\n" +
      event.title +
      "\n" +
      new URL(event.target_path, origin).href;
    if (valid) {
      if (platform === "telegram") {
        await tx
          .insertInto("telegram_outbox")
          .values({
            connection_id: n.connection_id,
            chat_id: n.chat_id,
            message,
            notification_id: event.id,
            notification_user_id: n.user_id,
            delivered_at: null,
            last_error: null,
          })
          .onConflict((oc) =>
            oc.columns(["notification_id", "notification_user_id"]).doNothing(),
          )
          .execute();
      } else {
        await tx
          .insertInto("vk_outbox")
          .values({
            connection_id: n.connection_id,
            peer_id: n.chat_id,
            message,
            notification_id: event.id,
            notification_user_id: n.user_id,
            delivered_at: null,
            last_error: null,
          })
          .onConflict((oc) =>
            oc.columns(["notification_id", "notification_user_id"]).doNothing(),
          )
          .execute();
      }
    }
    await tx
      .updateTable("notification_recipient")
      .set(
        platform === "telegram"
          ? { telegram_queued: true }
          : { vk_queued: true },
      )
      .where("notification_id", "=", event.id)
      .where("user_id", "=", n.user_id)
      .execute();
    return true;
  });
}

export async function queueNotification(db: Kysely<Database>, origin: string) {
  if (await queuePlatform(db, origin, "telegram")) return true;
  return queuePlatform(db, origin, "vk");
}

export async function notificationValid(
  tx: Transaction<Database>,
  id: string,
  user: string,
  connection: string,
  chat: string,
  platform: "telegram" | "vk" = "telegram",
) {
  const event = await tx
    .selectFrom("notification")
    .select(["business_id", "type", "target_path"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!event) return false;

  // Leads V2 can disable only staff Telegram delivery; in-app notifications
  // remain a core invariant. Do not queue a Telegram staff message when the
  // business has not enabled it in the Leads setup.
  if (platform === "telegram" && event.type === "lead.created") {
    const { setup } = await loadLeadSetupV2(tx, event.business_id);
    if (!setup.notifications.staffTelegram) return false;
  }
  const member = await tx
    .selectFrom("business_member")
    .select("status")
    .where("business_id", "=", event.business_id)
    .where("user_id", "=", user)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!member) return false;
  const binding = await tx
    .selectFrom("notification_binding")
    .select("chat_id")
    .where("business_id", "=", event.business_id)
    .where("user_id", "=", user)
    .where("platform", "=", platform)
    .where("connection_id", "=", connection)
    .where("chat_id", "=", chat)
    .executeTakeFirst();
  if (!binding?.chat_id) return false;
  const pref = await tx
    .selectFrom("notification_preference")
    .select("enabled")
    .where("business_id", "=", event.business_id)
    .where("user_id", "=", user)
    .where("type", "=", event.type)
    .executeTakeFirst();
  if (pref?.enabled === false) return false;

  // Destination must be a verified staff messenger identity for this member.
  // Customer interaction alone never authorizes operational notifications.
  if (
    !(await hasVerifiedStaffIdentity(tx, {
      userId: user,
      platform,
      chatId: chat,
    }))
  )
    return false;

  return true;
}
