import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Kysely, PGliteDialect } from "kysely";
import { PGlite } from "@electric-sql/pglite";
import { migrate } from "../src/server/db/migrate.ts";
import {
  allIndustryPresets,
  industryPreset,
  businessTypeFromModel,
  recommendedSolutionsForIndustry,
} from "../src/lib/industryPresets.ts";
import {
  resolveCapabilityDependencies,
  searchSettingsIndex,
} from "../src/lib/capabilities.ts";
import { IndustrySetupService } from "../src/server/workspaces/industry.ts";
import { recommendedSolutionCodes } from "../src/lib/businessTypeRecommendations.ts";

const db = new Kysely({ dialect: new PGliteDialect({ pglite: new PGlite() }) });
before(() => migrate(db, new URL("../migrations", import.meta.url).pathname));
after(() => db.destroy());

async function fixture() {
  const uid = randomUUID();
  await db
    .insertInto("user")
    .values({
      id: uid,
      name: "Owner",
      email: uid + "@test.invalid",
      emailVerified: false,
      username: "u" + uid,
    })
    .execute();
  const b = await db
    .insertInto("business")
    .values({
      id: randomUUID(),
      name: "Тест",
      timezone: "Europe/Kaliningrad",
      business_type: "hybrid",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await db
    .insertInto("business_member")
    .values({
      business_id: b.id,
      user_id: uid,
      role: "owner",
      status: "active",
    })
    .execute();
  return { uid, b, industry: new IndustrySetupService(db) };
}

const INDUSTRY_IDS = [
  "beauty",
  "automotive",
  "retail",
  "food",
  "construction",
  "education",
  "sport_health",
  "professional_services",
  "rental",
  "other",
];

for (const id of INDUSTRY_IDS) {
  test(`industry preset ${id} has solutions and capabilities`, () => {
    const p = industryPreset(id);
    assert.ok(p);
    assert.ok(p.recommendedSolutions.length);
    assert.ok(p.recommendedCapabilities.length);
    assert.ok(p.terminology.specialist);
    assert.ok(p.questions.length >= 3);
  });
}

test("allIndustryPresets returns 10 industries", () => {
  assert.equal(allIndustryPresets().length, 10);
});

test("beauty recommends booking and specialists terminology", () => {
  const p = industryPreset("beauty");
  assert.ok(p.recommendedSolutions.includes("booking"));
  assert.equal(p.terminology.specialist, "Мастер");
  assert.equal(businessTypeFromModel(p.defaultBusinessModel), "service");
});

test("retail recommends orders/catalog path", () => {
  const p = industryPreset("retail");
  assert.ok(p.recommendedSolutions.includes("orders"));
  assert.equal(businessTypeFromModel(p.defaultBusinessModel), "store");
});

test("recommendedSolutionCodes prefers industry over business_type", () => {
  const codes = recommendedSolutionCodes("store", "beauty");
  assert.ok(codes.includes("booking"));
  assert.deepEqual(codes, recommendedSolutionsForIndustry("beauty"));
});

test("capability dependency: variants requires catalog", () => {
  const { next, reasons } = resolveCapabilityDependencies([], "variants");
  assert.ok(next.includes("catalog"));
  assert.ok(next.includes("variants"));
  assert.ok(reasons.some((r) => /каталог/i.test(r)));
});

test("capability dependency: auto_schedule requires booking+services", () => {
  const { next } = resolveCapabilityDependencies([], "auto_schedule");
  assert.ok(next.includes("booking"));
  assert.ok(next.includes("services_catalog"));
  assert.ok(next.includes("auto_schedule"));
});

test("advanced search finds обед → breaks and telegram", () => {
  const lunch = searchSettingsIndex("обед");
  assert.ok(lunch.some((c) => c.id === "breaks"));
  const tg = searchSettingsIndex("телеграм");
  assert.ok(tg.some((c) => c.id === "telegram"));
});

test("industry setup save guided beauty + progress persistence", async () => {
  const f = await fixture();
  const saved = await f.industry.save(f.uid, f.b.public_id, {
    industry: "beauty",
    industry_subtype: "barbershop",
    setup_mode: "guided",
    setup_progress: { industry: true },
  });
  assert.equal(saved.industry, "beauty");
  assert.equal(saved.industry_subtype, "barbershop");
  assert.equal(saved.business_model, "services");
  assert.equal(saved.business_type, "service");
  assert.ok(saved.capabilities_enabled.includes("booking"));
  assert.equal(saved.setup_progress.industry, true);
  assert.equal(saved.preset?.terminology.specialist, "Мастер");

  const loaded = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(loaded.industry, "beauty");
  assert.equal(loaded.setup_progress.industry, true);
});

test("advanced mode without industry + manual capabilities", async () => {
  const f = await fixture();
  const saved = await f.industry.save(f.uid, f.b.public_id, {
    setup_mode: "advanced",
    industry: null,
    capabilities_enabled: ["variants", "orders"],
  });
  assert.equal(saved.setup_mode, "advanced");
  assert.equal(saved.industry, null);
  assert.ok(saved.capabilities_enabled.includes("catalog"));
  assert.ok(saved.capabilities_enabled.includes("variants"));
  assert.ok(saved.capabilities_enabled.includes("orders"));
});

test("switching industry does not wipe capabilities override", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, {
    industry: "beauty",
    capabilities_enabled: ["booking", "services_catalog", "orders", "catalog"],
  });
  const next = await f.industry.save(f.uid, f.b.public_id, {
    industry: "automotive",
    industry_subtype: "service",
  });
  assert.equal(next.industry, "automotive");
  // Existing capabilities kept when already set (not overwritten by preset)
  assert.ok(next.capabilities_enabled.includes("orders"));
  assert.ok(next.capabilities_enabled.includes("booking"));
});

