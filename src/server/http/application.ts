import { limit } from "./limits.ts";
import type { Identity } from "../identity/auth.ts";
import type { WorkspaceService } from "../workspaces/service.ts";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError, json, readJson, requireOrigin, respond } from "./errors.ts";

export function createApplication(options: {
  auth: Identity;
  workspaces: WorkspaceService;
  leads?: import("../leads/service.ts").LeadService;
  invitations?: import("../invitations/service.ts").InvitationService;
  connections?: import("../connections/service.ts").ConnectionService;
  communications?: import("../communications/service.ts").CommunicationService;
  db?: Kysely<Database>;
  secret?: string;
  origin: string;
}) {
  async function requireUser(headers: Headers) {
    const session = await options.auth.api.getSession({ headers });
    if (!session || !session.user.username)
      throw new AppError(401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    if (options.db) {
      const row = await options.db
        .selectFrom("user")
        .select(["deletion_status", "deleted_at"])
        .where("id", "=", session.user.id)
        .executeTakeFirst();
      if (
        !row ||
        row.deletion_status === "deleted" ||
        row.deleted_at != null
      )
        throw new AppError(401, "UNAUTHENTICATED", "Войдите в аккаунт.");
    }
    if (options.db && options.secret) {
      const relaxed = process.env.CI_RELAX_RATE_LIMITS === "1";
      await limit(
        options.db,
        options.secret,
        "api:" + session.user.id,
        relaxed ? 20_000 : 180,
        60,
      );
    }
    return session.user;
  }
  return {
    requireUser,
    me: (request: Request) =>
      respond(request, async () => {
        const user = await requireUser(request.headers);
        const publicUser = options.db
          ? await options.db
              .selectFrom("user")
              .select(["public_id", "name", "username"])
              .where("id", "=", user.id)
              .executeTakeFirst()
          : undefined;
        if (!publicUser)
          throw new AppError(
            503,
            "UNAVAILABLE",
            "Профиль временно недоступен.",
          );
        return json({
          id: publicUser.public_id,
          name: publicUser.name,
          username: publicUser.username,
        });
      }),
    businesses: (request: Request) =>
      respond(request, async () => {
        if (request.method === "POST") requireOrigin(request, options.origin);
        const user = await requireUser(request.headers);
        if (request.method === "GET")
          return json(await options.workspaces.list(user.id));
        const business = await options.workspaces.create(
          user.id,
          await readJson(request),
          request.headers.get("idempotency-key"),
        );
        return json(business, 201);
      }),
    business: (request: Request, id: string) =>
      respond(request, async () => {
        const user = await requireUser(request.headers);
        return json(await options.workspaces.require(user.id, id));
      }),
    leads: (request: Request, businessId: string) =>
      respond(request, async () => {
        if (!options.leads)
          throw new AppError(503, "UNAVAILABLE", "Раздел временно недоступен.");
        const user = await requireUser(request.headers);
        if (request.method === "GET") {
          const params = new URL(request.url).searchParams;
          if (params.get("view") === "assignees") {
            return json(await options.leads.assignees(user.id, businessId));
          }
          if (params.get("summary") === "1" || params.get("view") === "summary") {
            const days = Number(params.get("days") || 7);
            const periodDays = ([1, 7, 30].includes(days) ? days : 7) as
              | 1
              | 7
              | 30;
            return json(
              await options.leads.summary(user.id, businessId, periodDays),
            );
          }
          return json(
            await options.leads.list(
              user.id,
              businessId,
              (params.get("status") as never) || undefined,
              params.get("before") || undefined,
              {
                search: params.get("search") || undefined,
                source: params.get("source") || undefined,
                from: params.get("from") || undefined,
                until: params.get("until") || undefined,
                processingBy: params.get("processingBy") || undefined,
              },
            ),
          );
        }
        if (request.method === "POST") {
          requireOrigin(request, options.origin);
          return json(
            await options.leads.create(
              user.id,
              businessId,
              await readJson(request),
            ),
            201,
          );
        }
        throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
      }),
    leadStatus: (request: Request, businessId: string, leadId: string) =>
      respond(request, async () => {
        if (!options.leads)
          throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
        const user = await requireUser(request.headers);
        if (request.method === "GET") {
          return json(await options.leads.get(user.id, businessId, leadId));
        }
        if (request.method !== "PATCH")
          throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
        requireOrigin(request, options.origin);
        const body = await readJson(request);
        if (body.action === "assign") {
          return json(
            await options.leads.assign(
              user.id,
              businessId,
              leadId,
              body.assigneeId,
            ),
          );
        }
        return json(
          await options.leads.updateStatus(
            user.id,
            businessId,
            leadId,
            body.status,
          ),
        );
      }),
    conversations: (
      request: Request,
      businessId: string,
      conversationId?: string,
    ) =>
      respond(request, async () => {
        if (!options.communications)
          throw new AppError(503, "UNAVAILABLE", "Раздел временно недоступен.");
        const user = await requireUser(request.headers);
        if (request.method === "GET" && conversationId)
          return json(
            await options.communications.listMessages(
              user.id,
              businessId,
              conversationId,
              Number(new URL(request.url).searchParams.get("page") ?? 0),
            ),
          );
        if (request.method === "GET")
          return json(
            await options.communications.listConversations(
              user.id,
              businessId,
              (new URL(request.url).searchParams.get("status") as never) ||
                undefined,
              Number(new URL(request.url).searchParams.get("page") ?? 0),
              (new URL(request.url).searchParams.get("platform") as never) ||
                undefined,
            ),
          );
        if (
          !conversationId ||
          (request.method !== "POST" && request.method !== "PATCH")
        )
          throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
        requireOrigin(request, options.origin);
        if (request.method === "POST") {
          const body = await readJson(request, 65536);
          if (body && typeof body === "object" && (body as { internal?: unknown }).internal === true)
            return json(
              await options.communications.addInternalNote(
                user.id,
                businessId,
                conversationId,
                body,
              ),
            );
          return json(
            await options.communications.sendMessage(
              user.id,
              businessId,
              conversationId,
              body,
            ),
            202,
          );
        }
        return json(
          await options.communications.updateStatus(
            user.id,
            businessId,
            conversationId,
            await readJson(request),
          ),
        );
      }),
    invitations: (
      request: Request,
      businessId?: string,
      invitationId?: string,
    ) =>
      respond(request, async () => {
        if (!options.invitations)
          throw new AppError(503, "UNAVAILABLE", "Раздел временно недоступен.");
        const user = await requireUser(request.headers);
        if (request.method === "GET")
          return json(await options.invitations.list(user.id, businessId));
        requireOrigin(request, options.origin);
        if (request.method === "POST" && businessId && !invitationId) {
          const body = await readJson(request);
          return json(
            await options.invitations.create(
              user.id,
              businessId,
              body.userId,
              body.role,
            ),
            201,
          );
        }
        if (request.method === "POST" && invitationId === "accept")
          return json(
            await options.invitations.accept(user.id, businessId ?? ""),
          );
        if (request.method === "POST" && invitationId === "decline")
          return json(
            await options.invitations.decline(user.id, businessId ?? ""),
          );
        if (request.method === "POST" && businessId && invitationId)
          return json(
            await options.invitations.revoke(user.id, businessId, invitationId),
          );
        throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
      }),
    members: (request: Request, businessId: string) =>
      respond(request, async () => {
        if (!options.invitations)
          throw new AppError(503, "UNAVAILABLE", "Раздел временно недоступен.");
        const user = await requireUser(request.headers);
        if (request.method === "GET")
          return json(await options.invitations.members(user.id, businessId));
        if (request.method === "POST") {
          requireOrigin(request, options.origin);
          const body = await readJson(request);
          if (body.action === "change_role")
            return json(
              await options.invitations.changeRole(
                user.id,
                businessId,
                body.userId,
                body.role,
              ),
            );
          if (body.action === "revoke")
            return json(
              await options.invitations.revokeMember(
                user.id,
                businessId,
                body.userId,
              ),
            );
          throw new AppError(400, "INVALID_ACTION", "Неизвестное действие.");
        }
        throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
      }),
    audit: (request: Request, businessId: string) =>
      respond(request, async () => {
        if (!options.invitations || request.method !== "GET")
          throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
        const user = await requireUser(request.headers);
        return json(await options.invitations.auditLog(user.id, businessId));
      }),
    connections: (request: Request, businessId: string) =>
      respond(request, async () => {
        if (!options.connections)
          throw new AppError(503, "UNAVAILABLE", "Раздел временно недоступен.");
        const user = await requireUser(request.headers);
        if (request.method === "GET")
          return json(await options.connections.list(user.id, businessId));
        if (request.method === "POST") {
          requireOrigin(request, options.origin);
          return json(
            await options.connections.connect(
              user.id,
              businessId,
              await readJson(request),
            ),
            202,
          );
        }
        if (request.method === "DELETE") {
          requireOrigin(request, options.origin);
          return json(
            await options.connections.disconnect(
              user.id,
              businessId,
              new URL(request.url).searchParams.get("platform"),
            ),
          );
        }
        throw new AppError(404, "NOT_FOUND", "Страница не найдена.");
      }),
  };
}
