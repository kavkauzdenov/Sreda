import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { TelegramService } from "../src/server/telegram/service.ts";
import { runtimeConfig } from "../src/server/identity/config.ts";
import type { Database } from "../src/server/db/schema.ts";

const config = runtimeConfig();
if (process.env.TELEGRAM_WEBHOOKS_ENABLED !== "true")
  throw new Error("Explicitly enable Telegram after deployment checks");

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: config.databaseUrl, max: 3 }),
  }),
});
const service = new TelegramService(
  db,
  config.secret,
  config.telegramWebhookOrigin,
  true,
);

let stopping = false;
process.on("SIGTERM", () => {
  stopping = true;
});
process.on("SIGINT", () => {
  stopping = true;
});

let nextCleanup = 0;
try {
  while (!stopping) {
    try {
      const worked = await service.deliverOne();
      await db
        .insertInto("worker_heartbeat")
        .values({ name: "telegram", seen_at: new Date() })
        .onConflict((oc) =>
          oc.column("name").doUpdateSet({ seen_at: new Date() }),
        )
        .execute();

      if (Date.now() > nextCleanup) {
        await db
          .deleteFrom("telegram_dialog")
          .where("updated_at", "<", new Date(Date.now() - 86400000))
          .execute();
        await db
          .deleteFrom("telegram_outbox")
          .where("delivered_at", "<", new Date(Date.now() - 86400000))
          .where("post_delivery_id", "is", null)
          .execute();
        nextCleanup = Date.now() + 3600000;
      }

      if (!worked) await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      console.error(JSON.stringify({ code: "TELEGRAM_WORKER_ERROR" }));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
} finally {
  await sql`delete from worker_heartbeat where name='telegram'`.execute(db);
  await db.destroy();
}
