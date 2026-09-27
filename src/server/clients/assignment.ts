import type { Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireUuid } from "../http/validation.ts";

export type MemberRole = "owner" | "admin" | "operator" | string;

/**
 * Shared assignment authorization for assignClient(), claim, and ClientService.save().
 * Backend is the source of truth — never trust a client-supplied "current user" for claim.
 */
export function assertClientAssignmentAllowed(input: {
  role: MemberRole;
  actorUserId: string;
  currentAssigneeId: string | null;
  nextAssigneeId: string | null;
}): void {
  const isOwnerAdmin = input.role === "owner" || input.role === "admin";
  if (isOwnerAdmin) return;

  // Operator rules:
  // - unassigned → may assign ONLY self (claim)
  // - already assigned → may not change assigned_user_id at all
  if (input.currentAssigneeId != null) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Оператор не может переназначать клиента.",
    );
  }
  if (input.nextAssigneeId !== input.actorUserId) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Оператор может взять клиента только на себя.",
    );
  }
}

export async function resolveAssigneeMember(
  tx: Transaction<Database>,
  businessId: string,
  assigneeId: string | null,
): Promise<string | null> {
  if (assigneeId === null) return null;
  requireUuid(assigneeId);
  const member = await tx
    .selectFrom("business_member")
    .select("user_id")
    .where("business_id", "=", businessId)
    .where("user_id", "=", assigneeId)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!member)
    throw new AppError(
      400,
      "INVALID_ASSIGNEE",
      "Сотрудник недоступен в этом бизнесе.",
    );
  return assigneeId;
}

export function parseAssigneeInput(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || raw === "") return null;
  if (typeof raw !== "string")
    throw new AppError(400, "INVALID_ASSIGNEE", "Выберите сотрудника.");
  requireUuid(raw);
  return raw;
}
