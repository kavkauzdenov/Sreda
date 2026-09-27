import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { LeadFormService } from "../src/server/leads/forms.ts";
import { LeadService } from "../src/server/leads/service.ts";
import { getLeadReadiness } from "../src/server/leads/readiness.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function addMember(businessId, role = "operator") {
  const uid = randomUUID();
  await db
    .insertInto("user")
    .values({
      id: uid,
      name: role === "owner" ? "Owner" : "Operator " + uid.slice(0, 4),
      email: uid + "@test.invalid",
      emailVerified: false,
      username: "u" + uid.replace(/-/g, "").slice(0, 16),
    })
    .execute();
  await db
    .insertInto("business_member")
    .values({
      business_id: businessId,
      user_id: uid,
      role,
      status: "active",
    })
    .execute();
  return uid;
}

async function fixture() {
  const owner = await (async () => {
    const uid = randomUUID();
    await db
      .insertInto("user")
      .values({
        id: uid,
        name: "Owner Alpha",
        email: uid + "@test.invalid",
        emailVerified: false,
        username: "u" + uid.replace(/-/g, "").slice(0, 16),
      })
      .execute();
    return uid;
  })();
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Leads Service Biz",
      public_name: "Leads Service Biz",
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
  await db
    .insertInto("business_solution")
    .values({
      business_id: b.id,
      solution_code: "leads",
      status: "active",
    })
    .execute();
  return {
    owner,
    b,
    forms: new LeadFormService(db),
    leads: new LeadService(db),
  };
}

async function seedNameField(businessId) {
  await db
    .insertInto("lead_form_field")
    .values({
      id: randomUUID(),
      business_id: businessId,
      field_key: "name",
      label: "Имя",
      field_type: "name",
      required: true,
      placeholder: "Имя",
      options: [],
      position: 0,
      active: true,
      updated_at: new Date(),
    })
    .execute();
}

test("LeadFormService: cannot delete name field", async () => {
  const f = await fixture();
  await seedNameField(f.b.id);
  const listed = await f.forms.list(f.owner, f.b.public_id, true);
  const name = listed.find((row) => row.fieldKey === "name");
  assert.ok(name);
  await assert.rejects(
    () => f.forms.remove(f.owner, f.b.public_id, name.id),
    (err) =>
      err &&
      typeof err === "object" &&
      err.status === 400 &&
      /Имя/i.test(String(err.message)),
  );
});

test("LeadFormService: cannot change name type", async () => {
  const f = await fixture();
  await seedNameField(f.b.id);
  const listed = await f.forms.list(f.owner, f.b.public_id, true);
  const name = listed.find((row) => row.fieldKey === "name");
  const updated = await f.forms.save(
    f.owner,
    f.b.public_id,
    {
      fieldKey: "name",
      label: "Ваше имя",
      fieldType: "text",
      required: false,
      placeholder: "",
      position: 0,
    },
    name.id,
  );
  assert.equal(updated.fieldType, "name");
  assert.equal(updated.required, true);
  assert.equal(updated.active, true);
  assert.equal(updated.label, "Ваше имя");
});

test("LeadFormService: reorder fields", async () => {
  const f = await fixture();
  await seedNameField(f.b.id);
  const phone = await f.forms.save(f.owner, f.b.public_id, {
    fieldKey: "phone",
    label: "Телефон",
    fieldType: "phone",
    required: true,
    position: 1,
  });
  const msg = await f.forms.save(f.owner, f.b.public_id, {
    fieldKey: "message",
    label: "Сообщение",
    fieldType: "message",
    required: false,
    position: 2,
  });
  const before = await f.forms.list(f.owner, f.b.public_id, true);
  const name = before.find((row) => row.fieldKey === "name");
  const reordered = await f.forms.reorder(f.owner, f.b.public_id, [
    msg.id,
    name.id,
    phone.id,
  ]);
  assert.deepEqual(
    reordered.map((r) => r.fieldKey),
    ["message", "name", "phone"],
  );
});

test("LeadFormService: applyPreset needsConfirm when fields exist; replace=true works", async () => {
  const f = await fixture();
  await seedNameField(f.b.id);
  const blocked = await f.forms.applyPreset(
    f.owner,
    f.b.public_id,
    "universal",
    false,
  );
  assert.equal(blocked.applied, false);
  assert.equal(blocked.needsConfirm, true);
  assert.equal(blocked.reason, "fields_exist");

  const replaced = await f.forms.applyPreset(
    f.owner,
    f.b.public_id,
    "universal",
    true,
  );
  assert.equal(replaced.applied, true);
  assert.equal(replaced.presetId, "universal");
  assert.ok(replaced.count >= 3);
  const active = await f.forms.list(f.owner, f.b.public_id, true);
  assert.ok(active.some((r) => r.fieldKey === "name"));
  assert.ok(active.some((r) => r.fieldKey === "phone"));
});

