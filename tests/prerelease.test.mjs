import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { routeBot } from "../src/server/bot/router.ts";
import { CommunicationService } from "../src/server/communications/service.ts";
import { InvitationService } from "../src/server/invitations/service.ts";
import { LeadService } from "../src/server/leads/service.ts";
import { encryptSecret } from "../src/server/connections/crypto.ts";
import { TelegramService } from "../src/server/telegram/service.ts";
import { VKService } from "../src/server/vk/service.ts";
const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
const secret = "prerelease-fixture-".repeat(4);
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());
async function user() {
  return db
    .insertInto("user")
    .values({
      id: randomUUID(),
      name: "Сотрудник",
      email: randomUUID() + "@test.invalid",
      emailVerified: false,
      username: "u" + randomUUID(),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}
async function fixture() {
  const owner = await user(),
    operator = await user();
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Бизнес " + randomUUID(),
      timezone: "Europe/Kaliningrad",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values([
      { business_id: b.id, user_id: owner.id, role: "owner", status: "active" },
      {
        business_id: b.id,
        user_id: operator.id,
        role: "operator",
        status: "active",
      },
    ])
    .execute();
  const connections = {};
  for (const platform of ["telegram", "vk"]) {
    const id = randomUUID();
    connections[platform] = id;
    await db
      .insertInto("business_connection")
      .values({
        id,
        business_id: b.id,
        platform,
        external_account_id: randomUUID(),
        display_name: "Fixture",
        status: "connected",
      })
      .execute();
    await db
      .insertInto("connection_secret")
      .values({
        connection_id: id,
        encrypted_token: encryptSecret("fixture-token", secret),
        key_version: 1,
      })
      .execute();
    await db
      .insertInto(platform + "_runtime")
      .values({ connection_id: id, generation: randomUUID(), status: "ready" })
      .execute();
  }
  await db
    .insertInto("business_solution")
    .values(
      ["leads", "booking", "admin_messages", "autopost"].map(
        (solution_code) => ({
          business_id: b.id,
          solution_code,
          status: "active",
          starts_at: new Date(),
          expires_at: null,
        }),
      ),
    )
    .execute();
  await db
    .insertInto("booking_service")
    .values({
      id: randomUUID(),
      business_id: b.id,
      name: "Консультация",
      duration_minutes: 60,
      active: true,
    })
    .execute();
  await db
    .insertInto("lead_setup")
    .values({
      business_id: b.id,
      draft: JSON.stringify({
        version: 1,
        step: 3,
        channels: ["telegram", "vk"],
        fields: ["name"],
      }),
    })
    .execute();
  return { b, owner, operator, connections };
}
test("universal menu switches between unfinished booking, messages and leads in both platforms", async () => {
  const f = await fixture();
  let event = 0;
  for (const platform of ["telegram", "vk"]) {
    const send = (text) =>
      db.transaction().execute((tx) =>
        routeBot(tx, {
          businessId: f.b.id,
          connectionId: f.connections[platform],
          platform,
          userId: "111",
          eventId: String(++event),
          text,
        }),
      );
    const mode = async () =>
      (
        await db
          .selectFrom(platform + "_dialog")
          .select("mode")
          .where("connection_id", "=", f.connections[platform])
          .where("chat_id", "=", "111")
          .executeTakeFirstOrThrow()
      ).mode;
    await send("/start");
    await send("Онлайн-запись");
    assert.equal(await mode(), "booking:service");
    await send("Связаться с администрацией");
    assert.equal(await mode(), "messages");
    await send("Вопрос администратору");
    await send("Оставить заявку");
    assert.equal(await mode(), "leads");
    await send("Анна");
    await send("Отправить");
    assert.equal(await mode(), "menu");
    const lead = await db
      .selectFrom("lead")
      .selectAll()
      .where("business_id", "=", f.b.id)
      .where("source", "=", platform)
      .executeTakeFirstOrThrow();
    const conv = await db
      .selectFrom("communication_conversation")
      .selectAll()
      .where("business_id", "=", f.b.id)
      .where("platform", "=", platform)
      .executeTakeFirstOrThrow();
    assert.equal(lead.client_id, conv.client_id);
    assert.equal(
      (
        await db
          .selectFrom("communication_message")
          .select("id")
          .where("conversation_id", "=", conv.id)
          .execute()
      ).length,
      1,
    );
  }
});
test("same external message number in different chats and platforms cannot break committed deliveries", async () => {
  const f = await fixture(),
    svc = new CommunicationService(db);
  // Menu replies above are unrelated; drain them before creating the replies below.
  await db
    .updateTable("telegram_outbox")
    .set({ delivery_state: "sent", delivered_at: new Date() })
    .execute();
  await db
    .updateTable("vk_outbox")
    .set({ delivery_state: "sent", delivered_at: new Date() })
    .execute();
  const ids = [];
  for (const platform of ["telegram", "vk"])
    for (const externalUserId of ["201", "202"]) {
      const c = await svc.recordInbound({
        businessId: f.b.id,
        platform,
        externalUserId,
        text: "Вопрос",
        externalMessageId: randomUUID(),
      });
      const m = await svc.sendMessage(
        f.owner.id,
        f.b.public_id,
        c.conversationId,
        {
          text: "Ответ",
          requestKey: randomUUID(),
        },
      );
      ids.push(m.id);
    }
  const tg = new TelegramService(
    db,
    secret,
    "https://staging.invalid",
    true,
    async () => Response.json({ ok: true, result: { message_id: 7 } }),
  );
  const vk = new VKService(db, secret, true, undefined, async () =>
    Response.json({ response: 7 }),
  );
  for (let n = 0; n < 2; n++) {
    assert.equal(await tg.deliverOne(), true);
    assert.equal(await vk.deliverOne(), true);
  }
  const messages = await db
    .selectFrom("communication_message")
    .selectAll()
    .where("id", "in", ids)
    .execute();
  assert.ok(messages.every((m) => m.delivery_status === "sent"));
  assert.equal(new Set(messages.map((m) => m.external_message_id)).size, 4);
});
test("revoked employee loses binding and live assignments, other business and history stay intact", async () => {
  const f = await fixture(),
    other = await fixture(),
    svc = new CommunicationService(db);
  await db
    .insertInto("business_member")
    .values({
      business_id: other.b.id,
      user_id: f.operator.id,
      role: "operator",
      status: "active",
    })
    .execute();
  const conversations = [];
  for (const b of [f.b, other.b]) {
    const c = await svc.recordInbound({
      businessId: b.id,
      platform: "telegram",
      externalUserId: "303",
      text: "Помогите",
      externalMessageId: randomUUID(),
    });
    await svc.updateStatus(f.operator.id, b.public_id, c.conversationId, {
      status: "assigned",
    });
    conversations.push(c.conversationId);
  }
  const leads = new LeadService(db);
  const lead = await leads.create(f.owner.id, f.b.public_id, {
    source: "telegram",
    name: "Клиент",
  });
  await leads.updateStatus(f.operator.id, f.b.public_id, lead.id, "processing");
  await db
    .insertInto("notification_binding")
    .values({
      business_id: f.b.id,
      user_id: f.operator.id,
      connection_id: f.connections.telegram,
      chat_id: "303",
    })
    .execute();
  await new InvitationService(db).revokeMember(
    f.owner.id,
    f.b.public_id,
    f.operator.public_id,
  );
  const first = await db
    .selectFrom("communication_conversation")
    .selectAll()
    .where("id", "=", conversations[0])
    .executeTakeFirstOrThrow();
  assert.equal(first.status, "open");
  assert.equal(first.assigned_member_user_id, null);
  assert.equal(
    (
      await db
        .selectFrom("communication_conversation")
        .selectAll()
        .where("id", "=", conversations[1])
        .executeTakeFirstOrThrow()
    ).assigned_member_user_id,
    f.operator.id,
  );
  assert.equal(
    (
      await db
        .selectFrom("lead")
        .selectAll()
        .where("id", "=", lead.id)
        .executeTakeFirstOrThrow()
    ).status,
    "new",
  );
  assert.equal(
    (
      await db
        .selectFrom("notification_binding")
        .selectAll()
        .where("business_id", "=", f.b.id)
        .execute()
    ).length,
    0,
  );
  await assert.rejects(
    svc.listMessages(f.operator.id, f.b.public_id, conversations[0]),
    (e) => e.status === 404,
  );
  await svc.updateStatus(f.owner.id, f.b.public_id, conversations[0], {
    status: "assigned",
  });
  assert.equal(
    (await svc.listMessages(f.owner.id, f.b.public_id, conversations[0]))
      .length,
    1,
  );
});

test("closing a conversation is atomic and channel failure does not leave CRM open", async () => {
  const f = await fixture();
  const svc = new CommunicationService(db);
  const inbound = await svc.recordInbound({
    businessId: f.b.id,
    platform: "telegram",
    externalUserId: "close-" + randomUUID(),
    text: "Закройте диалог",
    externalMessageId: randomUUID(),
  });

  const queued = await svc.closeConversation(
    f.owner.id,
    f.b.public_id,
    inbound.conversationId,
    {
      message: "Спасибо, диалог закрыт.",
      requestKey: randomUUID(),
    },
  );
  assert.equal(queued.status, "closed");
  assert.equal(queued.notification, "queued");

  let row = await db
    .selectFrom("communication_conversation")
    .select(["status", "closed_at"])
    .where("id", "=", inbound.conversationId)
    .executeTakeFirstOrThrow();
  assert.equal(row.status, "closed");
  assert.ok(row.closed_at);

  const closingMessage = await db
    .selectFrom("communication_message")
    .select(["delivery_status", "text"])
    .where("id", "=", queued.messageId)
    .executeTakeFirstOrThrow();
  assert.equal(closingMessage.delivery_status, "queued");
  assert.equal(closingMessage.text, "Спасибо, диалог закрыт.");

  // A new inbound message reopens the closed conversation.
  await svc.recordInbound({
    businessId: f.b.id,
    platform: "telegram",
    externalUserId: (
      await db
        .selectFrom("communication_conversation")
        .select("external_user_id")
        .where("id", "=", inbound.conversationId)
        .executeTakeFirstOrThrow()
    ).external_user_id,
    text: "Ещё вопрос",
    externalMessageId: randomUUID(),
  });
  row = await db
    .selectFrom("communication_conversation")
    .select(["status", "closed_at"])
    .where("id", "=", inbound.conversationId)
    .executeTakeFirstOrThrow();
  assert.equal(row.status, "open");
  assert.equal(row.closed_at, null);

  await db
    .updateTable("telegram_runtime")
    .set({ status: "error" })
    .where("connection_id", "=", f.connections.telegram)
    .execute();

  const failed = await svc.closeConversation(
    f.owner.id,
    f.b.public_id,
    inbound.conversationId,
    {
      message: "Диалог закрыт.",
      requestKey: randomUUID(),
    },
  );
  assert.equal(failed.status, "closed");
  assert.equal(failed.notification, "failed");

  row = await db
    .selectFrom("communication_conversation")
    .select(["status", "closed_at"])
    .where("id", "=", inbound.conversationId)
    .executeTakeFirstOrThrow();
  assert.equal(row.status, "closed");
  assert.ok(row.closed_at);

  const failedMessage = await db
    .selectFrom("communication_message")
    .select("delivery_status")
    .where("id", "=", failed.messageId)
    .executeTakeFirstOrThrow();
  assert.equal(failedMessage.delivery_status, "failed");
});

test("only the assigned employee can change a lead and reopening releases it", async () => {
  const f = await fixture(),
    other = await user(),
    leads = new LeadService(db);
  await db
    .insertInto("business_member")
    .values({
      business_id: f.b.id,
      user_id: other.id,
      role: "operator",
      status: "active",
    })
    .execute();
  const lead = await leads.create(f.owner.id, f.b.public_id, {
    source: "telegram",
    name: "Клиент",
  });
  await leads.updateStatus(f.operator.id, f.b.public_id, lead.id, "processing");
  await assert.rejects(
    leads.updateStatus(other.id, f.b.public_id, lead.id, "closed"),
    (error) => error.code === "LEAD_ASSIGNED",
  );
  const reopened = await leads.updateStatus(
    f.operator.id,
    f.b.public_id,
    lead.id,
    "new",
  );
  assert.equal(reopened.processingBy, null);
  assert.equal(reopened.processingAt, undefined);
  const claimed = await leads.updateStatus(
    other.id,
    f.b.public_id,
    lead.id,
    "processing",
  );
  assert.equal(claimed.processingBy, other.id);
});

test("long replies and full lead review are split without losing Unicode text or duplicating logical messages", async () => {
  const { messageChunks } = await import("../src/server/outbox/text.ts");
  const text = "А".repeat(3999) + "😀" + "Б".repeat(4500);
  const chunks = messageChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(
    chunks.every((x) => x.length <= 4000 && !/[\uD800-\uDBFF]$/.test(x)),
  );
  const f = await fixture(),
    svc = new CommunicationService(db);
  const c = await svc.recordInbound({
    businessId: f.b.id,
    platform: "telegram",
    externalUserId: "999",
    text: "Вопрос",
    externalMessageId: randomUUID(),
  });
  const key = randomUUID();
  const reply = await svc.sendMessage(
    f.owner.id,
    f.b.public_id,
    c.conversationId,
    { text, requestKey: key },
  );
  assert.equal(
    (
      await svc.sendMessage(f.owner.id, f.b.public_id, c.conversationId, {
        text,
        requestKey: key,
      })
    ).id,
    reply.id,
  );
  const jobs = await db
    .selectFrom("telegram_outbox")
    .selectAll()
    .where("communication_message_id", "=", reply.id)
    .orderBy("id")
    .execute();
  assert.equal(jobs.map((j) => j.message).join(""), text);
  assert.equal(jobs.length, chunks.length);
  const fields = ["name", "phone", "email", "message", "service", "comment"];
  await db
    .updateTable("lead_setup")
    .set({
      draft: JSON.stringify({
        version: 1,
        step: 3,
        channels: ["telegram"],
        fields,
        fieldOptions: Object.fromEntries(
          fields.map((f) => [
            f,
            { label: "Вопрос " + f, required: true },
          ]),
        ),
      }),
    })
    .where("business_id", "=", f.b.id)
    .execute();
  // Project fields into lead_form_field (V2 SoT) for the bot flow.
  const { syncLeadFormFields } = await import(
    "../src/server/leads/forms.ts"
  );
  const { parseLeadSetupDraft } = await import(
    "../src/lib/leadSetupDraft.ts"
  );
  await syncLeadFormFields(
    db,
    f.b.id,
    parseLeadSetupDraft(
      JSON.stringify({
        version: 1,
        step: 3,
        channels: ["telegram"],
        fields,
        fieldOptions: Object.fromEntries(
          fields.map((f) => [
            f,
            { label: "Вопрос " + f, required: true },
          ]),
        ),
      }),
    ),
  );
  let event = 1;
  const send = (text) =>
    db.transaction().execute((tx) =>
      routeBot(tx, {
        businessId: f.b.id,
        connectionId: f.connections.telegram,
        platform: "telegram",
        userId: "888",
        eventId: String(event++),
        text,
      }),
    );
  await send("Оставить заявку");
  await send("Анна");
  // Form SoT order: name first, then remaining LEAD_FIELDS order.
  for (const answer of [
    "mail@example.com",
    "Т".repeat(900),
    "+79991234567",
    "У".repeat(900),
    "К".repeat(900),
  ])
    await send(answer);
  const out = await db
    .selectFrom("telegram_outbox")
    .selectAll()
    .where("connection_id", "=", f.connections.telegram)
    .where("chat_id", "=", "888")
    .orderBy("id")
    .execute();
  assert.ok(out.every((x) => x.message.length <= 4000));
  assert.ok(out.at(-1).buttons.includes("Отправить"));
  await send("Отправить");
  const client = await db
    .selectFrom("client")
    .selectAll()
    .where("business_id", "=", f.b.id)
    .where("email", "=", "mail@example.com")
    .executeTakeFirst();
  assert.ok(client);
});

test("invalid entity IDs return validation errors and long Unicode replies pass HTTP parsing", async () => {
  const { ClientService } = await import("../src/server/clients/service.ts");
  const { NotificationService } = await import(
    "../src/server/notifications/service.ts"
  );
  const { createApplication } = await import(
    "../src/server/http/application.ts"
  );
  const f = await fixture(),
    svc = new CommunicationService(db);
  const invalid = (e) => e.code === "INVALID_ID" && e.status === 400;
  await assert.rejects(
    svc.listMessages(f.owner.id, f.b.public_id, "invalid"),
    invalid,
  );
  await assert.rejects(
    svc.sendMessage(f.owner.id, f.b.public_id, "invalid", { text: "test" }),
    invalid,
  );
  await assert.rejects(
    svc.updateStatus(f.owner.id, f.b.public_id, "invalid", {
      status: "closed",
    }),
    invalid,
  );
  const clients = new ClientService(db);
  await assert.rejects(
    clients.save(f.owner.id, f.b.public_id, { name: "Имя" }, "invalid"),
    invalid,
  );
  await assert.rejects(
    clients.note(f.owner.id, f.b.public_id, "invalid", "Заметка"),
    invalid,
  );
  await assert.rejects(
    new NotificationService(db).read(f.owner.id, f.b.public_id, "invalid"),
    invalid,
  );
  const c = await svc.recordInbound({
    businessId: f.b.id,
    platform: "telegram",
    externalUserId: "907",
    text: "Вопрос",
    externalMessageId: randomUUID(),
  });
  const app = createApplication({
    auth: { api: { getSession: async () => ({ user: f.owner }) } },
    workspaces: {},
    communications: svc,
    origin: "https://staging.invalid",
  });
  const response = await app.conversations(
    new Request("https://staging.invalid/api", {
      method: "POST",
      headers: {
        origin: "https://staging.invalid",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        text: "Я".repeat(10000),
        requestKey: randomUUID(),
      }),
    }),
    f.b.public_id,
    c.conversationId,
  );
  assert.equal(response.status, 202, JSON.stringify(await response.json()));
});

test("revocation while storage upload is in flight rejects metadata and removes stored object", async () => {
  const { AttachmentService } = await import(
    "../src/server/attachments/service.ts"
  );
  const f = await fixture();
  let removed = false;
  const storage = {
    put: async () => {
      await db
        .updateTable("business_member")
        .set({ status: "revoked" })
        .where("business_id", "=", f.b.id)
        .where("user_id", "=", f.operator.id)
        .execute();
    },
    remove: async () => {
      removed = true;
    },
  };
  const svc = new AttachmentService(db, secret, storage);
  await assert.rejects(
    svc.upload(
      f.operator.id,
      f.b.public_id,
      "test.txt",
      "text/plain",
      "document",
      Buffer.from("test"),
    ),
    (e) => e.code === "BUSINESS_NOT_FOUND",
  );
  assert.equal(removed, true);
  assert.equal(
    (
      await db
        .selectFrom("attachment")
        .select("id")
        .where("business_id", "=", f.b.id)
        .execute()
    ).length,
    0,
  );
});