test("guided → advanced switch preserves data", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, {
    industry: "education",
    industry_subtype: "tutor",
    setup_mode: "guided",
  });
  const adv = await f.industry.save(f.uid, f.b.public_id, {
    setup_mode: "advanced",
  });
  assert.equal(adv.setup_mode, "advanced");
  assert.equal(adv.industry, "education");
  assert.equal(adv.industry_subtype, "tutor");
});

test("multi-business industry isolation", async () => {
  const f1 = await fixture();
  const f2 = await fixture();
  await f1.industry.save(f1.uid, f1.b.public_id, { industry: "beauty" });
  await f2.industry.save(f2.uid, f2.b.public_id, { industry: "retail" });
  const a = await f1.industry.get(f1.uid, f1.b.public_id);
  const b = await f2.industry.get(f2.uid, f2.b.public_id);
  assert.equal(a.industry, "beauty");
  assert.equal(b.industry, "retail");
});

test("guided recommendations do not activate paid business_solution rows", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, {
    industry: "beauty",
    industry_subtype: "barbershop",
    capabilities_enabled: industryPreset("beauty").recommendedCapabilities,
    setup_progress: { industry: true },
  });
  const solutions = await db
    .selectFrom("business_solution")
    .selectAll()
    .where("business_id", "=", f.b.id)
    .execute();
  assert.equal(solutions.length, 0);
});

test("lead form preset seeds fields only when empty", async () => {
  const { LeadFormService } = await import(
    "../src/server/leads/forms.ts"
  );
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, { industry: "automotive" });
  const leads = new LeadFormService(db);
  const preset = industryPreset("automotive").leadFormPreset;
  assert.ok(preset?.length);
  const first = await leads.applyIndustryPreset(f.uid, f.b.public_id, preset);
  assert.equal(first.applied, true);
  assert.ok(first.count >= 3);
  const second = await leads.applyIndustryPreset(f.uid, f.b.public_id, preset);
  assert.equal(second.applied, false);
  const rows = await leads.list(f.uid, f.b.public_id, true);
  assert.ok(rows.some((r) => /автомоб|проблем|имя/i.test(r.label)));
});

async function connectTelegram(businessId, status = "connected") {
  const id = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id,
      business_id: businessId,
      platform: "telegram",
      external_account_id: randomUUID(),
      display_name: "@test_bot",
      status,
    })
    .execute();
  return id;
}

test("readiness: telegram step is done only for a connected telegram channel", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, {
    industry: "other",
    setup_mode: "advanced",
    capabilities_enabled: ["telegram", "inbox", "admin_messages"],
  });

  const fresh = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(fresh.readiness.hasConnection, false);
  assert.equal(fresh.readiness.hasIndustry, true);
  assert.equal(fresh.readiness.hasActiveSolution, false);

  const connectionId = await connectTelegram(f.b.id, "pending");
  const pending = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(pending.readiness.hasConnection, false);

  await db
    .updateTable("business_connection")
    .set({ status: "connected" })
    .where("id", "=", connectionId)
    .execute();
  const connected = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(connected.readiness.hasConnection, true);
  // Manual progress from the advanced save must not be required for the step.
  assert.equal(connected.setup_progress.telegram, undefined);
});

test("readiness: non-telegram channel does not complete the telegram step", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, { industry: "other" });
  const id = randomUUID();
  await db
    .insertInto("business_connection")
    .values({
      id,
      business_id: f.b.id,
      platform: "vk",
      external_account_id: randomUUID(),
      display_name: "vk",
      status: "connected",
    })
    .execute();
  const loaded = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(loaded.readiness.hasConnection, false);
});

test("readiness is stable for an already-connected business (idempotent reload)", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, {
    industry: "other",
    setup_mode: "advanced",
  });
  const connectionId = await connectTelegram(f.b.id);

  const first = await f.industry.get(f.uid, f.b.public_id);
  const second = await f.industry.get(f.uid, f.b.public_id);
  assert.deepEqual(first.readiness, second.readiness);
  assert.equal(first.readiness.hasConnection, true);
  assert.deepEqual(first.setup_progress, second.setup_progress);

  // Reconnecting the same channel keeps the step done and progress untouched.
  await db
    .updateTable("business_connection")
    .set({ status: "disconnected" })
    .where("id", "=", connectionId)
    .execute();
  assert.equal((await f.industry.get(f.uid, f.b.public_id)).readiness.hasConnection, false);
  await db
    .updateTable("business_connection")
    .set({ status: "connected" })
    .where("id", "=", connectionId)
    .execute();
  const third = await f.industry.get(f.uid, f.b.public_id);
  assert.deepEqual(third.readiness, first.readiness);
  assert.deepEqual(third.setup_progress, first.setup_progress);
});

test("readiness: active solution and in-progress setup both count as connected", async () => {
  const f = await fixture();
  await f.industry.save(f.uid, f.b.public_id, { industry: "retail" });
  assert.equal((await f.industry.get(f.uid, f.b.public_id)).readiness.hasActiveSolution, false);

  await db
    .insertInto("solution_setup_draft")
    .values({
      business_id: f.b.id,
      solution_code: "leads",
      status: "in_progress",
    })
    .execute();
  const inProgress = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(inProgress.readiness.hasActiveSolution, true);

  await db
    .updateTable("solution_setup_draft")
    .set({ status: "completed" })
    .execute();
  const afterDone = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(afterDone.readiness.hasActiveSolution, false);

  await db
    .insertInto("business_solution")
    .values({
      business_id: f.b.id,
      solution_code: "leads",
      status: "active",
      starts_at: new Date(),
    })
    .execute();
  const active = await f.industry.get(f.uid, f.b.public_id);
  assert.equal(active.readiness.hasActiveSolution, true);
});
