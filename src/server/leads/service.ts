import { localInstants } from "../booking/time.ts";
import { randomUUID } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type { Database, LeadStatus } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";

import { matchClient, clientActivity } from "../clients/service.ts";
import { notify, resolveByEventKey } from "../notifications/service.ts";
import { requireBusiness } from "../access/permissions.ts";
import { assertEntitlement } from "../billing/entitlement.ts";
import { assertLeadTransition, leadWaitMeta } from "./status.ts";
import { loadLeadSetupV2 } from "./setup.ts";
import { getLeadAnalytics, getLeadStatusCounts } from "./analytics.ts";

type Input = {
  source: "telegram" | "vk" | "max";
  name: string;
  phone?: string | null;
  message?: string | null;
  externalEventId?: string | null;
};
const statuses: LeadStatus[] = [
  "new",
  "processing",
  "waiting_customer",
  "completed",
  "rejected",
  "closed",
];

async function recordStatusHistory(
  tx: Transaction<Database>,
  businessId: string,
  leadId: string,
  fromStatus: string | null,
  toStatus: string,
  actorUserId: string | null,
  note = "",
) {
  await tx
    .insertInto("lead_status_history")
    .values({
      id: randomUUID(),
      business_id: businessId,
      lead_id: leadId,
      from_status: fromStatus,
      to_status: toStatus,
      actor_user_id: actorUserId,
      note,
    })
    .execute();
}
function clean(input: unknown): Input & { clientId?: string } {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new AppError(400, "INVALID_LEAD", "Проверьте данные заявки.");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "source",
          "name",
          "phone",
          "message",
          "externalEventId",
          "answers",
          "platformUserId",
          "username",
          "clientId",
          "client_id",
        ].includes(key),
    )
  )
    throw new AppError(400, "INVALID_LEAD", "Проверьте данные заявки.");
  if (!["telegram", "vk", "max"].includes(String(value.source)))
    throw new AppError(400, "INVALID_LEAD", "Неизвестный канал заявки.");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))
    throw new AppError(400, "INVALID_LEAD", "Укажите имя клиента.");
  const optional = (key: string, max: number) =>
    value[key] == null
      ? null
      : typeof value[key] === "string" && value[key].length <= max
        ? value[key].trim() || null
        : (() => {
            throw new AppError(400, "INVALID_LEAD", "Проверьте данные заявки.");
          })();
  const clientIdRaw = value.clientId ?? value.client_id;
  const clientId =
    typeof clientIdRaw === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      clientIdRaw,
    )
      ? clientIdRaw
      : undefined;
  return {
    source: value.source as Input["source"],
    name,
    phone: optional("phone", 40),
    message: optional("message", 2000),
    externalEventId: optional("externalEventId", 200),
    ...(clientId ? { clientId } : {}),
  };
}

function emailFromAnswers(answers: Record<string, unknown> | undefined) {
  const v = answers?.email;
  return typeof v === "string" && v ? v : null;
}

export class LeadService {
  constructor(private readonly db: Kysely<Database>) {}
  private async resolve(userId: string, publicId: string) {
    const row = await this.db
      .selectFrom("business_member")
      .innerJoin("business", "business.id", "business_member.business_id")
      .select("business.id")
      .where("business.public_id", "=", publicId)
      .where("business.archived_at", "is", null)
      .where("business_member.user_id", "=", userId)
      .where("business_member.status", "=", "active")
      .executeTakeFirst();
    if (!row)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
    return row.id;
  }
  async assignees(userId: string, publicId: string) {
    const business = await requireBusiness(
      this.db,
      userId,
      publicId,
      "leads.write",
    );
    return this.db
      .selectFrom("business_member as member")
      .innerJoin("user", "user.id", "member.user_id")
      .select([
        "user.id",
        "user.name",
        "member.role",
      ])
      .where("member.business_id", "=", business.id)
      .where("member.status", "=", "active")
      .orderBy("user.name")
      .orderBy("user.id")
      .execute();
  }

