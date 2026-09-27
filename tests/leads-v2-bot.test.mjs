import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { routeBot } from "../src/server/bot/router.ts";
import { createLead, LeadService } from "../src/server/leads/service.ts";
import { ensureLeadSetupV2 } from "../src/server/leads/setup.ts";
import { getAvailableCustomerActions } from "../src/server/solutions/customer-actions.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function makeBusiness(name = "Leads Biz") {
  const owner = randomUUID();
  await db
    .insertInto("user")
    .values({
      id: owner,
      name: "Owner",
      email: owner + "@test.invalid",
      emailVerified: false,
      username: "u" + owner.replace(/-/g, "").slice(0, 16),
    })
    .execute();
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name,
      public_name: name,
      timezone: "Europe/Moscow",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: b.id,
      user_id: owner,
      role: "owner",
      status: "active",
    })
    .execute();
  return { b, owner };
}

async function connect(businessId, platform) {
  const connection = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id: connection,
      business_id: businessId,
      platform,
      status: "connected",
      external_account_id: randomUUID(),
      display_name: platform + "-bot",
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
    .insertInto(platform + "_runtime")
    .values({
      connection_id: connection,
      generation: randomUUID(),
      status: "ready",
    })
    .execute();
  return connection;
}

async function activate(businessId, codes) {
  for (const solution_code of codes) {
    await db
      .insertInto("business_solution")
      .values({
        business_id: businessId,
        solution_code,
        status: "active",
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "solution_code"]).doUpdateSet({
          status: "active",
          expires_at: null,
        }),
      )
      .execute();
  }
}

async function seedLeadSetupV2(businessId, channels = ["telegram", "vk"]) {
  await db
    .insertInto("lead_setup")
    .values({
      business_id: businessId,
      draft: JSON.stringify({
        version: 2,
        buttonLabel: "Оставить заявку",
        greeting: "Здравствуйте! Ответьте на несколько вопросов.",
        finalMessage: "Спасибо! Заявка принята.",
        channels,
        defaultStatus: "new",
        processing: {
          autoAssign: false,
          duplicateDetection: true,
          firstResponseSlaMinutes: null,
        },
        notifications: {
          inApp: true,
          staffTelegram: false,
          email: false,
        },
        setupStep: 6,
        completed: true,
      }),
      revision: 1,
    })
    .onConflict((oc) =>
      oc.column("business_id").doUpdateSet({
        draft: JSON.stringify({
          version: 2,
          buttonLabel: "Оставить заявку",
          greeting: "Здравствуйте! Ответьте на несколько вопросов.",
          finalMessage: "Спасибо! Заявка принята.",
          channels,
          defaultStatus: "new",
          processing: {
            autoAssign: false,
            duplicateDetection: true,
            firstResponseSlaMinutes: null,
          },
          notifications: {
            inApp: true,
            staffTelegram: false,
            email: false,
          },
          setupStep: 6,
          completed: true,
        }),
        revision: 1,
        updated_at: new Date(),
      }),
    )
    .execute();
}

async function seedFormFields(businessId) {
  const now = new Date();
  const fields = [
    {
      id: randomUUID(),
      business_id: businessId,
      field_key: "name",
      label: "Имя",
      field_type: "name",
      required: true,
      placeholder: "Как к вам обращаться",
      options: [],
      position: 0,
      active: true,
      updated_at: now,
    },
    {
      id: randomUUID(),
      business_id: businessId,
      field_key: "phone",
      label: "Телефон",
      field_type: "phone",
      required: true,
      placeholder: "+79991234567",
      options: [],
      position: 1,
      active: true,
      updated_at: now,
    },
    {
      id: randomUUID(),
      business_id: businessId,
      field_key: "interest",
      label: "Что интересует",
      field_type: "select",
      required: true,
      placeholder: "",
      options: ["Консультация", "Ремонт", "Другое"],
      position: 2,
      active: true,
      updated_at: now,
    },
    {
      id: randomUUID(),
      business_id: businessId,
      field_key: "details",
      label: "Подробности",
      field_type: "textarea",
      required: true,
      placeholder: "Опишите запрос",
      options: [],
      position: 3,
      active: true,
      updated_at: now,
    },
    {
      id: randomUUID(),
      business_id: businessId,
      field_key: "photo",
      label: "Фото",
      field_type: "attachment",
      required: false,
      placeholder: "",
      options: [],
      position: 4,
      active: true,
      updated_at: now,
    },
  ];
  for (const row of fields) {
    await db
      .insertInto("lead_form_field")
      .values(row)
      .onConflict((oc) =>
        oc.columns(["business_id", "field_key"]).doUpdateSet({
          label: row.label,
          field_type: row.field_type,
          required: row.required,
          placeholder: row.placeholder,
          options: row.options,
          position: row.position,
          active: true,
          updated_at: now,
        }),
      )
      .execute();
  }
  return fields;
}

