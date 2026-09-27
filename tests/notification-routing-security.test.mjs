import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { CommunicationService } from "../src/server/communications/service.ts";
import { notify } from "../src/server/notifications/service.ts";
import {
  NotificationSettings,
  bindNotification,
} from "../src/server/notifications/settings.ts";
import {
  notificationValid,
  queueNotification,
} from "../src/server/notifications/worker.ts";
import { routeBot } from "../src/server/bot/router.ts";
import { newLeadSetupV2 } from "../src/lib/leadSetupV2.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function makeUser(name = "User") {
  const id = randomUUID();
  await db
    .insertInto("user")
    .values({
      id,
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.replace(/-/g, "").slice(0, 16),
    })
    .execute();
  return id;
}

async function makeBusiness(ownerId, name = "Biz") {
  const row = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name,
      public_name: name,
      timezone: "Europe/Moscow",
    })
    .returning(["id", "public_id"])
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: row.id,
      user_id: ownerId,
      role: "owner",
      status: "active",
    })
    .execute();
  await db
    .insertInto("business_solution")
    .values({
      business_id: row.id,
      solution_code: "admin_messages",
      status: "active",
      starts_at: new Date(),
    })
    .execute();
  return row;
}

async function connectTelegram(businessId) {
  const connection = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id: connection,
      business_id: businessId,
      platform: "telegram",
      status: "connected",
      external_account_id: "bot-" + connection.slice(0, 8),
      display_name: "bot",
    })
    .execute();
  await db
    .insertInto("connection_secret")
    .values({
      connection_id: connection,
      encrypted_token: "x",
      key_version: 1,
    })
    .execute();
  await db
    .insertInto("telegram_runtime")
    .values({
      connection_id: connection,
      generation: randomUUID(),
      status: "ready",
    })
    .execute();
  return connection;
}

async function connectVk(businessId) {
  const connection = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id: connection,
      business_id: businessId,
      platform: "vk",
      status: "connected",
      external_account_id: "55",
      display_name: "vk",
    })
    .execute();
  await db
    .insertInto("connection_secret")
    .values({
      connection_id: connection,
      encrypted_token: "x",
      key_version: 1,
    })
    .execute();
  await db
    .insertInto("vk_runtime")
    .values({
      connection_id: connection,
      generation: randomUUID(),
      status: "ready",
    })
    .execute();
  return connection;
}

async function staffBindSimple(businessId, ownerId, connectionId, chatId, platform = "telegram") {
  const settings = new NotificationSettings(db);
  const business = await db
    .selectFrom("business")
    .select("public_id")
    .where("id", "=", businessId)
    .executeTakeFirstOrThrow();
  const issued = await settings.save(ownerId, business.public_id, {
    action: "connect",
    platform,
  });
  const code =
    platform === "telegram"
      ? issued.command.replace(/^\/start\s+notify_/, "")
      : issued.command.replace(/^notify_/, "");
  assert.equal(
    await db
      .transaction()
      .execute((tx) =>
        bindNotification(tx, businessId, connectionId, chatId, code),
      ),
    true,
  );
}

async function drainNotifications() {
  for (let i = 0; i < 20; i++) {
    if (!(await queueNotification(db, "https://sreda.test"))) break;
  }
}

function outboxFor(connectionId, chatId) {
  return db
    .selectFrom("telegram_outbox")
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("chat_id", "=", chatId)
    .execute();
}

test("CASE1 customer admin_messages never receives business notification", async () => {
  const owner = await makeUser("Owner");
  const business = await makeBusiness(owner, "Shop A");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10001");

  const customerChat = "19999";
  const communications = new CommunicationService(db);
  await communications.recordInbound({
    businessId: business.id,
    platform: "telegram",
    connectionId: connection,
    externalUserId: customerChat,
    text: "Тест 321",
    externalMessageId: randomUUID(),
  });

  await drainNotifications();

  const customerJobs = await outboxFor(connection, customerChat);
  assert.equal(customerJobs.length, 0);

  const ownerJobs = await outboxFor(connection, "10001");
  assert.equal(ownerJobs.length, 1);
  assert.match(ownerJobs[0].message, /Новое обращение/);
  assert.match(ownerJobs[0].message, /\/messages\?id=/);
  assert.equal(ownerJobs[0].notification_id != null, true);
});

test("CASE2 verified owner binding receives business notification", async () => {
  const owner = await makeUser("Owner2");
  const business = await makeBusiness(owner, "Shop B");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10002");

  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "message.received",
      "evt-" + randomUUID(),
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  await drainNotifications();
  const jobs = await outboxFor(connection, "10002");
  assert.equal(jobs.length, 1);
  assert.equal(
    await db.transaction().execute((tx) =>
      notificationValid(
        tx,
        jobs[0].notification_id,
        owner,
        connection,
        "10002",
        "telegram",
      ),
    ),
    true,
  );
});

