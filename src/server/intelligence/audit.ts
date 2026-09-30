import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

export async function logIntelligenceEvent(
  db: Kysely<Database>,
  input: {
    businessId: string;
    userId: string | null;
    operation: string;
    /** Кто выполняет операцию: business_brain | osint. */
    source?: string;
    reason?: string;
    result?: string;
    metadata?: Record<string, unknown>;
  },
) {
  await db
    .insertInto("intelligence_audit_log")
    .values({
      id: randomUUID(),
      business_id: input.businessId,
      user_id: input.userId,
      operation: input.operation,
      source: input.source ?? "business_brain",
      reason: input.reason ?? null,
      result: input.result ?? "ok",
      metadata: input.metadata ?? {},
    })
    .execute();
}
