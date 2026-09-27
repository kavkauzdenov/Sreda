import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { clientActivity } from "../clients/service.ts";
import {
  assertClientAssignmentAllowed,
  resolveAssigneeMember,
  parseAssigneeInput,
} from "../clients/assignment.ts";

type Db = Kysely<Database>;

export async function claimOrder(
  db: Db,
  userId: string,
  publicId: string,
  orderId: string,
) {
  return assignOrder(db, userId, publicId, orderId, userId);
}

export async function assignOrder(
  db: Db,
  userId: string,
  publicId: string,
  orderId: string,
  nextAssigneeRaw: unknown,
) {
  requireUuid(orderId);
  const nextAssigneeId = parseAssigneeInput(nextAssigneeRaw);
  if (nextAssigneeId === undefined)
    throw new AppError(400, "INVALID_ASSIGNEE", "Укажите сотрудника.");

  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "orders.write");
    const member = await tx
      .selectFrom("business_member")
      .select(["role"])
      .where("business_id", "=", b.id)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();

    const order = await tx
      .selectFrom("order")
      .select([
        "id",
        "assigned_user_id",
        "order_number",
        "status",
        "client_id",
      ])
      .where("business_id", "=", b.id)
      .where("id", "=", orderId)
      .forUpdate()
      .executeTakeFirst();
    if (!order)
      throw new AppError(404, "ORDER_NOT_FOUND", "Заказ не найден.");

    const resolved =
      nextAssigneeId === null
        ? null
        : await resolveAssigneeMember(tx, b.id, nextAssigneeId);

    assertClientAssignmentAllowed({
      role: member.role,
      actorUserId: userId,
      currentAssigneeId: order.assigned_user_id,
      nextAssigneeId: resolved,
    });

    const now = new Date();
    await tx
      .updateTable("order")
      .set({
        assigned_user_id: resolved,
        assigned_at: resolved ? now : null,
        updated_at: now,
      })
      .where("business_id", "=", b.id)
      .where("id", "=", orderId)
      .execute();

    const activityType =
      order.assigned_user_id &&
      resolved &&
      order.assigned_user_id !== resolved
        ? "order.reassigned"
        : resolved
          ? "order.assigned"
          : "order.unassigned";

    await clientActivity(
      tx,
      b.id,
      order.client_id,
      activityType,
      `order-assign:${orderId}:${resolved ?? "none"}:${now.getTime()}`,
      orderId,
      userId,
      {
        previous: order.assigned_user_id,
        next: resolved,
        orderNumber: order.order_number,
      },
    );

    const assignee = resolved
      ? await tx
          .selectFrom("user")
          .select(["id", "name"])
          .where("id", "=", resolved)
          .executeTakeFirst()
      : null;

    return {
      id: orderId,
      assignedUser: assignee
        ? { id: assignee.id, name: assignee.name }
        : null,
      assignedAt: resolved ? now.toISOString() : null,
    };
  });
}

/** Used when creating an order with optional assignee from owner/admin. */
export async function assertCanSetAssigneeOnCreate(
  tx: Transaction<Database>,
  businessId: string,
  actorUserId: string,
  role: string,
  assigneeId: string | null | undefined,
): Promise<string | null | undefined> {
  if (assigneeId === undefined) return undefined;
  if (assigneeId === null) return null;
  if (role !== "owner" && role !== "admin") {
    throw new AppError(
      403,
      "FORBIDDEN",
      "Оператор не может назначать заказ при создании.",
    );
  }
  return resolveAssigneeMember(tx, businessId, assigneeId);
}
