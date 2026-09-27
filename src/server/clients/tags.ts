import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { normalizeTagName, type ClientTagDto } from "./types.ts";
import { clientActivity } from "./service.ts";
import {
  assertClientAssignmentAllowed,
  parseAssigneeInput,
  resolveAssigneeMember,
} from "./assignment.ts";

type Db = Kysely<Database>;

export async function listBusinessTags(
  db: Db,
  userId: string,
  publicId: string,
): Promise<ClientTagDto[]> {
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  const rows = await db
    .selectFrom("client_tag")
    .select(["id", "name", "color_key"])
    .where("business_id", "=", b.id)
    .orderBy("name")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    colorKey: r.color_key,
  }));
}

export async function createTag(
  db: Db,
  userId: string,
  publicId: string,
  raw: Record<string, unknown>,
): Promise<ClientTagDto> {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 40)
    throw new AppError(400, "INVALID_TAG", "Укажите название тега до 40 символов.");
  const colorKey =
    typeof raw.colorKey === "string" && raw.colorKey.trim()
      ? raw.colorKey.trim().slice(0, 32)
      : "neutral";
  const normalized = normalizeTagName(name);
  const b = await requireBusiness(db, userId, publicId, "clients.write");
  try {
    const row = await db
      .insertInto("client_tag")
      .values({
        id: randomUUID(),
        business_id: b.id,
        name,
        name_normalized: normalized,
        color_key: colorKey,
      })
      .returning(["id", "name", "color_key"])
      .executeTakeFirstOrThrow();
    return { id: row.id, name: row.name, colorKey: row.color_key };
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "23505")
      throw new AppError(409, "TAG_EXISTS", "Такой тег уже есть.");
    throw err;
  }
}

export async function attachTag(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  tagId: string,
) {
  requireUuid(clientId);
  requireUuid(tagId);
  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "clients.write");
    const client = await tx
      .selectFrom("client")
      .select("id")
      .where("business_id", "=", b.id)
      .where("id", "=", clientId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (!client)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    const tag = await tx
      .selectFrom("client_tag")
      .select(["id", "name", "color_key"])
      .where("business_id", "=", b.id)
      .where("id", "=", tagId)
      .executeTakeFirst();
    if (!tag) throw new AppError(404, "TAG_NOT_FOUND", "Тег не найден.");
    await tx
      .insertInto("client_tag_link")
      .values({
        business_id: b.id,
        client_id: clientId,
        tag_id: tagId,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "client_id", "tag_id"]).doNothing(),
      )
      .execute();
    return { id: tag.id, name: tag.name, colorKey: tag.color_key };
  });
}

export async function detachTag(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  tagId: string,
) {
  requireUuid(clientId);
  requireUuid(tagId);
  const b = await requireBusiness(db, userId, publicId, "clients.write");
  const deleted = await db
    .deleteFrom("client_tag_link")
    .where("business_id", "=", b.id)
    .where("client_id", "=", clientId)
    .where("tag_id", "=", tagId)
    .executeTakeFirst();
  if (!deleted.numDeletedRows)
    throw new AppError(404, "TAG_LINK_NOT_FOUND", "Тег не привязан к клиенту.");
  return { ok: true };
}

export async function setProfileNote(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  note: unknown,
) {
  requireUuid(clientId);
  if (note !== null && typeof note !== "string")
    throw new AppError(400, "INVALID_NOTE", "Проверьте текст заметки.");
  const text =
    typeof note === "string" ? note.trim().slice(0, 4000) || null : null;
  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "clients.write");
    const updated = await tx
      .updateTable("client")
      .set({ profile_note: text, updated_at: new Date() })
      .where("business_id", "=", b.id)
      .where("id", "=", clientId)
      .where("archived_at", "is", null)
      .returning(["id", "profile_note"])
      .executeTakeFirst();
    if (!updated)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    await clientActivity(
      tx,
      b.id,
      clientId,
      "client.profile_note_updated",
      `client-profile-note:${clientId}:${Date.now()}`,
      clientId,
      userId,
    );
    return { profileNote: updated.profile_note };
  });
}

export async function assignClient(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
  assigneeId: unknown,
) {
  requireUuid(clientId);
  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "clients.write");
    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", b.id)
      .forUpdate()
      .execute();

    const client = await tx
      .selectFrom("client")
      .select(["id", "assigned_user_id"])
      .where("business_id", "=", b.id)
      .where("id", "=", clientId)
      .where("archived_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!client)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");

    const parsed = parseAssigneeInput(
      assigneeId === undefined ? null : assigneeId,
    );
    const nextAssignee = await resolveAssigneeMember(
      tx,
      b.id,
      parsed === undefined ? null : parsed,
    );

    assertClientAssignmentAllowed({
      role: b.role,
      actorUserId: userId,
      currentAssigneeId: client.assigned_user_id,
      nextAssigneeId: nextAssignee,
    });

    const now = new Date();
    await tx
      .updateTable("client")
      .set({
        assigned_user_id: nextAssignee,
        assigned_at: nextAssignee ? now : null,
        updated_at: now,
      })
      .where("business_id", "=", b.id)
      .where("id", "=", clientId)
      .execute();

    const type =
      client.assigned_user_id && nextAssignee && client.assigned_user_id !== nextAssignee
        ? "client.reassigned"
        : nextAssignee
          ? "client.assigned"
          : "client.reassigned";
    await clientActivity(
      tx,
      b.id,
      clientId,
      type,
      `client-assign:${clientId}:${nextAssignee ?? "none"}:${now.getTime()}`,
      nextAssignee,
      userId,
      { previous: client.assigned_user_id, next: nextAssignee },
    );

    let assignedUser = null;
    if (nextAssignee) {
      const user = await tx
        .selectFrom("user as u")
        .innerJoin("business_member as m", (join) =>
          join
            .onRef("m.user_id", "=", "u.id")
            .on("m.business_id", "=", b.id),
        )
        .select(["u.id", "u.name", "m.role"])
        .where("u.id", "=", nextAssignee)
        .executeTakeFirst();
      if (user)
        assignedUser = { id: user.id, name: user.name, role: user.role };
    }
    return { assignedUser };
  });
}

/** Operator (or any member) claims an unassigned client onto the authenticated user. */
export async function claimClient(
  db: Db,
  userId: string,
  publicId: string,
  clientId: string,
) {
  return assignClient(db, userId, publicId, clientId, userId);
}

export async function listAssignees(
  db: Db,
  userId: string,
  publicId: string,
) {
  const b = await requireBusiness(db, userId, publicId, "clients.read");
  return db
    .selectFrom("business_member as m")
    .innerJoin("user as u", "u.id", "m.user_id")
    .select(["u.id", "u.name", "m.role"])
    .where("m.business_id", "=", b.id)
    .where("m.status", "=", "active")
    .where("m.role", "in", ["owner", "admin", "operator"])
    .orderBy("u.name")
    .execute();
}