async function lastOutbox(connectionId, platform) {
  const table = platform === "telegram" ? "telegram_outbox" : "vk_outbox";
  return db
    .selectFrom(table)
    .selectAll()
    .where("connection_id", "=", connectionId)
    .orderBy("created_at", "desc")
    .executeTakeFirst();
}

function parseButtons(raw) {
  if (!raw) return [];
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

let eventSeq = 1;
function nextEventId() {
  return String(eventSeq++);
}

function send(businessId, connectionId, platform, userId, text) {
  return db.transaction().execute((tx) =>
    routeBot(tx, {
      businessId,
      connectionId,
      platform,
      userId,
      eventId: nextEventId(),
      text,
    }),
  );
}

async function fixture(platforms = ["telegram"]) {
  const { b, owner } = await makeBusiness();
  await activate(b.id, ["leads"]);
  await seedLeadSetupV2(b.id, platforms);
  await seedFormFields(b.id);
  const connections = {};
  for (const platform of platforms) {
    connections[platform] = await connect(b.id, platform);
  }
  return { b, owner, connections };
}

test("A) Telegram full flow creates lead with structured answers", async () => {
  const { b, connections } = await fixture(["telegram"]);
  const conn = connections.telegram;
  const userId = "900001";

  await send(b.id, conn, "telegram", userId, "/start");
  let out = await lastOutbox(conn, "telegram");
  assert.ok(parseButtons(out.buttons).includes("Оставить заявку"));

  await send(b.id, conn, "telegram", userId, "Оставить заявку");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Здравствуйте/);
  assert.match(out.message, /Имя/);

  await send(b.id, conn, "telegram", userId, "Анна");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Телефон/);

  await send(b.id, conn, "telegram", userId, "+79991234567");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Что интересует/);
  assert.ok(parseButtons(out.buttons).includes("Консультация"));

  await send(b.id, conn, "telegram", userId, "Консультация");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Подробности/);

  await send(b.id, conn, "telegram", userId, "Нужна консультация по услуге");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Фото|Пришлите фото|пропустить/i);

  await send(b.id, conn, "telegram", userId, "Пропустить");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Проверьте заявку/);
  assert.ok(parseButtons(out.buttons).includes("Отправить"));

  await send(b.id, conn, "telegram", userId, "Отправить");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Спасибо/);

  const lead = await db
    .selectFrom("lead")
    .selectAll()
    .where("business_id", "=", b.id)
    .executeTakeFirstOrThrow();
  assert.equal(lead.status, "new");
  assert.equal(lead.name, "Анна");
  assert.equal(lead.phone, "+79991234567");
  assert.ok(lead.client_id);

  const answers =
    typeof lead.answers === "string" ? JSON.parse(lead.answers) : lead.answers;
  assert.equal(answers.name, "Анна");
  assert.equal(answers.phone, "+79991234567");
  assert.equal(answers.interest, "Консультация");
  assert.equal(answers.details, "Нужна консультация по услуге");
  assert.equal(answers.photo, null);

  const history = await db
    .selectFrom("lead_status_history")
    .selectAll()
    .where("lead_id", "=", lead.id)
    .execute();
  assert.ok(history.some((h) => h.to_status === "new" && h.from_status == null));
});

