import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { verifyPin } from "./pin.ts";

export function loginCredential(db: Kysely<Database>, username: string) {
  return db.selectFrom("account").innerJoin("user", "user.id", "account.userId")
    .leftJoin("account_pin", "account_pin.user_id", "user.id")
    .select(["account.userId", "account.password", "account_pin.pin_hash"])
    .where("user.username", "=", username).where("account.providerId", "=", "credential")
    .where("user.deletion_status", "=", "active")
    .where("user.deleted_at", "is", null)
    .executeTakeFirst();
}

// Only release the new cookie if the credential used to begin this login is still
// current. Recovery/password change take this same user lock and delete sessions.
export async function acceptLogin(db: Kysely<Database>, before: Awaited<ReturnType<typeof loginCredential>>, token: string, secret: string, pin: unknown): Promise<"accepted" | "credentials" | "pin" | "locked"> {
  return db.transaction().execute(async (tx) => {
    const user = before && await tx.selectFrom("user").select("id").where("id", "=", before.userId).forUpdate().executeTakeFirst();
    const current = user && await tx.selectFrom("account").select("password").where("userId", "=", user.id).where("providerId", "=", "credential").executeTakeFirst();
    const session = user && await tx.selectFrom("session").select("id").where("userId", "=", user.id).where("token", "=", token).executeTakeFirst();
    const currentPin = user && await tx.selectFrom("account_pin").selectAll().where("user_id", "=", user.id).executeTakeFirst();
    let failure: "credentials" | "pin" | "locked" = "credentials";
    if (before?.password && current?.password === before.password && session && (currentPin?.pin_hash ?? null) === before.pin_hash) {
      if (!currentPin) return "accepted";
      const now = new Date();
      if (currentPin.locked_until && currentPin.locked_until > now) failure = "locked";
      else if (await verifyPin(secret, before.userId, currentPin.pin_hash, pin)) {
        await tx
          .updateTable("account_pin")
          .set({ failed_attempts: 0, locked_until: null })
          .where("user_id", "=", before.userId)
          .execute();
        await tx
          .insertInto("platform_admin_mfa_session")
          .values({
            session_id: session.id,
            user_id: before.userId,
            verified_at: new Date(),
          })
          .onConflict((oc) =>
            oc.column("session_id").doUpdateSet({
              user_id: before.userId,
              verified_at: new Date(),
            }),
          )
          .execute();
        return "accepted";
      } else {
        failure = "pin";
        // The first password-only request reveals the PIN form without spending
        // an attempt. Supplied incorrect PINs count across all server instances.
        if (pin !== undefined && pin !== "") {
          const attempts = (currentPin.locked_until ? 0 : currentPin.failed_attempts) + 1;
          const locked = attempts >= 5;
          await tx.updateTable("account_pin").set({ failed_attempts: attempts,
            locked_until: locked ? new Date(now.getTime() + 15 * 60 * 1000) : null }).where("user_id", "=", before.userId).execute();
          if (locked) failure = "locked";
        }
      }
    }
    // Return false, do not throw here: revocation must commit before the HTTP error.
    await tx.deleteFrom("session").where("token", "=", token).execute();
    return failure;
  });
}
