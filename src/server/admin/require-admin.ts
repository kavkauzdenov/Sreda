import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { limit } from "../http/limits.ts";
import type { Identity } from "../identity/auth.ts";
import {
  platformAllowed,
  type PlatformAdminPermission,
  type PlatformAdminRole,
} from "./permissions.ts";

export type AdminActor = {
  userId: string;
  publicId: string;
  name: string;
  username: string;
  role: PlatformAdminRole;
  requestId: string;
};

export async function requirePlatformAdmin(
  options: {
    auth: Identity;
    db: Kysely<Database>;
    secret: string;
  },
  headers: Headers,
  permission: PlatformAdminPermission,
): Promise<AdminActor> {
  const requestId = crypto.randomUUID();
  const session = await options.auth.api.getSession({ headers });
  if (!session?.user?.username) {
    throw new AppError(401, "UNAUTHENTICATED", "Войдите в аккаунт.");
  }

  await limit(
    options.db,
    options.secret,
    "admin:" + session.user.id,
    120,
    60,
  );

  const row = await options.db
    .selectFrom("platform_admin as a")
    .innerJoin("user as u", "u.id", "a.user_id")
    .select([
      "a.user_id",
      "a.role",
      "a.status",
      "u.public_id",
      "u.name",
      "u.username",
    ])
    .where("a.user_id", "=", session.user.id)
    .where("a.status", "=", "active")
    .executeTakeFirst();

  if (!row) {
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
  }

  const pin = await options.db
    .selectFrom("account_pin")
    .select("user_id")
    .where("user_id", "=", session.user.id)
    .executeTakeFirst();
  if (!pin) {
    throw new AppError(
      403,
      "ADMIN_MFA_REQUIRED",
      "Для доступа к админ-панели включите PIN аккаунта в настройках безопасности.",
    );
  }

  const verifiedSession = await options.db
    .selectFrom("platform_admin_mfa_session")
    .select("verified_at")
    .where("session_id", "=", session.session.id)
    .where("user_id", "=", session.user.id)
    .executeTakeFirst();
  if (!verifiedSession) {
    throw new AppError(
      403,
      "ADMIN_MFA_REAUTH_REQUIRED",
      "Выйдите и войдите снова, подтвердив PIN аккаунта.",
    );
  }

  const role = row.role as PlatformAdminRole;
  if (!platformAllowed(role, permission)) {
    throw new AppError(403, "FORBIDDEN", "Недостаточно прав.");
  }

  return {
    userId: row.user_id,
    publicId: row.public_id,
    name: row.name,
    username: row.username,
    role,
    requestId,
  };
}
