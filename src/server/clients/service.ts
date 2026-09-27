import { requireUuid } from "../http/validation.ts";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { requireBusiness } from "../access/permissions.ts";
import { normalizeTagName } from "./types.ts";
type Identity = {
  kind: "telegram" | "vk" | "whatsapp" | "instagram" | "phone" | "email";
  value: string;
  username?: string | null;
};
export function normalizeIdentity(identity: Identity): Identity {
  let value = identity.value.trim();
  if (identity.kind === "phone") {
    value = value.replace(/[\s().-]/g, "");
    if (!/^\+[1-9]\d{7,14}$/.test(value))
      throw new AppError(
        400,
        "INVALID_PHONE",
        "Укажите телефон в международном формате.",
      );
  } else if (identity.kind === "email") {
    value = value.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254)
      throw new AppError(400, "INVALID_EMAIL", "Проверьте email.");
  } else if (identity.kind === "whatsapp" || identity.kind === "instagram") {
    // WhatsApp: E.164 digits without +. Instagram: numeric IGSID / Page-scoped id.
    if (!/^[1-9]\d{0,31}$/.test(value))
      throw new AppError(400, "INVALID_IDENTITY", "Некорректный идентификатор.");
  } else if (!/^[1-9]\d{0,19}$/.test(value))
    throw new AppError(400, "INVALID_IDENTITY", "Некорректный идентификатор.");
  return { ...identity, value };
}
export function clientInput(raw: Record<string, unknown>) {
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name))
    throw new AppError(400, "INVALID_CLIENT", "Укажите имя до 100 символов.");
  const phone = raw.phone
    ? normalizeIdentity({ kind: "phone", value: String(raw.phone) }).value
    : null;
  const email = raw.email
    ? normalizeIdentity({ kind: "email", value: String(raw.email) }).value
    : null;
  return { name, phone, email };
}
/** Only trusted platform updates or verified contact proofs may provide identities. */
export async function matchClient(
  tx: Transaction<Database>,
  businessId: string,
  input: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    identities: Identity[];
  },
) {
  const business = await tx
    .selectFrom("business")
    .select("id")
    .where("id", "=", businessId)
    .where("archived_at", "is", null)
    .forUpdate()
    .executeTakeFirst();
  if (!business)
    throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
  const identities = input.identities.map(normalizeIdentity);
  const ids = new Set<string>();
  for (const i of identities) {
    const found = await tx
      .selectFrom("client_identity as i")
      .innerJoin("client as c", (join) =>
        join
          .onRef("c.id", "=", "i.client_id")
          .onRef("c.business_id", "=", "i.business_id"),
      )
      .select("i.client_id")
      .where("i.business_id", "=", businessId)
      .where("i.kind", "=", i.kind)
      .where("i.value", "=", i.value)
      .where("c.archived_at", "is", null)
      .executeTakeFirst();
    if (found) ids.add(found.client_id);
  }
  if (ids.size > 1)
    throw new AppError(
      409,
      "CLIENT_IDENTITY_CONFLICT",
      "Идентификаторы принадлежат разным клиентам. Требуется проверка сотрудником.",
    );
  const id = [...ids][0] ?? randomUUID();
  const now = new Date();
  if (ids.size === 0)
    await tx
      .insertInto("client")
      .values({
        id,
        business_id: businessId,
        name: input.name?.trim().slice(0, 100) || "Клиент",
        phone: input.phone ?? null,
        email: input.email ?? null,
      })
      .execute();
  else
    await tx
      .updateTable("client")
      .set({
        last_seen_at: now,
        updated_at: now,
        ...(input.name ? { name: input.name.trim().slice(0, 100) } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        ...(input.email ? { email: input.email } : {}),
      })
      .where("id", "=", id)
      .where("business_id", "=", businessId)
      .execute();
  for (const i of identities)
    await tx
      .insertInto("client_identity")
      .values({
        business_id: businessId,
        client_id: id,
        kind: i.kind,
        value: i.value,
        username: i.username ?? null,
      })
      .onConflict((oc) =>
        oc
          .columns(["business_id", "kind", "value"])
          .doUpdateSet({ username: i.username ?? null }),
      )
      .execute();
  return id;
}
export async function clientActivity(
  tx: Transaction<Database>,
  businessId: string,
  clientId: string,
  type: string,
  eventKey: string,
  targetId: string | null = null,
  actorId: string | null = null,
  metadata: Record<string, unknown> | null = null,
) {
  await tx
    .insertInto("client_activity")
    .values({
      id: randomUUID(),
      business_id: businessId,
      client_id: clientId,
      type,
      event_key: eventKey,
      target_id: targetId,
      actor_user_id: actorId,
      ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    })
    .onConflict((oc) => oc.columns(["business_id", "event_key"]).doNothing())
    .execute();
}
export class ClientService {
  constructor(private db: Kysely<Database>) {}
  async list(
    userId: string,
    publicId: string,
    search = "",
    before?: string,
    filter = "all",
  ) {
    const b = await requireBusiness(this.db, userId, publicId, "clients.read");
    let q = this.db
      .selectFrom("client as c")
      .selectAll("c")
      .where("c.business_id", "=", b.id)
      .where("c.archived_at", "is", null)
      .orderBy("c.id")
      .limit(100);
    if (!["all", "new", "active", "leads", "bookings", "open"].includes(filter))
      throw new AppError(400, "INVALID_FILTER", "Проверьте фильтр.");
    if (filter === "new")
      q = q.where("c.first_seen_at", ">=", new Date(Date.now() - 7 * 86400000));
    if (filter === "active")
      q = q.where("c.last_seen_at", ">=", new Date(Date.now() - 30 * 86400000));
    if (filter === "leads")
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom("lead")
            .select("id")
            .whereRef("client_id", "=", "c.id")
            .whereRef("business_id", "=", "c.business_id"),
        ),
      );
    if (filter === "bookings")
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom("booking")
            .select("id")
            .whereRef("client_id", "=", "c.id")
            .whereRef("business_id", "=", "c.business_id"),
        ),
      );
    if (filter === "open")
      q = q.where((eb) =>
        eb.exists(
          eb
            .selectFrom("communication_conversation")
            .select("id")
            .whereRef("client_id", "=", "c.id")
            .whereRef("business_id", "=", "c.business_id")
            .where("status", "in", ["open", "assigned"]),
        ),
      );
    if (search.length > 100)
      throw new AppError(400, "INVALID_SEARCH", "Слишком длинный запрос.");
    if (search)
      q = q.where((eb) =>
        eb.or([
          eb("c.name", "ilike", "%" + search + "%"),
          eb("c.phone", "ilike", "%" + search + "%"),
          eb.exists(
            eb
              .selectFrom("client_identity as i")
              .select("i.client_id")
              .whereRef("i.client_id", "=", "c.id")
              .whereRef("i.business_id", "=", "c.business_id")
              .where("i.username", "ilike", "%" + search + "%"),
          ),
        ]),
      );
    if (before) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          before,
        )
      )
        throw new AppError(400, "INVALID_CURSOR", "Обновите список.");
      q = q.where("c.id", ">", before);
    }
    return Promise.all(
      (await q.execute()).map(async (c) => ({
        ...c,
        identities: await this.db
          .selectFrom("client_identity")
          .select(["kind", "value", "username"])
          .where("business_id", "=", b.id)
          .where("client_id", "=", c.id)
          .execute(),
        lead_count: Number(
          (
            await this.db
              .selectFrom("lead")
              .select(({ fn }) => fn.countAll().as("n"))
              .where("business_id", "=", b.id)
              .where("client_id", "=", c.id)
              .executeTakeFirstOrThrow()
          ).n,
        ),
        booking_count: Number(
          (
            await this.db
              .selectFrom("booking")
              .select(({ fn }) => fn.countAll().as("n"))
              .where("business_id", "=", b.id)
              .where("client_id", "=", c.id)
              .executeTakeFirstOrThrow()
          ).n,
        ),
        open_dialog: !!(await this.db
          .selectFrom("communication_conversation")
          .select("id")
          .where("business_id", "=", b.id)
          .where("client_id", "=", c.id)
          .where("status", "in", ["open", "assigned"])
          .executeTakeFirst()),
      })),
    );
  }
  async detail(userId: string, publicId: string, id: string, page = 0) {
    if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
      throw new AppError(400, "INVALID_PAGE", "Проверьте страницу истории.");
    const b = await requireBusiness(this.db, userId, publicId, "clients.read");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    const client = await this.db
      .selectFrom("client")
      .selectAll()
      .where("business_id", "=", b.id)
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (!client)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    const [identities, leads, conversations, activity, notes, bookings, orders] =
      await Promise.all([
        this.db
          .selectFrom("client_identity")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .execute(),
        this.db
          .selectFrom("lead")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(100)
          .offset(page * 100)
          .execute(),
        this.db
          .selectFrom("communication_conversation")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .execute(),
        this.db
          .selectFrom("client_activity")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(100)
          .offset(page * 100)
          .execute(),
        this.db
          .selectFrom("client_note")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(100)
          .offset(page * 100)
          .execute(),
        this.db
          .selectFrom("booking as k")
          .innerJoin("booking_service as s", "s.id", "k.service_id")
          .innerJoin("booking_specialist as r", "r.id", "k.specialist_id")
          .selectAll("k")
          .select(["s.name as service_name", "r.name as specialist_name"])
          .where("k.business_id", "=", b.id)
          .where("k.client_id", "=", id)
          .orderBy("k.starts_at", "desc")
          .orderBy("k.id", "desc")
          .limit(100)
          .offset(page * 100)
          .execute(),
        this.db
          .selectFrom("order")
          .selectAll()
          .where("business_id", "=", b.id)
          .where("client_id", "=", id)
          .orderBy("created_at", "desc")
          .orderBy("id", "desc")
          .limit(100)
          .offset(page * 100)
          .execute(),
      ]);
    return {
      hasMore: [leads, activity, notes, bookings, orders].some(
        (rows) => rows.length === 100,
      ),
      client,
      identities,
      leads,
      conversations,
      activity,
      notes,
      bookings,
      orders,
    };
  }
  async save(
    userId: string,
    publicId: string,
    raw: Record<string, unknown>,
    id?: string,
  ) {
    if (id !== undefined) requireUuid(id);
    const input = clientInput(raw);
    const profileNoteRaw =
      typeof raw.profileNote === "string"
        ? raw.profileNote
        : typeof raw.profile_note === "string"
          ? raw.profile_note
          : undefined;
    const profileNote =
      profileNoteRaw !== undefined
        ? profileNoteRaw.trim().slice(0, 4000) || null
        : undefined;
    const noteText =
      typeof raw.note === "string" ? raw.note.trim().slice(0, 4000) : "";
    const tagIds = Array.isArray(raw.tagIds)
      ? raw.tagIds.filter(
          (v): v is string =>
            typeof v === "string" &&
            /^[0-9a-f-]{36}$/i.test(v),
        )
      : [];
    const tagNames = Array.isArray(raw.tags)
      ? raw.tags
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter((v) => v.length > 0 && v.length <= 40)
      : [];
    const assignedRaw =
      raw.assignedUserId ?? raw.assigned_user_id ?? undefined;

    return this.db.transaction().execute(async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "clients.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "clients.write");

      let assignedUserId: string | null | undefined;
      if (assignedRaw === null || assignedRaw === "") {
        assignedUserId = null;
      } else if (typeof assignedRaw === "string") {
        requireUuid(assignedRaw);
        const member = await tx
          .selectFrom("business_member")
          .select("user_id")
          .where("business_id", "=", b.id)
          .where("user_id", "=", assignedRaw)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (!member)
          throw new AppError(
            400,
            "INVALID_ASSIGNEE",
            "Сотрудник недоступен в этом бизнесе.",
          );
        const isOwnerAdmin = b.role === "owner" || b.role === "admin";
        if (!isOwnerAdmin && assignedRaw !== userId)
          throw new AppError(
            403,
            "FORBIDDEN",
            "Оператор может назначить клиента только на себя.",
          );
        assignedUserId = assignedRaw;
      }

      const now = new Date();
      if (id) {
        const patch: Record<string, unknown> = {
          ...input,
          updated_at: now,
        };
        if (profileNote !== undefined) patch.profile_note = profileNote;
        if (assignedUserId !== undefined) {
          patch.assigned_user_id = assignedUserId;
          patch.assigned_at = assignedUserId ? now : null;
        }
        const changed = await tx
          .updateTable("client")
          .set(patch)
          .where("business_id", "=", b.id)
          .where("id", "=", id)
          .where("archived_at", "is", null)
          .returning("id")
          .executeTakeFirst();
        if (!changed)
          throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
        await clientActivity(
          tx,
          b.id,
          id,
          "client.updated",
          randomUUID(),
          id,
          userId,
        );
      } else {
        id = randomUUID();
        await tx
          .insertInto("client")
          .values({
            id,
            business_id: b.id,
            name: input.name,
            phone: input.phone,
            email: input.email,
            profile_note: profileNote ?? null,
            assigned_user_id: assignedUserId ?? null,
            assigned_at: assignedUserId ? now : null,
          })
          .execute();
        await clientActivity(
          tx,
          b.id,
          id,
          "client.created",
          `client-created:${id}`,
          id,
          userId,
        );
        if (assignedUserId) {
          await clientActivity(
            tx,
            b.id,
            id,
            "client.assigned",
            `client-assign:${id}:${assignedUserId}`,
            assignedUserId,
            userId,
          );
        }
      }

      for (const tagId of tagIds) {
        const tag = await tx
          .selectFrom("client_tag")
          .select("id")
          .where("business_id", "=", b.id)
          .where("id", "=", tagId)
          .executeTakeFirst();
        if (!tag) continue;
        await tx
          .insertInto("client_tag_link")
          .values({
            business_id: b.id,
            client_id: id!,
            tag_id: tagId,
          })
          .onConflict((oc) =>
            oc.columns(["business_id", "client_id", "tag_id"]).doNothing(),
          )
          .execute();
      }
      for (const name of tagNames) {
        const normalized = normalizeTagName(name);
        let tag = await tx
          .selectFrom("client_tag")
          .select("id")
          .where("business_id", "=", b.id)
          .where("name_normalized", "=", normalized)
          .executeTakeFirst();
        if (!tag) {
          tag = await tx
            .insertInto("client_tag")
            .values({
              id: randomUUID(),
              business_id: b.id,
              name,
              name_normalized: normalized,
              color_key: "neutral",
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        }
        await tx
          .insertInto("client_tag_link")
          .values({
            business_id: b.id,
            client_id: id!,
            tag_id: tag.id,
          })
          .onConflict((oc) =>
            oc.columns(["business_id", "client_id", "tag_id"]).doNothing(),
          )
          .execute();
      }

      if (noteText) {
        const note = await tx
          .insertInto("client_note")
          .values({
            id: randomUUID(),
            business_id: b.id,
            client_id: id!,
            actor_user_id: userId,
            text: noteText,
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        await clientActivity(
          tx,
          b.id,
          id!,
          "client.note_added",
          `client-note:${note.id}`,
          note.id,
          userId,
        );
      }

      return { id: id! };
    });
  }
  async note(userId: string, publicId: string, id: string, value: unknown) {
    requireUuid(id);
    if (typeof value !== "string" || !value.trim() || value.length > 4000)
      throw new AppError(
        400,
        "INVALID_NOTE",
        "Введите заметку до 4000 символов.",
      );
    return this.db.transaction().execute(async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "clients.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "clients.write");
      const c = await tx
        .selectFrom("client")
        .select("id")
        .where("business_id", "=", b.id)
        .where("id", "=", id)
        .where("archived_at", "is", null)
        .executeTakeFirst();
      if (!c) throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
      const note = await tx
        .insertInto("client_note")
        .values({
          id: randomUUID(),
          business_id: b.id,
          client_id: id,
          actor_user_id: userId,
          text: value.trim(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await clientActivity(
        tx,
        b.id,
        id,
        "client.note_added",
        `client-note:${note.id}`,
        note.id,
        userId,
      );
      return note;
    });
  }

  async merge(
    userId: string,
    publicId: string,
    raw: Record<string, unknown>,
  ) {
    const { mergeClients } = await import("./merge.ts");
    return mergeClients(this.db, userId, publicId, raw);
  }
}
