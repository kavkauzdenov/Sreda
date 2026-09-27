import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import { SolutionService } from "../src/server/solutions/service.ts";
import { LeadService, createLead } from "../src/server/leads/service.ts";
import {
  NotificationService,
  notify,
} from "../src/server/notifications/service.ts";
import { InvitationService } from "../src/server/invitations/service.ts";
import { processBatch } from "../src/server/solutions/setup-draft-worker.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function createUser(name = "Owner") {
  const id = randomUUID();
  const row = await db
    .insertInto("user")
    .values({
      id,
      name,
      email: id + "@test.invalid",
      emailVerified: false,
      username: "u" + id.slice(0, 8),
    })
    .returning(["id", "public_id", "name"])
    .executeTakeFirstOrThrow();
  return row;
}

async function fixture(ownerName = "Owner") {
  const owner = await createUser(ownerName);
  const business = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Бизнес " + ownerName,
      timezone: "Europe/Moscow",
      business_type: "hybrid",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: business.id,
      user_id: owner.id,
      role: "owner",
      status: "active",
    })
    .execute();
  return {
    owner,
    business,
    solutions: new SolutionService(db),
    leads: new LeadService(db),
    notifications: new NotificationService(db),
    invitations: new InvitationService(db),
  };
}

test("activate only admin_messages → others available; inbox setup_required", async () => {
  const f = await fixture();
  await f.solutions.activate(f.owner.id, f.business.public_id, {
    code: "admin_messages",
    enabled: true,
  });
  const list = await f.solutions.list(f.owner.id, f.business.public_id);
  const byId = Object.fromEntries(list.map((i) => [i.solutionId, i]));
  assert.equal(byId.sol_admin_messages.status, "setup_required");
  assert.equal(byId.sol_admin_messages.entitlementStatus, "active");
  assert.equal(byId.sol_leads.status, "available");
  assert.equal(byId.sol_leads.entitlementStatus, "absent");
  assert.equal(byId.sol_orders.status, "available");
  assert.equal(byId.sol_booking.status, "available");
  assert.equal(byId.sol_autopost.status, "available");
  assert.ok(
    !list.some(
      (i) =>
        i.solutionId !== "sol_admin_messages" &&
        (i.status === "setup_required" ||
          i.status === "active" ||
          i.status === "paused"),
    ),
  );
});

test("disable solution → available + disabled entitlement; product data remains", async () => {
  const f = await fixture();
  await f.solutions.activate(f.owner.id, f.business.public_id, {
    code: "orders",
    enabled: true,
  });
  const productId = randomUUID();
  await db
    .insertInto("product")
    .values({
      id: productId,
      business_id: f.business.id,
      name: "Кофе",
      price: "250.00",
      currency: "RUB",
      active: true,
      position: 0,
      use_variants: false,
      track_inventory: false,
      availability: "in_stock",
    })
    .execute();
  await f.solutions.activate(f.owner.id, f.business.public_id, {
    code: "orders",
    enabled: false,
  });
  const orders = (await f.solutions.list(f.owner.id, f.business.public_id)).find(
    (i) => i.solutionId === "sol_orders",
  );
  assert.equal(orders?.status, "available");
  assert.equal(orders?.entitlementStatus, "disabled");
  assert.match(orders?.note ?? "", /Отключено/);
  const product = await db
    .selectFrom("product")
    .select("id")
    .where("id", "=", productId)
    .executeTakeFirst();
  assert.ok(product);
});

test("lead close resolves notification and clears badge", async () => {
  const f = await fixture();
  await f.solutions.activate(f.owner.id, f.business.public_id, {
    code: "leads",
    enabled: true,
  });
  const lead = await db.transaction().execute((tx) =>
    createLead(tx, f.business.id, {
      source: "telegram",
      name: "Клиент",
      phone: "+79991112233",
    }),
  );
  const before = await f.notifications.list(f.owner.id, f.business.public_id);
  const leadNote = before.find((n) => n.type === "lead.created");
  assert.ok(leadNote);
  assert.equal(leadNote.read_at, null);
  assert.equal(leadNote.resolved_at, null);
  assert.equal(
    await f.notifications.badgeCount(f.owner.id, f.business.public_id),
    1,
  );
  await f.leads.updateStatus(
    f.owner.id,
    f.business.public_id,
    lead.id,
    "closed",
  );
  const after = await f.notifications.list(f.owner.id, f.business.public_id);
  const resolved = after.find((n) => n.id === leadNote.id);
  assert.ok(resolved?.resolved_at);
  assert.equal(
    await f.notifications.badgeCount(f.owner.id, f.business.public_id),
    0,
  );
});

