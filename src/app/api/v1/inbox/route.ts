import { getRuntime } from "@/server/runtime";
import { createApplication } from "@/server/http/application";
import {
  AppError,
  json,
  readJson,
  requireOrigin,
  respond,
} from "@/server/http/errors";
import { NotificationService } from "@/server/notifications/service";

/** Account-level inbox (invitations and other non-member events). */
export async function GET(request: Request) {
  return respond(request, async () => {
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const items = await new NotificationService(runtime.db).listUserInbox(
      user.id,
    );
    return json(
      items.map((item) => ({
        id: item.id,
        type: item.type,
        title: item.title,
        body: item.body,
        target_path: item.target_path,
        event_key: item.event_key,
        business_id: item.business_id,
        payload: item.payload,
        read_at: item.read_at,
        resolved_at: item.resolved_at,
        created_at: item.created_at,
      })),
    );
  });
}

export async function PATCH(request: Request) {
  return respond(request, async () => {
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    requireOrigin(request, runtime.origin);
    const body = await readJson(request);
    const service = new NotificationService(runtime.db);

    if (body.all === true) {
      return json(await service.markAllUserNotificationsRead(user.id));
    }

    if (typeof body.id !== "string")
      throw new AppError(400, "INVALID_REQUEST", "Укажите уведомление.");

    if (body.read === true) {
      return json(await service.readUserNotification(user.id, body.id));
    }

    return json(await service.resolveUserNotification(user.id, body.id));
  });
}