  async list(
    userId: string,
    businessId: string,
    status?: LeadStatus,
    before?: string,
    filters: {
      search?: string;
      source?: string;
      from?: string;
      until?: string;
      processingBy?: string;
    } = {},
  ) {
    const publicBusinessId = businessId;
    businessId = await this.resolve(userId, businessId);
    if (status && !statuses.includes(status))
      throw new AppError(400, "INVALID_STATUS", "Неизвестный статус.");
    const { setup } = await loadLeadSetupV2(this.db, businessId);
    const sla = setup.processing.firstResponseSlaMinutes;
    // API dates have millisecond precision; cursor ordering must use the same precision.
    const created = sql<Date>`date_trunc('milliseconds', lead.created_at)`;
    let query = this.db
      .selectFrom("lead")
      .leftJoin("user", "user.id", "lead.processing_by")
      .select([
        "lead.id",
        "lead.business_id",
        "lead.client_id",
        "lead.source",
        "lead.name",
        "lead.phone",
        "lead.message",
        "lead.status",
        "lead.external_event_id",
        "lead.answers",
        "lead.processing_by",
        "lead.processing_at",
        "lead.created_at",
        "lead.updated_at",
        "user.name as processing_name",
      ])
      .where("lead.business_id", "=", businessId)
      .orderBy(created, "desc")
      .orderBy("lead.id", "desc")
      .limit(100);
    if (before) {
      const [date, id, extra] = before.split("|");
      if (
        !date ||
        !id ||
        extra !== undefined ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        )
      )
        throw new AppError(400, "INVALID_CURSOR", "Обновите список заявок.");
      query = query.where((eb) =>
        eb.or([
          eb(created, "<", new Date(date)),
          eb.and([eb(created, "=", new Date(date)), eb("lead.id", "<", id)]),
        ]),
      );
    }
    if (filters.search) {
      if (filters.search.length > 100)
        throw new AppError(400, "INVALID_SEARCH", "Слишком длинный запрос.");
      query = query.where((eb) =>
        eb.or([
          eb("lead.name", "ilike", "%" + filters.search + "%"),
          eb("lead.phone", "ilike", "%" + filters.search + "%"),
        ]),
      );
    }
    if (filters.source) {
      if (!["telegram", "vk", "max"].includes(filters.source))
        throw new AppError(400, "INVALID_SOURCE", "Проверьте источник.");
      query = query.where(
        "lead.source",
        "=",
        filters.source as Input["source"],
      );
    }
    if (filters.processingBy) {
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          filters.processingBy,
        )
      )
        throw new AppError(400, "INVALID_ASSIGNEE", "Проверьте ответственного.");
      query = query.where("lead.processing_by", "=", filters.processingBy);
    }
    const periodTimezone =
      filters.from || filters.until
        ? (
            await this.db
              .selectFrom("business")
              .select("timezone")
              .where("id", "=", businessId)
              .executeTakeFirstOrThrow()
          ).timezone
        : null;

    if (filters.from) {
      const value = filters.from;
      if (!Number.isFinite(Date.parse(value)))
        throw new AppError(400, "INVALID_DATE", "Проверьте период.");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
        ? localInstants(value, 0, periodTimezone!)[0]
        : new Date(value);
      if (!date)
        throw new AppError(
          400,
          "INVALID_DATE",
          "Эта дата недоступна в часовом поясе бизнеса.",
        );
      query = query.where("lead.created_at", ">=", date);
    }

    if (filters.until) {
      const value = filters.until;
      if (!Number.isFinite(Date.parse(value)))
        throw new AppError(400, "INVALID_DATE", "Проверьте период.");
      let date: Date | undefined;
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const noonUtc = new Date(value + "T12:00:00Z");
        noonUtc.setUTCDate(noonUtc.getUTCDate() + 1);
        const nextLocalDate = noonUtc.toISOString().slice(0, 10);
        date = localInstants(nextLocalDate, 0, periodTimezone!)[0];
      } else {
        date = new Date(value);
      }
      if (!date)
        throw new AppError(
          400,
          "INVALID_DATE",
          "Эта дата недоступна в часовом поясе бизнеса.",
        );
      // A date-only «По дату» filter is inclusive: < local midnight of next day.
      query = query.where("lead.created_at", "<", date);
    }
    if (status) query = query.where("lead.status", "=", status) as typeof query;
    const rows = await query.execute();
    return rows.map((lead) => {
      const wait = leadWaitMeta(
        lead.created_at,
        lead.processing_at,
        sla,
      );
      return {
        ...this.toLead(
          {
            id: lead.id,
            business_id: lead.business_id,
            client_id: lead.client_id,
            source: lead.source,
            name: lead.name,
            phone: lead.phone,
            message: lead.message,
            status: lead.status,
            external_event_id: lead.external_event_id,
            answers: lead.answers,
            processing_by: lead.processing_by,
            processing_at: lead.processing_at,
            created_at: lead.created_at,
            updated_at: lead.updated_at,
          },
          publicBusinessId,
        ),
        processingName: lead.processing_name ?? undefined,
        waitLabel: wait.label,
        waitedMinutes: wait.waitedMinutes,
        overdue: wait.overdue,
      };
    });
  }

  async summary(
    userId: string,
    publicId: string,
    periodDays: 1 | 7 | 30 = 7,
  ) {
    const businessId = await this.resolve(userId, publicId);
    const since = new Date(Date.now() - periodDays * 86400000);
    const [counts, analytics] = await Promise.all([
      getLeadStatusCounts(this.db, businessId, since),
      getLeadAnalytics(this.db, businessId, periodDays),
    ]);
    return { periodDays, counts, analytics };
  }

  async get(userId: string, publicId: string, leadId: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        leadId,
      )
    )
      throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
    const businessId = await this.resolve(userId, publicId);
    const lead = await this.db
      .selectFrom("lead")
      .leftJoin("user", "user.id", "lead.processing_by")
      .select([
        "lead.id",
        "lead.business_id",
        "lead.client_id",
        "lead.source",
        "lead.name",
        "lead.phone",
        "lead.message",
        "lead.status",
        "lead.external_event_id",
        "lead.answers",
        "lead.processing_by",
        "lead.processing_at",
        "lead.created_at",
        "lead.updated_at",
        "user.name as processing_name",
      ])
      .where("lead.business_id", "=", businessId)
      .where("lead.id", "=", leadId)
      .executeTakeFirst();
    if (!lead) throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");

    const { setup } = await loadLeadSetupV2(this.db, businessId);
    const fieldRows = await this.db
      .selectFrom("lead_form_field")
      .select(["field_key", "label", "field_type"])
      .where("business_id", "=", businessId)
      .execute();
    const labelByKey = new Map(fieldRows.map((f) => [f.field_key, f.label]));
    const typeByKey = new Map(
      fieldRows.map((f) => [f.field_key, f.field_type]),
    );

    const history = await this.db
      .selectFrom("lead_status_history")
      .leftJoin("user", "user.id", "lead_status_history.actor_user_id")
      .select([
        "lead_status_history.id",
        "lead_status_history.from_status",
        "lead_status_history.to_status",
        "lead_status_history.note",
        "lead_status_history.created_at",
        "user.name as actor_name",
      ])
      .where("lead_status_history.business_id", "=", businessId)
      .where("lead_status_history.lead_id", "=", leadId)
      .orderBy("lead_status_history.created_at", "asc")
      .execute();

    const duplicate = setup.processing.duplicateDetection
      ? await this.findPossibleDuplicate(businessId, lead, leadId)
      : null;

    const wait = leadWaitMeta(
      lead.created_at,
      lead.processing_at,
      setup.processing.firstResponseSlaMinutes,
    );

    const answers =
      lead.answers && typeof lead.answers === "object"
        ? (lead.answers as Record<string, unknown>)
        : {};

    const attachmentIds = [
      ...new Set(
        Object.entries(answers).flatMap(([key, value]) => {
          if (typeByKey.get(key) !== "attachment") return [];
          const values = Array.isArray(value) ? value : [value];
          return values.filter(
            (item): item is string =>
              typeof item === "string" &&
              /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                item,
              ),
          );
        }),
      ),
    ];
    const attachmentRows = attachmentIds.length
      ? await this.db
          .selectFrom("attachment")
          .select(["id", "filename", "type"])
          .where("business_id", "=", businessId)
          .where("id", "in", attachmentIds)
          .execute()
      : [];
    const attachmentById = new Map(
      attachmentRows.map((row) => [row.id, row]),
    );

    const answerFields = Object.entries(answers).map(([key, value]) => {
      if (typeByKey.get(key) !== "attachment") {
        return {
          key,
          label: labelByKey.get(key) || key,
          value,
        };
      }
      const values = Array.isArray(value) ? value : [value];
      const files = values
        .filter((item): item is string => typeof item === "string")
        .map((id) => attachmentById.get(id))
        .filter((row): row is NonNullable<typeof row> => Boolean(row))
        .map((row) => ({
          id: row.id,
          name: row.filename,
          type: row.type,
          url:
            `/api/v1/businesses/${encodeURIComponent(publicId)}/attachments/${encodeURIComponent(row.id)}`,
        }));
      return {
        key,
        label: labelByKey.get(key) || key,
        value: files,
      };
    });

    return {
      ...this.toLead(
        {
          id: lead.id,
          business_id: lead.business_id,
          client_id: lead.client_id,
          source: lead.source,
          name: lead.name,
          phone: lead.phone,
          message: lead.message,
          status: lead.status,
          external_event_id: lead.external_event_id,
          answers: lead.answers,
          processing_by: lead.processing_by,
          processing_at: lead.processing_at,
          created_at: lead.created_at,
          updated_at: lead.updated_at,
        },
        publicId,
      ),
      processingName: lead.processing_name ?? undefined,
      waitLabel: wait.label,
      waitedMinutes: wait.waitedMinutes,
      overdue: wait.overdue,
      answerFields,
      history: history.map((h) => ({
        id: h.id,
        fromStatus: h.from_status,
        toStatus: h.to_status,
        note: h.note,
        actorName: h.actor_name ?? null,
        createdAt: h.created_at.toISOString(),
      })),
      possibleDuplicate: duplicate
        ? { id: duplicate.id, createdAt: duplicate.created_at.toISOString() }
        : null,
    };
  }

  private async findPossibleDuplicate(
    businessId: string,
    lead: {
      client_id: string | null;
      phone: string | null;
      source: string;
      created_at: Date;
    },
    excludeId: string,
  ) {
    const since = new Date(Date.now() - 30 * 86400000);
    let query = this.db
      .selectFrom("lead")
      .select(["id", "created_at"])
      .where("business_id", "=", businessId)
      .where("id", "!=", excludeId)
      .where("created_at", ">=", since)
      .orderBy("created_at", "desc")
      .limit(1);
    if (lead.client_id) {
      query = query.where("client_id", "=", lead.client_id);
    } else if (lead.phone) {
      query = query.where("phone", "=", lead.phone);
    } else {
      return null;
    }
    return query.executeTakeFirst();
  }

  async create(userId: string, publicId: string, raw: unknown) {
    const input = clean(raw);
    const answers =
      raw &&
      typeof raw === "object" &&
      (raw as { answers?: unknown }).answers &&
      typeof (raw as { answers: unknown }).answers === "object"
        ? ((raw as { answers: Record<string, unknown> }).answers as Record<
            string,
            unknown
          >)
        : undefined;
    return this.db.transaction().execute(async (tx) => {
      const b = await requireBusiness(tx, userId, publicId, "leads.write");
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", b.id)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, publicId, "leads.write");
      const lead = await createLead(tx, b.id, { ...input, answers });
      return this.toLead(lead, publicId);
    });
  }
  async assign(
    userId: string,
    publicId: string,
    leadId: string,
    assigneeId: unknown,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        leadId,
      )
    )
      throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
    if (
      typeof assigneeId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        assigneeId,
      )
    )
      throw new AppError(400, "INVALID_ASSIGNEE", "Выберите сотрудника.");

    return this.db.transaction().execute(async (tx) => {
      const business = await requireBusiness(tx, userId, publicId, "leads.write");
      if (business.role !== "owner" && business.role !== "admin")
        throw new AppError(
          403,
          "FORBIDDEN",
          "Передавать заявки может владелец или администратор.",
        );

      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", business.id)
        .forUpdate()
        .execute();

      const target = await tx
        .selectFrom("business_member as member")
        .innerJoin("user", "user.id", "member.user_id")
        .select(["user.id", "user.name"])
        .where("member.business_id", "=", business.id)
        .where("member.user_id", "=", assigneeId)
        .where("member.status", "=", "active")
        .where("member.role", "in", ["owner", "admin", "operator"])
        .executeTakeFirst();
      if (!target)
        throw new AppError(
          400,
          "INVALID_ASSIGNEE",
          "Сотрудник недоступен.",
        );

      const current = await tx
        .selectFrom("lead")
        .selectAll()
        .where("business_id", "=", business.id)
        .where("id", "=", leadId)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
      if (["completed", "rejected", "closed"].includes(current.status))
        throw new AppError(
          409,
          "LEAD_CLOSED",
          "Завершённую заявку нельзя передать.",
        );
      if (
        current.processing_by === assigneeId &&
        current.status !== "new"
      )
        return this.toLead(current, publicId);

      const nextStatus: LeadStatus =
        current.status === "new" ? "processing" : current.status;
      const row = await tx
        .updateTable("lead")
        .set({
          processing_by: assigneeId,
          processing_at: current.processing_at ?? new Date(),
          status: nextStatus,
          updated_at: new Date(),
        })
        .where("business_id", "=", business.id)
        .where("id", "=", leadId)
        .returningAll()
        .executeTakeFirstOrThrow();

      await recordStatusHistory(
        tx,
        business.id,
        leadId,
        current.status,
        nextStatus,
        userId,
        current.status === nextStatus
          ? `Передано сотруднику: ${target.name}`
          : `Назначено сотруднику: ${target.name}`,
      );
      await tx
        .insertInto("business_audit_log")
        .values({
          id: randomUUID(),
          business_id: business.id,
          actor_user_id: userId,
          action: "lead_taken",
          target_user_id: assigneeId,
          details: leadId,
        })
        .execute();
      if (row.client_id)
        await clientActivity(
          tx,
          business.id,
          row.client_id,
          "lead.assigned",
          randomUUID(),
          leadId,
          userId,
        );

      return this.toLead(row, publicId);
    });
  }

  async updateStatus(
    userId: string,
    businessId: string,
    id: string,
    status: unknown,
  ) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
    if (typeof status !== "string" || !statuses.includes(status as LeadStatus))
      throw new AppError(400, "INVALID_STATUS", "Неизвестный статус.");
    const internalBusinessId = await this.resolve(userId, businessId);
    const membership = await this.db
      .selectFrom("business_member")
      .select("business_id")
      .where("business_id", "=", internalBusinessId)
      .where("user_id", "=", userId)
      .where("status", "=", "active")
      .where("role", "in", ["owner", "admin", "operator"])
      .executeTakeFirst();
    if (!membership)
      throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
    return this.db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("business")
        .select("id")
        .where("id", "=", internalBusinessId)
        .forUpdate()
        .execute();
      await requireBusiness(tx, userId, businessId, "leads.write");
      const current = await tx
        .selectFrom("lead")
        .selectAll()
        .where("business_id", "=", internalBusinessId)
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!current)
        throw new AppError(404, "LEAD_NOT_FOUND", "Заявка не найдена.");
      const next = status as LeadStatus;
      assertLeadTransition(current.status, next);

      // Concurrency: taking into processing — only one winner.
      if (next === "processing") {
        if (current.processing_by && current.processing_by !== userId) {
          const holder = await tx
            .selectFrom("user")
            .select("name")
            .where("id", "=", current.processing_by)
            .executeTakeFirst();
          throw new AppError(
            409,
            "LEAD_ASSIGNED",
            holder?.name
              ? `Заявка уже в работе у ${holder.name}.`
              : "Заявка уже в работе у другого сотрудника.",
          );
        }
        const claimed = await tx
          .updateTable("lead")
          .set({
            status: next,
            updated_at: new Date(),
            processing_by: userId,
            processing_at: current.processing_at ?? new Date(),
          })
          .where("id", "=", id)
          .where((eb) =>
            eb.or([
              eb("processing_by", "is", null),
              eb("processing_by", "=", userId),
            ]),
          )
          .returningAll()
          .executeTakeFirst();
        if (!claimed) {
          throw new AppError(
            409,
            "LEAD_ASSIGNED",
            "Заявка уже в работе у другого сотрудника.",
          );
        }
        if (current.status !== next) {
          await recordStatusHistory(
            tx,
            internalBusinessId,
            id,
            current.status,
            next,
            userId,
            "Взял в работу",
          );
          if (claimed.client_id)
            await clientActivity(
              tx,
              internalBusinessId,
              claimed.client_id,
              "lead." + next,
              randomUUID(),
              id,
              userId,
            );
          await tx
            .insertInto("business_audit_log")
            .values({
              id: randomUUID(),
              business_id: internalBusinessId,
              actor_user_id: userId,
              action: "lead_taken",
              target_user_id: null,
              details: id,
            })
            .execute();
        }
        return this.toLead(claimed, businessId);
      }

      if (current.processing_by && current.processing_by !== userId) {
        // Owner/admin reassignment path is not silent steal — require same assignee
        // for working transitions unless releasing to new.
        const member = await tx
          .selectFrom("business_member")
          .select("role")
          .where("business_id", "=", internalBusinessId)
          .where("user_id", "=", userId)
          .where("status", "=", "active")
          .executeTakeFirst();
        if (member?.role !== "owner" && member?.role !== "admin") {
          const holder = await tx
            .selectFrom("user")
            .select("name")
            .where("id", "=", current.processing_by)
            .executeTakeFirst();
          throw new AppError(
            409,
            "LEAD_ASSIGNED",
            holder?.name
              ? `Заявка уже в работе у ${holder.name}.`
              : "Заявка уже в работе у другого сотрудника.",
          );
        }
      }

      const row = await tx
        .updateTable("lead")
        .set({
          status: next,
          updated_at: new Date(),
          ...(next === "new"
            ? { processing_by: null, processing_at: null }
            : {}),
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (current.status !== next) {
        await recordStatusHistory(
          tx,
          internalBusinessId,
          id,
          current.status,
          next,
          userId,
        );
        if (row.client_id)
          await clientActivity(
            tx,
            internalBusinessId,
            row.client_id,
            "lead." + next,
            randomUUID(),
            id,
            userId,
          );
        if (next === "closed" || next === "completed" || next === "rejected")
          await tx
            .insertInto("business_audit_log")
            .values({
              id: randomUUID(),
              business_id: internalBusinessId,
              actor_user_id: userId,
              action: "lead_closed",
              target_user_id: null,
              details: id,
            })
            .execute();
        if (next === "closed" || next === "completed" || next === "rejected")
          await resolveByEventKey(tx, internalBusinessId, "lead:" + id);
      }
      return this.toLead(row, businessId);
    });
  }
  private toLead(lead: Selectable<Database["lead"]>, businessId: string) {
    return {
      id: lead.id,
      businessId,
      source: lead.source,
      name: lead.name,
      phone: lead.phone ?? undefined,
      message: lead.message ?? undefined,
      status: lead.status,
      clientId: lead.client_id,
      processingBy: lead.processing_by,
      processingAt: lead.processing_at?.toISOString(),
      answers: lead.answers,
      updatedAt: lead.updated_at.toISOString(),
      createdAt: lead.created_at.toISOString(),
    };
  }
}

