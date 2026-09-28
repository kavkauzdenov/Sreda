import "server-only";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "./db/schema";
import { runtimeConfig } from "./identity/config";
import { createIdentity } from "./identity/auth";
import { WorkspaceService } from "./workspaces/service";
import { LeadService } from "./leads/service";
import { InvitationService } from "./invitations/service";
import { ConnectionService } from "./connections/service";
import { CommunicationService } from "./communications/service";

function initialize() {
  const config = runtimeConfig();
  const db = new Kysely<Database>({ dialect: new PostgresDialect({
    pool: new Pool({ connectionString: config.databaseUrl, max: 10,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 }),
  }) });
  const backgroundEnabled = process.env.BACKGROUND_WORKER_ENABLED === "true";
  const telegramEnabled = process.env.TELEGRAM_WEBHOOKS_ENABLED === "true";
  const vkEnabled = process.env.VK_WEBHOOKS_ENABLED === "true";
  const metaEnabled =
    process.env.META_WEBHOOKS_ENABLED === "true" ||
    process.env.WHATSAPP_WEBHOOKS_ENABLED === "true" ||
    process.env.INSTAGRAM_WEBHOOKS_ENABLED === "true";
  return {
    ...config,
    backgroundEnabled,
    telegramEnabled,
    vkEnabled,
    metaEnabled,
    db,
    auth: createIdentity({ ...config, db }),
    workspaces: new WorkspaceService(db),
    leads: new LeadService(db),
    invitations: new InvitationService(db),
    connections: new ConnectionService(db, config.secret),
    communications: new CommunicationService(db),
  };
}
const state = globalThis as typeof globalThis & { sredaRuntime?: ReturnType<typeof initialize> };
export function getRuntime() {
  return state.sredaRuntime ??= initialize();
}
