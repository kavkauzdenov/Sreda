import { getRuntime } from "../runtime";
import { createApplication } from "./application";
import { json, readJson, requireOrigin, respond, AppError } from "./errors";
import { limit } from "./limits";
import { ClientService } from "../clients/service";
import { NotificationService } from "../notifications/service";
import { BusinessProfileService } from "../workspaces/profile";
import { listClientsV2, parseListFilters } from "../clients/list";
import { getClientSummary } from "../clients/summary";
import { getClientDetailV2, listClientTab } from "../clients/detail";
import { getClientTimeline } from "../clients/timeline";
import {
  attachTag,
  createTag,
  detachTag,
  assignClient,
  claimClient,
  listAssignees,
  listBusinessTags,
  setProfileNote,
} from "../clients/tags";
import {
  decideDuplicate,
  findDuplicateCandidates,
  getDuplicateCompare,
} from "../clients/duplicates";
import { requireBusiness } from "../access/permissions";

export function crmHandler(
  request: Request,
  businessId: string,
  resource: "clients" | "notifications" | "profile",
  id?: string,
) {
  return respond(request, async () => {
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    if (request.method !== "GET") {
      requireOrigin(request, runtime.origin);
      await limit(
        runtime.db,
        runtime.secret,
        "crm:" + businessId + ":" + user.id,
        60,
        60,
      );
    }
    if (resource === "profile") {
      const service = new BusinessProfileService(runtime.db);
      return json(
        request.method === "GET"
          ? await service.get(user.id, businessId)
          : await service.save(
              user.id,
              businessId,
              await readJson(request, 48000),
            ),
      );
    }
    if (resource === "notifications") {
      const service = new NotificationService(runtime.db);
      if (request.method === "GET")
        return json(await service.list(user.id, businessId));
      const body = await readJson(request);
      if (
        body.action === "mark_all_read" ||
        body.mark_all === true ||
        body.all === true
      )
        return json(await service.markAllRead(user.id, businessId));
      if (body.action === "resolve")
        return json(
          await service.resolve(user.id, businessId, String(body.id)),
        );
      return json(
        await service.read(user.id, businessId, String(body.id)),
      );
    }

    const service = new ClientService(runtime.db);
    const url = new URL(request.url);
    const params = url.searchParams;
    const view = params.get("view") ?? "";

    if (request.method === "GET") {
      // Collection-level V2 endpoints (no client id)
      if (!id) {
        if (view === "summary")
          return json(await getClientSummary(runtime.db, user.id, businessId));
        if (view === "tags")
          return json(await listBusinessTags(runtime.db, user.id, businessId));
        if (view === "assignees")
          return json(await listAssignees(runtime.db, user.id, businessId));
        if (view === "v2")
          return json(
            await listClientsV2(
              runtime.db,
              user.id,
              businessId,
              parseListFilters(params),
            ),
          );
        // Legacy list
        return json(
          await service.list(
            user.id,
            businessId,
            params.get("search") ?? "",
            params.get("after") ?? undefined,
            params.get("filter") ?? "all",
          ),
        );
      }

      // Detail-level V2
      if (view === "v2")
        return json(
          await getClientDetailV2(runtime.db, user.id, businessId, id),
        );
      if (view === "timeline")
        return json(
          await getClientTimeline(
            runtime.db,
            user.id,
            businessId,
            id,
            params.get("cursor") ?? undefined,
            Number(params.get("limit") ?? 30),
          ),
        );
      if (
        view === "leads" ||
        view === "orders" ||
        view === "bookings" ||
        view === "conversations" ||
        view === "notes"
      )
        return json(
          await listClientTab(
            runtime.db,
            user.id,
            businessId,
            id,
            view,
            params.get("cursor") ?? undefined,
            Number(params.get("limit") ?? 30),
          ),
        );
      if (view === "duplicates") {
        const b = await requireBusiness(
          runtime.db,
          user.id,
          businessId,
          "clients.read",
        );
        return json(await findDuplicateCandidates(runtime.db, b.id, id));
      }
      if (view === "compare") {
        const other = params.get("other") ?? "";
        return json(
          await getDuplicateCompare(
            runtime.db,
            user.id,
            businessId,
            id,
            other,
          ),
        );
      }

      return json(
        await service.detail(
          user.id,
          businessId,
          id,
          Number(params.get("page") ?? 0),
        ),
      );
    }

    const body = await readJson(request, 16000);

    // Collection mutations / actions
    if (!id) {
      if (request.method === "POST") {
        if (body.action === "create_tag")
          return json(
            await createTag(runtime.db, user.id, businessId, body),
            201,
          );
        if (body.action === "duplicate_decision")
          return json(
            await decideDuplicate(runtime.db, user.id, businessId, body),
          );
        return json(await service.save(user.id, businessId, body), 201);
      }
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    // Client-scoped mutations
    if (request.method === "POST") {
      if (body.action === "attach_tag")
        return json(
          await attachTag(
            runtime.db,
            user.id,
            businessId,
            id,
            String(body.tagId ?? body.tag_id ?? ""),
          ),
          201,
        );
      if (body.action === "detach_tag")
        return json(
          await detachTag(
            runtime.db,
            user.id,
            businessId,
            id,
            String(body.tagId ?? body.tag_id ?? ""),
          ),
        );
      if (body.action === "assign")
        return json(
          await assignClient(
            runtime.db,
            user.id,
            businessId,
            id,
            body.assignedUserId ?? body.assigned_user_id ?? null,
          ),
        );
      if (body.action === "claim")
        return json(
          await claimClient(runtime.db, user.id, businessId, id),
        );
      if (body.action === "profile_note")
        return json(
          await setProfileNote(
            runtime.db,
            user.id,
            businessId,
            id,
            body.profileNote ?? body.profile_note ?? body.text ?? null,
          ),
        );
      if (body.action === "duplicate_decision")
        return json(
          await decideDuplicate(runtime.db, user.id, businessId, {
            ...body,
            clientAId: body.clientAId ?? id,
            clientBId: body.clientBId ?? body.otherClientId,
          }),
        );
      // Default POST on client = note
      if (typeof body.text === "string" && !body.action)
        return json(await service.note(user.id, businessId, id, body.text), 201);
      throw new AppError(400, "INVALID_ACTION", "Неизвестное действие.");
    }

    if (request.method === "PATCH")
      return json(await service.save(user.id, businessId, body, id));

    throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
  });
}
