import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { queueNotification } from "../src/server/notifications/worker.ts";
import {
  queueScheduledPost,
  materializeRecurringPost,
} from "../src/server/posts/worker.ts";
import { queueBookingReminder } from "../src/server/booking/worker.ts";
import { processEntityReminder } from "../src/server/calendar/worker.ts";
import { processSetupDrafts } from "../src/server/solutions/setup-draft-worker.ts";
import { processQueuedDiscoveryRuns } from "../src/server/intelligence/osint/runner.ts";
import { processQueuedEnrichments } from "../src/server/intelligence/osint/enrichment.ts";
import { createBuiltinRegistry } from "../src/server/intelligence/osint/providers/builtin.ts";
import { createRobotsChecker } from "../src/server/intelligence/osint/robots.ts";
import { runtimeConfig } from "../src/server/identity/config.ts";
import type { Database } from "../src/server/db/schema.ts";

const config = runtimeConfig();
const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: config.databaseUrl, max: 3 }),
  }),
});

const heartbeatNames = [
  "background",
  "notifications",
  "autopost",
  "booking_reminders",
  "entity_reminders",
  "setup_drafts",
  "osint",
] as const;

async function heartbeat(name: (typeof heartbeatNames)[number]) {
  await db
    .insertInto("worker_heartbeat")
    .values({ name, seen_at: new Date() })
    .onConflict((oc) =>
      oc.column("name").doUpdateSet({ seen_at: new Date() }),
    )
    .execute();
}

let stopping = false;
// SIGTERM гасит незавершённый discovery: сигнал уходит в воркер, run
// корректно закрывается (partial/skipped) вместо гибели под SIGKILL'ом и
// 15-минутного stale-таймера.
const shutdown = new AbortController();
process.on("SIGTERM", () => {
  stopping = true;
  shutdown.abort(new Error("worker_stopping"));
});
process.on("SIGINT", () => {
  stopping = true;
  shutdown.abort(new Error("worker_stopping"));
});

try {
  while (!stopping) {
    try {
      await queueNotification(db, config.origin);
      await heartbeat("notifications");

      await materializeRecurringPost(db);
      await queueScheduledPost(db);
      await heartbeat("autopost");

      await queueBookingReminder(db);
      await heartbeat("booking_reminders");

      await processEntityReminder(db);
      await heartbeat("entity_reminders");

      await processSetupDrafts(db);
      await heartbeat("setup_drafts");

      // OSINT discovery: реестр и robots-кэш свежие на каждый тик — один
      // run получает собственный emit-once набор провайдеров (§25).
      await processQueuedDiscoveryRuns(db, {
        registry: createBuiltinRegistry(),
        crawl: { robots: createRobotsChecker() },
        limit: 1,
        signal: shutdown.signal,
      });

      // Stage 4 (§26.11): enrichment очередь — facts/changes/contradictions
      // считаются в воркере, не в HTTP-запросе. Тот же heartbeat "osint".
      await processQueuedEnrichments(db, { limit: 1 });
      await heartbeat("osint");

      await heartbeat("background");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      const message = (
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 300);
      console.error(
        JSON.stringify({
          code: "BACKGROUND_WORKER_ERROR",
          error: message || "unknown_error",
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
} finally {
  await sql`delete from worker_heartbeat where name in ('background','notifications','autopost','booking_reminders','entity_reminders','setup_drafts','osint')`.execute(db);
  await db.destroy();
}