export async function createLead(
  tx: Transaction<Database>,
  businessId: string,
  input: Input & {
    platformUserId?: string;
    username?: string;
    answers?: Record<string, unknown>;
    clientId?: string;
  },
) {
  await tx
    .selectFrom("business")
    .select("id")
    .where("id", "=", businessId)
    .forUpdate()
    .execute();
  await assertEntitlement(tx, businessId, "leads");
  if (input.externalEventId) {
    const existing = await tx
      .selectFrom("lead")
      .selectAll()
      .where("business_id", "=", businessId)
      .where("source", "=", input.source)
      .where("external_event_id", "=", input.externalEventId)
      .executeTakeFirst();
    if (existing) return existing;
  }
  let clientId = input.clientId;
  if (clientId) {
    const existingClient = await tx
      .selectFrom("client")
      .select("id")
      .where("business_id", "=", businessId)
      .where("id", "=", clientId)
      .where("archived_at", "is", null)
      .executeTakeFirst();
    if (!existingClient)
      throw new AppError(404, "CLIENT_NOT_FOUND", "Клиент не найден.");
    // Touch last_seen — this is a client-facing lead action.
    await tx
      .updateTable("client")
      .set({ last_seen_at: new Date(), updated_at: new Date() })
      .where("business_id", "=", businessId)
      .where("id", "=", clientId)
      .execute();
  } else {
    clientId = await matchClient(tx, businessId, {
      name: input.name,
      phone: input.phone,
      email: emailFromAnswers(input.answers),
      identities:
        input.platformUserId && input.source !== "max"
          ? [
              {
                kind: input.source,
                value: input.platformUserId,
                username: input.username,
              },
            ]
          : [],
    });
  }
  const lead = await tx
    .insertInto("lead")
    .values({
      id: randomUUID(),
      business_id: businessId,
      client_id: clientId,
      source: input.source,
      name: input.name,
      phone: input.phone ?? null,
      message: input.message ?? null,
      status: "new",
      external_event_id: input.externalEventId ?? null,
      answers: JSON.stringify(input.answers ?? {}),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordStatusHistory(tx, businessId, lead.id, null, "new", null);
  await clientActivity(
    tx,
    businessId,
    clientId,
    "lead.created",
    "lead:" + lead.id,
    lead.id,
  );
  const serviceHint =
    typeof input.answers?.service === "string" ? input.answers.service : "";
  await notify(
    tx,
    businessId,
    "lead.created",
    "lead:" + lead.id,
    "Новая заявка: " +
      input.name +
      "\nТелефон: " +
      (input.phone || "—") +
      "\nИсточник: " +
      input.source +
      (serviceHint ? "\nУслуга: " + serviceHint : ""),
    "/leads?id=" + lead.id,
  );
  return lead;
}
