import type { Generated } from "kysely";

export interface IntelligenceTables {
  intelligence_audit_log: {
    id: string;
    business_id: string;
    user_id: string | null;
    operation: string;
    source: Generated<string>;
    reason: string | null;
    result: Generated<string>;
    metadata: Generated<unknown>;
    created_at: Generated<Date>;
  };
}
