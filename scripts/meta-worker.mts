import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { MetaChannelService } from "../src/server/meta/service.ts";
import { CommunicationService } from "../src/server/communications/service.ts";
import { runtimeConfig } from "../src/server/identity/config.ts";
import type { Database } from "../src/server/db/schema.ts";

const config = runtimeConfig();
const enabled =
  process.env.META_WEBHOOKS_ENABLED === "true" ||
  process.env.WHATSAPP_WEBHOOKS_ENABLED === "true" ||
  process.env.INSTAGRAM_WEBHOOKS_ENABLED === "true";

if (!enabled) throw new Error("Explicitly enable Meta channels after deployment checks");

const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: config.databaseUrl, max: 3 }),
  }),
});
const service = new MetaChannelService(
  db,
  config.secret,
  true,
  new CommunicationService(db),
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
      if (Date.now() > nextCleanup) {
        await db
          .deleteFrom("meta_outbox")
          .where("delivered_at", "<", new Date(Date.now() - 86400000))
          .execute();
        nextCleanup = Date.now() + 3600000;
      }
      if (!worked) await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch {
      console.error(JSON.stringify({ code: "META_WORKER_ERROR" }));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
} finally {
  await sql`delete from worker_heartbeat where name='meta_delivery'`.execute(db);
  await db.destroy();
}