test("Leads V2 staff Telegram switch controls lead.created delivery", async () => {
  const owner = await makeUser("LeadNotifyOwner");
  const business = await makeBusiness(owner, "Lead Notify");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10102");

  const disabled = {
    ...newLeadSetupV2(),
    notifications: {
      ...newLeadSetupV2().notifications,
      staffTelegram: false,
    },
  };
  await db
    .insertInto("lead_setup")
    .values({
      business_id: business.id,
      draft: JSON.stringify(disabled),
      revision: 1,
    })
    .execute();

  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "lead.created",
      "lead-off-" + randomUUID(),
      "Новая заявка",
      "/leads",
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connection, "10102")).length, 0);

  const enabled = {
    ...disabled,
    notifications: {
      ...disabled.notifications,
      staffTelegram: true,
    },
  };
  await db
    .updateTable("lead_setup")
    .set({
      draft: JSON.stringify(enabled),
      revision: 2,
      updated_at: new Date(),
    })
    .where("business_id", "=", business.id)
    .execute();

  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "lead.created",
      "lead-on-" + randomUUID(),
      "Новая заявка",
      "/leads",
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connection, "10102")).length, 1);
});

test("CASE3 interaction alone does not authorize staff notifications", async () => {
  const owner = await makeUser("Owner3");
  const business = await makeBusiness(owner, "Shop C");
  const connection = await connectTelegram(business.id);
  // Polluted legacy binding: member destination points at a customer chat,
  // but no verified provider_identity claim exists for that member.
  await db
    .insertInto("notification_binding")
    .values({
      business_id: business.id,
      user_id: owner,
      platform: "telegram",
      connection_id: connection,
      chat_id: "18888",
      code_hash: null,
      expires_at: null,
    })
    .execute();

  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "message.received",
      "pollute-" + randomUUID(),
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connection, "18888")).length, 0);
  const note = await db
    .selectFrom("notification")
    .select("id")
    .where("business_id", "=", business.id)
    .orderBy("created_at", "desc")
    .executeTakeFirstOrThrow();
  assert.equal(
    await db.transaction().execute((tx) =>
      notificationValid(
        tx,
        note.id,
        owner,
        connection,
        "18888",
        "telegram",
      ),
    ),
    false,
  );
});

test("CASE4 employee with preference disabled does not get push", async () => {
  const owner = await makeUser("Owner4");
  const employee = await makeUser("Emp");
  const business = await makeBusiness(owner, "Shop D");
  await db
    .insertInto("business_member")
    .values({
      business_id: business.id,
      user_id: employee,
      role: "operator",
      status: "active",
    })
    .execute();
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, employee, connection, "10004");
  await new NotificationSettings(db).save(owner, business.public_id, {
    action: "preferences",
    user_id: employee,
    type: "message.received",
    enabled: false,
  });
  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "message.received",
      "pref-" + randomUUID(),
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connection, "10004")).length, 0);
});

test("CASE5 revoked member stops receiving notifications", async () => {
  const owner = await makeUser("Owner5");
  const business = await makeBusiness(owner, "Shop E");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10005");
  const eventKey = "rev-" + randomUUID();
  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "message.received",
      eventKey,
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  const note = await db
    .selectFrom("notification")
    .select("id")
    .where("business_id", "=", business.id)
    .where("event_key", "=", eventKey)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("business_member")
    .set({ status: "revoked" })
    .where("business_id", "=", business.id)
    .where("user_id", "=", owner)
    .execute();
  assert.equal(
    await db.transaction().execute((tx) =>
      notificationValid(
        tx,
        note.id,
        owner,
        connection,
        "10005",
        "telegram",
      ),
    ),
    false,
  );
});

test("CASE6 revoked provider binding stops notifications", async () => {
  const owner = await makeUser("Owner6");
  const business = await makeBusiness(owner, "Shop F");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10006");
  await db
    .updateTable("provider_identity")
    .set({ revoked_at: new Date() })
    .where("user_id", "=", owner)
    .where("external_user_id", "=", "10006")
    .execute();
  const eventKey = "unbind-" + randomUUID();
  await db.transaction().execute((tx) =>
    notify(
      tx,
      business.id,
      "message.received",
      eventKey,
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connection, "10006")).length, 0);
});