test("B) VK same key flow via peer_id / vk_outbox", async () => {
  const { b, connections } = await fixture(["vk"]);
  const conn = connections.vk;
  const userId = "900042";

  await send(b.id, conn, "vk", userId, "/start");
  await send(b.id, conn, "vk", userId, "Оставить заявку");
  await send(b.id, conn, "vk", userId, "Игорь");
  await send(b.id, conn, "vk", userId, "+79997654321");
  await send(b.id, conn, "vk", userId, "Ремонт");
  await send(b.id, conn, "vk", userId, "Сломался кран");
  await send(b.id, conn, "vk", userId, "Пропустить");

  const review = await lastOutbox(conn, "vk");
  assert.match(review.message, /Проверьте заявку/);
  assert.ok(parseButtons(review.buttons).includes("Отправить"));

  await send(b.id, conn, "vk", userId, "Отправить");
  const done = await lastOutbox(conn, "vk");
  assert.match(done.message, /Спасибо/);

  const outbox = await db
    .selectFrom("vk_outbox")
    .selectAll()
    .where("connection_id", "=", conn)
    .where("peer_id", "=", userId)
    .execute();
  assert.ok(outbox.length > 0);

  const lead = await db
    .selectFrom("lead")
    .selectAll()
    .where("business_id", "=", b.id)
    .where("source", "=", "vk")
    .executeTakeFirstOrThrow();
  assert.equal(lead.name, "Игорь");
  const answers =
    typeof lead.answers === "string" ? JSON.parse(lead.answers) : lead.answers;
  assert.equal(answers.interest, "Ремонт");
});

test("C) Type validation: phone, select, required/optional skip", async () => {
  const { b, connections } = await fixture(["telegram"]);
  const conn = connections.telegram;
  const userId = "900101";

  await send(b.id, conn, "telegram", userId, "/start");
  await send(b.id, conn, "telegram", userId, "Оставить заявку");
  await send(b.id, conn, "telegram", userId, "Мария");

  await send(b.id, conn, "telegram", userId, "not-a-phone");
  let out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /телефон/i);

  await send(b.id, conn, "telegram", userId, "+79991112233");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Что интересует/);

  await send(b.id, conn, "telegram", userId, "Неизвестный вариант");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /вариант/i);

  await send(b.id, conn, "telegram", userId, "/skip");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /обязательн/i);

  await send(b.id, conn, "telegram", userId, "Другое");
  await send(b.id, conn, "telegram", userId, "Текст заявки");

  await send(b.id, conn, "telegram", userId, "Пропустить");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Проверьте заявку/);
  assert.match(out.message, /Фото: —/);
});

test("D) Mid-flow config change keeps old snapshot; new start uses new form", async () => {
  const { b, connections } = await fixture(["telegram"]);
  const conn = connections.telegram;
  const userA = "900201";
  const userB = "900202";

  await send(b.id, conn, "telegram", userA, "/start");
  await send(b.id, conn, "telegram", userA, "Оставить заявку");
  await send(b.id, conn, "telegram", userA, "Старый Клиент");

  await db
    .insertInto("lead_form_field")
    .values({
      id: randomUUID(),
      business_id: b.id,
      field_key: "extra_note",
      label: "Доп. заметка",
      field_type: "text",
      required: true,
      placeholder: "",
      options: [],
      position: 5,
      active: true,
      updated_at: new Date(),
    })
    .execute();

  // Old dialog continues without the new field.
  await send(b.id, conn, "telegram", userA, "+79990001122");
  await send(b.id, conn, "telegram", userA, "Консультация");
  await send(b.id, conn, "telegram", userA, "Старый снимок формы");
  await send(b.id, conn, "telegram", userA, "Пропустить");
  let out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Проверьте заявку/);
  assert.ok(!out.message.includes("Доп. заметка"));
  await send(b.id, conn, "telegram", userA, "Отправить");

  const oldLead = await db
    .selectFrom("lead")
    .selectAll()
    .where("business_id", "=", b.id)
    .where("name", "=", "Старый Клиент")
    .executeTakeFirstOrThrow();
  const oldAnswers =
    typeof oldLead.answers === "string"
      ? JSON.parse(oldLead.answers)
      : oldLead.answers;
  assert.equal(oldAnswers.extra_note, undefined);

  // Fresh start uses the updated form including extra_note.
  await send(b.id, conn, "telegram", userB, "/start");
  await send(b.id, conn, "telegram", userB, "Оставить заявку");
  await send(b.id, conn, "telegram", userB, "Новый Клиент");
  await send(b.id, conn, "telegram", userB, "+79990003344");
  await send(b.id, conn, "telegram", userB, "Ремонт");
  await send(b.id, conn, "telegram", userB, "Новая форма");
  out = await lastOutbox(conn, "telegram");
  // After details comes optional attachment OR the new required field depending on order.
  // extra_note is position 5 after photo (4) — photo is optional first.
  if (/Фото|Пришлите фото/i.test(out.message)) {
    await send(b.id, conn, "telegram", userB, "Пропустить");
    out = await lastOutbox(conn, "telegram");
  }
  assert.match(out.message, /Доп\. заметка/);
  await send(b.id, conn, "telegram", userB, "Дополнительно");
  out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /Проверьте заявку/);
  assert.match(out.message, /Доп\. заметка/);
});

