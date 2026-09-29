import { sql } from "kysely";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Dependency readiness for the web service (database).
 * Used as deploy healthcheck so a paused worker does not block web rollout.
 * Process-only liveness: /api/health/live. Full worker readiness: /api/health.
 * Never exposes secrets.
 */
export async function GET() {
  try {
    await sql`select 1`.execute(getRuntime().db);
    return Response.json(
      { ok: true, checks: { web: "ok", database: "ok" } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { ok: false, checks: { web: "ok", database: "unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
