import type { Kysely } from "kysely";
import type { Database, Role } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
export type Permission =
  | "clients.read"
  | "clients.write"
  | "leads.write"
  | "messages.write"
  | "booking.write"
  | "orders.write"
  | "posts.manage"
  | "settings.manage"
  | "connections.manage"
  | "solutions.manage"
  | "notifications.read"
  | "analytics.view"
  | "analytics.export"
  | "analytics.upload"
  | "analytics.ai"
  | "intelligence.manage";
const operatorPermissions: readonly Permission[] = [
  "clients.read",
  "clients.write",
  "leads.write",
  "messages.write",
  "booking.write",
  "orders.write",
  "notifications.read",
  "analytics.view",
];
export function allowed(role: Role, permission: Permission) {
  return (
    role === "owner" ||
    role === "admin" ||
    (role === "operator" && operatorPermissions.includes(permission))
  );
}
export async function requireBusiness(
  db: Kysely<Database>,
  userId: string,
  publicId: string,
  permission: Permission,
) {
  const business = await db
    .selectFrom("business as b")
    .innerJoin("business_member as m", "m.business_id", "b.id")
    .select(["b.id", "b.public_id", "m.role"])
    .where("b.public_id", "=", publicId)
    .where("b.archived_at", "is", null)
    .where("m.user_id", "=", userId)
    .where("m.status", "=", "active")
    .executeTakeFirst();
  if (!business)
    throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
  if (!allowed(business.role, permission))
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
  return business;
}