test("E) Solution disable mid-flow blocks lead creation", async () => {
  const { b, connections } = await fixture(["telegram"]);
  const conn = connections.telegram;
  const userId = "900301";

  await send(b.id, conn, "telegram", userId, "/start");
  await send(b.id, conn, "telegram", userId, "Оставить заявку");
  await send(b.id, conn, "telegram", userId, "Клиент");

  await db
    .updateTable("business_solution")
    .set({ status: "disabled" })
    .where("business_id", "=", b.id)
    .where("solution_code", "=", "leads")
    .execute();

  await send(b.id, conn, "telegram", userId, "+79995556677");
  const out = await lastOutbox(conn, "telegram");
  assert.match(out.message, /недоступен|временно/i);

  const leads = await db
    .selectFrom("lead")
    .selectAll()
    .where("business_id", "=", b.id)
    .execute();
  assert.equal(leads.length, 0);
});

test("F) Idempotency: same externalEventId does not duplicate", async () => {
  const { b } = await fixture(["telegram"]);
  const externalEventId = "evt-idempotent-1";
  const payload = {
    source: "telegram",
    name: "Идемпотент",
    phone: "+79990000001",
    message: "раз",
    externalEventId,
    answers: { name: "Идемпотент", phone: "+79990000001" },
  };

  const first = await db.transaction().execute((tx) =>
    createLead(tx, b.id, payload),
  );
  const second = await db.transaction().execute((tx) =>
    createLead(tx, b.id, payload),
  );
  assert.equal(first.id, second.id);

  const rows = await db
    .selectFrom("lead")
    .selectAll()
    .where("business_id", "=", b.id)
    .where("external_event_id", "=", externalEventId)
    .execute();
  assert.equal(rows.length, 1);
});

test("G) Legacy v1 fixture still works with ensureLeadSetupV2 and LeadService", async () => {
  const { b, owner } = await makeBusiness("Legacy V1");
  await activate(b.id, ["leads"]);
  await connect(b.id, "telegram");

  await db
    .insertInto("lead_setup")
    .values({
      business_id: b.id,
      draft: JSON.stringify({
        version: 1,
        step: 3,
        title: "Оставить заявку",
        channels: ["telegram"],
        fields: ["name", "phone"],
        greeting: "Привет из v1",
        finalMessage: "Спасибо из v1",
      }),
      revision: 1,
    })
    .execute();

  const ensured = await ensureLeadSetupV2(db, b.id);
  assert.equal(ensured.setup.version, 2);
  assert.equal(ensured.setup.completed, true);
  assert.ok(ensured.setup.channels.includes("telegram"));

  const available = await getAvailableCustomerActions(db, b.id, "telegram");
  assert.ok(available.has("leads"));

  const leadId = randomUUID();
  await db
    .insertInto("lead")
    .values({
      id: leadId,
      business_id: b.id,
      source: "telegram",
      name: "Легаси",
      phone: "+79998887766",
      message: "старое сообщение",
      status: "new",
      answers: JSON.stringify({
        name: "Легаси",
        phone: "+79998887766",
        service: "Старая услуга",
      }),
    })
    .execute();

  const leads = new LeadService(db);
  const got = await leads.get(owner, b.public_id, leadId);
  assert.equal(got.name, "Легаси");
  const answers =
    typeof got.answers === "string" ? JSON.parse(got.answers) : got.answers;
  assert.equal(answers.service, "Старая услуга");
  assert.ok(got.answerFields.some((f) => f.key === "service"));
});