test("CASE7/8 cross-business isolation for staff notifications", async () => {
  const ownerA = await makeUser("OwnerA");
  const ownerB = await makeUser("OwnerB");
  const a = await makeBusiness(ownerA, "A");
  const b = await makeBusiness(ownerB, "B");
  const connA = await connectTelegram(a.id);
  const connB = await connectTelegram(b.id);
  await staffBindSimple(a.id, ownerA, connA, "10007");
  await staffBindSimple(b.id, ownerB, connB, "10008");

  await db.transaction().execute((tx) =>
    notify(
      tx,
      a.id,
      "message.received",
      "cross-" + randomUUID(),
      "Новое обращение",
      "/messages?id=" + randomUUID(),
    ),
  );
  await drainNotifications();
  assert.equal((await outboxFor(connA, "10007")).length, 1);
  assert.equal((await outboxFor(connB, "10008")).length, 0);
  assert.equal((await outboxFor(connA, "10008")).length, 0);
});

test("CASE9 VK customer never receives staff notification", async () => {
  const owner = await makeUser("OwnerVK");
  const business = await makeBusiness(owner, "VK Shop");
  const connection = await connectVk(business.id);
  await staffBindSimple(business.id, owner, connection, "20001", "vk");

  const communications = new CommunicationService(db);
  await communications.recordInbound({
    businessId: business.id,
    platform: "vk",
    connectionId: connection,
    externalUserId: "29999",
    text: "Тест VK",
    externalMessageId: randomUUID(),
  });
  await drainNotifications();

  const customer = await db
    .selectFrom("vk_outbox")
    .selectAll()
    .where("connection_id", "=", connection)
    .where("peer_id", "=", "29999")
    .execute();
  assert.equal(customer.length, 0);
  const ownerJobs = await db
    .selectFrom("vk_outbox")
    .selectAll()
    .where("connection_id", "=", connection)
    .where("peer_id", "=", "20001")
    .execute();
  assert.equal(ownerJobs.length, 1);
  assert.match(ownerJobs[0].message, /Новое обращение/);
});

test("CASE10 inbox link is denied without business membership", async () => {
  const owner = await makeUser("Owner10");
  const stranger = await makeUser("Stranger");
  const business = await makeBusiness(owner, "Locked");
  const connection = await connectTelegram(business.id);
  const communications = new CommunicationService(db);
  const inbound = await communications.recordInbound({
    businessId: business.id,
    platform: "telegram",
    connectionId: connection,
    externalUserId: "10010",
    text: "hi",
    externalMessageId: randomUUID(),
  });
  await assert.rejects(
    communications.listMessages(
      stranger,
      business.public_id,
      inbound.conversationId,
    ),
    (err) => err.status === 404 || err.status === 403,
  );
});

test("bindNotification rejects messenger identity owned by another user", async () => {
  const owner = await makeUser("OwnerBind");
  const other = await makeUser("OtherBind");
  const business = await makeBusiness(owner, "Bind Shop");
  const connection = await connectTelegram(business.id);
  await db
    .insertInto("provider_identity")
    .values({
      id: randomUUID(),
      user_id: other,
      platform: "telegram",
      external_user_id: "17777",
      display_name: null,
      username: null,
      revoked_at: null,
    })
    .execute();
  const settings = new NotificationSettings(db);
  const issued = await settings.save(owner, business.public_id, {
    action: "connect",
    platform: "telegram",
  });
  const code = issued.command.replace(/^\/start\s+notify_/, "");
  assert.equal(
    await db
      .transaction()
      .execute((tx) =>
        bindNotification(tx, business.id, connection, "17777", code),
      ),
    false,
  );
});

test("bot customer path only queues client ACK, never staff notice to sender", async () => {
  const owner = await makeUser("OwnerBot");
  const business = await makeBusiness(owner, "Bot Shop");
  const connection = await connectTelegram(business.id);
  await staffBindSimple(business.id, owner, connection, "10011");

  const customer = "10012";
  await db.transaction().execute(async (tx) => {
    await routeBot(tx, {
      businessId: business.id,
      connectionId: connection,
      platform: "telegram",
      userId: customer,
      text: "Связаться с администратором",
      eventId: "900001",
    });
  });
  await db.transaction().execute(async (tx) => {
    await routeBot(tx, {
      businessId: business.id,
      connectionId: connection,
      platform: "telegram",
      userId: customer,
      text: "Тест 321",
      eventId: "900002",
    });
  });

  const customerRows = await outboxFor(connection, customer);
  assert.ok(customerRows.length >= 1);
  for (const row of customerRows) {
    assert.equal(row.notification_id, null);
    assert.doesNotMatch(row.message || "", /Новое обращение/);
    assert.doesNotMatch(row.message || "", /\/messages\?/);
  }

  await drainNotifications();
  const staff = await outboxFor(connection, "10011");
  assert.ok(staff.some((row) => row.notification_id && /Новое обращение/.test(row.message || "")));
  assert.equal((await outboxFor(connection, customer)).filter((r) => r.notification_id).length, 0);
});
