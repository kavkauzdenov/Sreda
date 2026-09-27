import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { requireUuid } from "../http/validation.ts";
import { audit } from "../audit/service.ts";
import { clientActivity } from "./service.ts";
import { pairClients } from "./types.ts";

type Db = Kysely<Database>;

export async function mergeClients(
  db: Db,
  userId: string,
  publicId: string,
  raw: Record<string, unknown>,
) {
  const sourceId =
    typeof raw.source_client_id === "string"
      ? raw.source_client_id
      : typeof raw.sourceClientId === "string"
        ? raw.sourceClientId
        : "";
  const targetId =
    typeof raw.target_client_id === "string"
      ? raw.target_client_id
      : typeof raw.targetClientId === "string"
        ? raw.targetClientId
        : "";
  requireUuid(sourceId);
  requireUuid(targetId);
  if (sourceId === targetId)
    throw new AppError(
      400,
      "INVALID_MERGE",
      "Выберите двух разных клиентов.",
    );

  return db.transaction().execute(async (tx) => {
    const b = await requireBusiness(tx, userId, publicId, "clients.write");
    if (b.role !== "owner" && b.role !== "admin")
      throw new AppError(
        403,
        "FORBIDDEN",
        "Объединять клиентов может владелец или администратор.",
      );

    await tx
      .selectFrom("business")
      .select("id")
      .where("id", "=", b.id)
      .forUpdate()
      .execute();
    await requireBusiness(tx, userId, publicId, "clients.write");

    const source = await tx
      .selectFrom("client")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", sourceId)
      .where("archived_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    const target = await tx
      .selectFrom("client")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", targetId)
      .where("archived_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!source || !target)
      throw new AppError(
        404,
        "CLIENT_NOT_FOUND",
        "Клиент не найден в этом бизнесе.",
      );

    await moveIdentities(tx, b.id, sourceId, targetId);
    await moveLinkedEntities(tx, b.id, sourceId, targetId);
    await mergeTags(tx, b.id, sourceId, targetId);

    let profileNote = target.profile_note;
    let sourceNotePreserved = false;
    if (!target.profile_note && source.profile_note) {
      profileNote = source.profile_note;
    } else if (
      target.profile_note &&
      source.profile_note &&
      target.profile_note !== source.profile_note
    ) {
      await tx
        .insertInto("client_note")
        .values({
          id: randomUUID(),
          business_id: b.id,
          client_id: targetId,
          actor_user_id: userId,
          text: `Заметка из объединённой карточки «${source.name}»:\n${source.profile_note}`,
        })
        .execute();
      sourceNotePreserved = true;
    }

    const assignedUserId =
      target.assigned_user_id ?? source.assigned_user_id ?? null;
    const assignedAt = assignedUserId
      ? (target.assigned_user_id
          ? target.assigned_at
          : source.assigned_at) ?? new Date()
      : null;

    const now = new Date();
    await tx
      .updateTable("client")
      .set({
        name: target.name || source.name,
        phone: target.phone ?? source.phone,
        email: target.email ?? source.email,
        profile_note: profileNote,
        assigned_user_id: assignedUserId,
        assigned_at: assignedAt,
        first_seen_at:
          source.first_seen_at < target.first_seen_at
            ? source.first_seen_at
            : target.first_seen_at,
        last_seen_at:
          source.last_seen_at > target.last_seen_at
            ? source.last_seen_at
            : target.last_seen_at,
        updated_at: now,
      })
      .where("business_id", "=", b.id)
      .where("id", "=", targetId)
      .execute();

    await tx
      .updateTable("client")
      .set({
        archived_at: now,
        merged_into_id: targetId,
        updated_at: now,
      })
      .where("business_id", "=", b.id)
      .where("id", "=", sourceId)
      .execute();

    // Canonicalize duplicate decision as merged.
    const [a, c] = pairClients(sourceId, targetId);
    await tx
      .insertInto("client_duplicate_decision")
      .values({
        id: randomUUID(),
        business_id: b.id,
        client_a_id: a,
        client_b_id: c,
        decision: "merged",
        actor_user_id: userId,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "client_a_id", "client_b_id"]).doUpdateSet({
          decision: "merged",
          actor_user_id: userId,
          updated_at: now,
        }),
      )
      .execute();

    // Remap decisions involving source onto target where possible.
    await remapDuplicateDecisions(tx, b.id, sourceId, targetId);

    await clientActivity(
      tx,
      b.id,
      targetId,
      "client.merged",
      `client-merge:${sourceId}:${targetId}`,
      sourceId,
      userId,
      {
        source_client_id: sourceId,
        target_client_id: targetId,
        source_note_preserved: sourceNotePreserved,
      },
    );
    await audit(tx, b.id, userId, "client_merged", targetId, {
      source_client_id: sourceId,
      target_client_id: targetId,
      source_name: source.name,
      target_name: target.name,
    });

    return { target_client_id: targetId, source_client_id: sourceId };
  });
}

async function moveIdentities(
  tx: Transaction<Database>,
  businessId: string,
  sourceId: string,
  targetId: string,
) {
  const targetIdentities = await tx
    .selectFrom("client_identity")
    .select(["kind", "value"])
    .where("business_id", "=", businessId)
    .where("client_id", "=", targetId)
    .execute();
  const targetKeys = new Set(
    targetIdentities.map((i) => `${i.kind}:${i.value}`),
  );
  const sourceIdentities = await tx
    .selectFrom("client_identity")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();

  for (const identity of sourceIdentities) {
    const key = `${identity.kind}:${identity.value}`;
    if (targetKeys.has(key)) {
      await tx
        .deleteFrom("client_identity")
        .where("business_id", "=", businessId)
        .where("client_id", "=", sourceId)
        .where("kind", "=", identity.kind)
        .where("value", "=", identity.value)
        .execute();
    } else {
      await tx
        .updateTable("client_identity")
        .set({ client_id: targetId })
        .where("business_id", "=", businessId)
        .where("client_id", "=", sourceId)
        .where("kind", "=", identity.kind)
        .where("value", "=", identity.value)
        .execute();
    }
  }
}

async function moveLinkedEntities(
  tx: Transaction<Database>,
  businessId: string,
  sourceId: string,
  targetId: string,
) {
  await tx
    .updateTable("lead")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("booking")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("order")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("cart")
    .set({ client_id: targetId, updated_at: new Date() })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("client_note")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("client_activity")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("communication_conversation")
    .set({ client_id: targetId })
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  await tx
    .updateTable("calendar_event")
    .set({ related_client_id: targetId })
    .where("business_id", "=", businessId)
    .where("related_client_id", "=", sourceId)
    .execute();
}

async function mergeTags(
  tx: Transaction<Database>,
  businessId: string,
  sourceId: string,
  targetId: string,
) {
  const sourceTags = await tx
    .selectFrom("client_tag_link")
    .select("tag_id")
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
  for (const tag of sourceTags) {
    await tx
      .insertInto("client_tag_link")
      .values({
        business_id: businessId,
        client_id: targetId,
        tag_id: tag.tag_id,
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "client_id", "tag_id"]).doNothing(),
      )
      .execute();
  }
  await tx
    .deleteFrom("client_tag_link")
    .where("business_id", "=", businessId)
    .where("client_id", "=", sourceId)
    .execute();
}

async function remapDuplicateDecisions(
  tx: Transaction<Database>,
  businessId: string,
  sourceId: string,
  targetId: string,
) {
  const rows = await tx
    .selectFrom("client_duplicate_decision")
    .selectAll()
    .where("business_id", "=", businessId)
    .where((eb) =>
      eb.or([
        eb("client_a_id", "=", sourceId),
        eb("client_b_id", "=", sourceId),
      ]),
    )
    .execute();
  for (const row of rows) {
    const other =
      row.client_a_id === sourceId ? row.client_b_id : row.client_a_id;
    if (other === targetId) continue;
    const [a, c] = pairClients(other, targetId);
    await tx
      .insertInto("client_duplicate_decision")
      .values({
        id: randomUUID(),
        business_id: businessId,
        client_a_id: a,
        client_b_id: c,
        decision: row.decision,
        actor_user_id: row.actor_user_id,
        created_at: row.created_at,
        updated_at: new Date(),
      })
      .onConflict((oc) =>
        oc.columns(["business_id", "client_a_id", "client_b_id"]).doNothing(),
      )
      .execute();
  }
}
