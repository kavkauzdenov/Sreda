import { createHmac, randomUUID } from "node:crypto";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";

function pinMaterial(secret: string, userId: string, pin: string) {
  return createHmac("sha256", secret).update(`account-pin:${userId}:${pin}`).digest("hex");
}
export async function verifyPin(secret: string, userId: string, hash: string, value: unknown) {
  return typeof value === "string" && /^[0-9]{4}$/.test(value)
    && verifyPassword({ hash, password: pinMaterial(secret, userId, value) });
}

export class PinService {
  constructor(private readonly db: Kysely<Database>, private readonly secret: string) {}
  async status(userId: string) {
    const row = await this.db.selectFrom("account_pin").select("user_id").where("user_id", "=", userId).executeTakeFirst();
    return { enabled: !!row };
  }
  async configure(userId: string, sessionId: string, body: Record<string, unknown>) {
    const { currentPassword, pin, pinConfirmation, enabled } = body;
    if (typeof enabled !== "boolean") throw new AppError(400, "INVALID_PIN", "Выберите действие с PIN.");
    if (typeof currentPassword !== "string" || currentPassword.length < 10 || currentPassword.length > 128)
      throw new AppError(400, "INVALID_PASSWORD", "Введите текущий пароль.");
    if (enabled && (typeof pin !== "string" || !/^[0-9]{4}$/.test(pin)))
      throw new AppError(400, "INVALID_PIN", "PIN должен состоять из четырёх цифр.");
    if (enabled && pin !== pinConfirmation) throw new AppError(400, "PIN_MISMATCH", "PIN-коды не совпадают.");
    return this.db.transaction().execute(async (tx) => {
      await tx.selectFrom("user").select("id").where("id", "=", userId).forUpdate().executeTakeFirstOrThrow();
      const session = await tx.selectFrom("session").select("id").where("id", "=", sessionId).where("userId", "=", userId).executeTakeFirst();
      if (!session) throw new AppError(401, "UNAUTHENTICATED", "Войдите в аккаунт.");
      const account = await tx.selectFrom("account").select("password").where("userId", "=", userId).where("providerId", "=", "credential").executeTakeFirst();
      if (!account?.password || !await verifyPassword({ hash: account.password, password: currentPassword }))
        throw new AppError(400, "PASSWORD_INCORRECT", "Текущий пароль не подходит.");
      const previous = await tx.selectFrom("account_pin").select("pin_hash").where("user_id", "=", userId).executeTakeFirst();
      if (previous && !await verifyPin(this.secret, userId, previous.pin_hash, body.currentPin))
        throw new AppError(400, "PIN_INCORRECT", "Текущий PIN не подходит. Если вы его забыли, используйте резервный код для восстановления доступа.");
      if (enabled) {
        const pinHash = await hashPassword(pinMaterial(this.secret, userId, pin as string));
        await tx.insertInto("account_pin").values({ user_id: userId, pin_hash: pinHash, locked_until: null })
          .onConflict((oc) => oc.column("user_id").doUpdateSet({ pin_hash: pinHash, failed_attempts: 0, locked_until: null, updated_at: new Date() })).execute();
      } else await tx.deleteFrom("account_pin").where("user_id", "=", userId).execute();
      await tx.deleteFrom("session").where("userId", "=", userId).where("id", "!=", sessionId).execute();
      await tx
        .deleteFrom("platform_admin_mfa_session")
        .where("session_id", "=", sessionId)
        .execute();
      await tx.insertInto("account_security_event").values({ id: randomUUID(), user_id: userId,
        action: enabled ? previous ? "pin_changed" : "pin_enabled" : "pin_disabled" }).execute();
      return { enabled };
    });
  }
}
