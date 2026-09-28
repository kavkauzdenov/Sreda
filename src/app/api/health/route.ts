import { sql } from "kysely";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

const HEARTBEAT_TTL_MS = 60_000;

export async function GET() {
  const checks: Record<string, string> = { web: "ok", database: "unavailable" };
  try {
    const r = getRuntime();
    await sql`select 1`.execute(r.db);
    checks.database = "ok";

    const required = new Set<string>([
      "background",
      "notifications",
      "entity_reminders",
      "setup_drafts",
      ...(r.telegramEnabled ? ["telegram"] : []),
      ...(r.vkEnabled ? ["vk"] : []),
      ...(r.metaEnabled ? ["meta_delivery"] : []),
    ]);

    const active = await r.db
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
      required.add("booking_reminders");
    if (active.some((s) => s.solution_code === "autopost"))
      required.add("autopost");

    const beats = await r.db
      .selectFrom("worker_heartbeat")
      .selectAll()
      .execute();

    const names = [
      "background",
      "telegram",
      "vk",
      "meta_delivery",
      "notifications",
      "autopost",
      "booking_reminders",
      "entity_reminders",
      "setup_drafts",
    ];

    for (const name of names) {
      checks[name] = required.has(name)
        ? beats.some(
            (beat) =>
              beat.name === name &&
              +beat.seen_at > Date.now() - HEARTBEAT_TTL_MS,
          )
          ? "ok"
          : "unavailable"
        : "disabled";
    }

    const ok = !Object.values(checks).includes("unavailable");
    return Response.json(
      { ok, checks },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, checks },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