test("invitation create → user_notification; accept resolves; decline works", async () => {
  const ownerFix = await fixture("Inviter");
  const invitee = await createUser("Invitee");
  const created = await ownerFix.invitations.create(
    ownerFix.owner.id,
    ownerFix.business.public_id,
    invitee.public_id,
    "operator",
  );
  const inbox = await ownerFix.notifications.listUserInbox(invitee.id);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].type, "invitation.received");
  assert.equal(inbox[0].event_key, "invitation:" + created.id);
  assert.equal(inbox[0].resolved_at, null);

  await ownerFix.invitations.accept(invitee.id, created.id);
  const afterAccept = await ownerFix.notifications.listUserInbox(invitee.id);
  assert.ok(afterAccept[0].resolved_at);

  const owner2 = await fixture("Inviter2");
  const invitee2 = await createUser("Invitee2");
  const created2 = await owner2.invitations.create(
    owner2.owner.id,
    owner2.business.public_id,
    invitee2.public_id,
    "admin",
  );
  await owner2.invitations.decline(invitee2.id, created2.id);
  const declined = await db
    .selectFrom("business_invitation")
    .select("status")
    .where("id", "=", created2.id)
    .executeTakeFirstOrThrow();
  assert.equal(declined.status, "declined");
  const afterDecline = await owner2.notifications.listUserInbox(invitee2.id);
  assert.ok(afterDecline[0].resolved_at);
});

test("setup draft reminder once; no duplicate; cancel after expiry", async () => {
  const f = await fixture();
  await f.solutions.touchSetupDraft(f.business.id, "leads", { step: 1 });
  const idleAgo = new Date(Date.now() - 2 * 3600000);
  await db
    .updateTable("solution_setup_draft")
    .set({ last_activity_at: idleAgo })
    .where("business_id", "=", f.business.id)
    .where("solution_code", "=", "leads")
    .execute();

  const first = await processBatch(db, {
    reminderIdleMs: 3600000,
    cancelAfterMs: 3600000,
  });
  assert.equal(first.reminded, 1);
  assert.equal(first.cancelled, 0);

  const notes = await f.notifications.list(f.owner.id, f.business.public_id);
  const setupNotes = notes.filter((n) => n.type === "setup.abandoned");
  assert.equal(setupNotes.length, 1);

  const second = await processBatch(db, {
    reminderIdleMs: 3600000,
    cancelAfterMs: 3600000,
  });
  assert.equal(second.reminded, 0);

  const notes2 = await f.notifications.list(f.owner.id, f.business.public_id);
  assert.equal(notes2.filter((n) => n.type === "setup.abandoned").length, 1);

  await db
    .updateTable("solution_setup_draft")
    .set({ cancel_after: new Date(Date.now() - 1000) })
    .where("business_id", "=", f.business.id)
    .where("solution_code", "=", "leads")
    .execute();

  const third = await processBatch(db, {
    reminderIdleMs: 3600000,
    cancelAfterMs: 3600000,
  });
  assert.equal(third.cancelled, 1);

  const draft = await db
    .selectFrom("solution_setup_draft")
    .select("status")
    .where("business_id", "=", f.business.id)
    .where("solution_code", "=", "leads")
    .executeTakeFirstOrThrow();
  assert.equal(draft.status, "cancelled");

  const afterCancel = await f.notifications.list(
    f.owner.id,
    f.business.public_id,
  );
  assert.ok(
    afterCancel.find((n) => n.type === "setup.abandoned")?.resolved_at,
  );
});

test("tenant isolation: business A lead resolve does not touch B", async () => {
  const a = await fixture("A");
  const b = await fixture("B");
  await a.solutions.activate(a.owner.id, a.business.public_id, {
    code: "leads",
    enabled: true,
  });
  await b.solutions.activate(b.owner.id, b.business.public_id, {
    code: "leads",
    enabled: true,
  });
  const leadA = await db.transaction().execute((tx) =>
    createLead(tx, a.business.id, {
      source: "telegram",
      name: "A",
    }),
  );
  await db.transaction().execute((tx) =>
    createLead(tx, b.business.id, {
      source: "telegram",
      name: "B",
    }),
  );
  // Also plant a same event_key shape on B that must not resolve via A.
  await db.transaction().execute((tx) =>
    notify(
      tx,
      b.business.id,
      "lead.created",
      "lead:" + leadA.id,
      "Cross",
      "/leads",
    ),
  );

  await a.leads.updateStatus(
    a.owner.id,
    a.business.public_id,
    leadA.id,
    "processing",
  );
  await a.leads.updateStatus(
    a.owner.id,
    a.business.public_id,
    leadA.id,
    "completed",
  );

  const listA = await a.notifications.list(a.owner.id, a.business.public_id);
  const listB = await b.notifications.list(b.owner.id, b.business.public_id);
  assert.ok(listA.every((n) => n.resolved_at != null || n.type !== "lead.created"));
  const aLead = listA.find((n) => n.type === "lead.created");
  assert.ok(aLead?.resolved_at);
  const bUnresolved = listB.filter((n) => !n.resolved_at);
  assert.ok(bUnresolved.length >= 1);
  assert.ok(listB.some((n) => n.type === "lead.created" && !n.resolved_at));
});