test("getLeadReadiness checks FORM_FIELDS and CHANNELS", async () => {
  const f = await fixture();
  let readiness = await getLeadReadiness(db, f.b.id);
  assert.equal(
    readiness.checks.find((c) => c.code === "FORM_FIELDS")?.ok,
    false,
  );
  assert.equal(
    readiness.checks.find((c) => c.code === "CHANNELS")?.ok,
    false,
  );

  await seedNameField(f.b.id);
  await db
    .insertInto("lead_setup")
    .values({
      business_id: f.b.id,
      draft: JSON.stringify({
        version: 2,
        buttonLabel: "Оставить заявку",
        greeting: "Привет",
        finalMessage: "Спасибо",
        channels: ["telegram"],
        defaultStatus: "new",
        processing: {
          autoAssign: false,
          duplicateDetection: true,
          firstResponseSlaMinutes: null,
        },
        notifications: { inApp: true, staffTelegram: false, email: false },
        setupStep: 6,
        completed: true,
      }),
      revision: 1,
    })
    .execute();

  readiness = await getLeadReadiness(db, f.b.id);
  assert.equal(
    readiness.checks.find((c) => c.code === "FORM_FIELDS")?.ok,
    true,
  );
  assert.equal(
    readiness.checks.find((c) => c.code === "CHANNELS")?.ok,
    true,
  );
  // Telegram channel selected but not connected → CHANNEL_TELEGRAM fails.
  assert.equal(
    readiness.checks.find((c) => c.code === "CHANNEL_TELEGRAM")?.ok,
    false,
  );
});

test("LeadService.updateStatus concurrent take: exactly one wins with 409", async () => {
  const f = await fixture();
  const userB = await addMember(f.b.id, "operator");
  const lead = await f.leads.create(f.owner, f.b.public_id, {
    source: "telegram",
    name: "Гонка",
    phone: "+79991110000",
  });

  const leadsA = new LeadService(db);
  const leadsB = new LeadService(db);
  const results = await Promise.allSettled([
    leadsA.updateStatus(f.owner, f.b.public_id, lead.id, "processing"),
    leadsB.updateStatus(userB, f.b.public_id, lead.id, "processing"),
  ]);

  const fulfilled = results.filter((r) => r.status === "fulfilled");
  const rejected = results.filter((r) => r.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const err = rejected[0].reason;
  assert.ok(err && typeof err === "object");
  assert.equal(err.status, 409);
  assert.equal(err.code, "LEAD_ASSIGNED");

  const row = await db
    .selectFrom("lead")
    .selectAll()
    .where("id", "=", lead.id)
    .executeTakeFirstOrThrow();
  assert.equal(row.status, "processing");
  assert.ok(row.processing_by);
  assert.ok([f.owner, userB].includes(row.processing_by));
});

test("LeadService.list returns processingName via join", async () => {
  const f = await fixture();
  const userB = await addMember(f.b.id, "operator");

  const leadA = await f.leads.create(f.owner, f.b.public_id, {
    source: "telegram",
    name: "Клиент А",
    phone: "+79991110001",
  });
  const leadB = await f.leads.create(f.owner, f.b.public_id, {
    source: "vk",
    name: "Клиент Б",
    phone: "+79991110002",
  });
  await f.leads.updateStatus(f.owner, f.b.public_id, leadA.id, "processing");
  await new LeadService(db).updateStatus(
    userB,
    f.b.public_id,
    leadB.id,
    "processing",
  );

  const listed = await f.leads.list(f.owner, f.b.public_id);
  const a = listed.find((l) => l.id === leadA.id);
  const b = listed.find((l) => l.id === leadB.id);
  assert.ok(a);
  assert.ok(b);
  assert.ok(a.processingName);
  assert.ok(b.processingName);
  assert.equal(a.processingName, "Owner Alpha");
  assert.match(b.processingName, /^Operator /);
});

test("LeadService status transition invalid throws", async () => {
  const f = await fixture();
  const lead = await f.leads.create(f.owner, f.b.public_id, {
    source: "telegram",
    name: "Статус",
    phone: "+79991110003",
  });
  await assert.rejects(
    () => f.leads.updateStatus(f.owner, f.b.public_id, lead.id, "completed"),
    (err) =>
      err &&
      typeof err === "object" &&
      err.status === 400 &&
      err.code === "INVALID_STATUS_TRANSITION",
  );
});
