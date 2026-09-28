import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import type { Identity } from "../identity/auth.ts";
import { SolutionService } from "../solutions/service.ts";
import { TelegramService } from "../telegram/service.ts";
import { AppError, json, readJson, requireOrigin, respond } from "./errors.ts";
import { limit } from "./limits.ts";

const DRAFT_ACTIONS = new Set([
  "touch_draft",
  "complete_draft",
  "cancel_draft",
  "get_draft",
]);

const LIFECYCLE_ACTIONS = new Set(["cancel_setup", "reset_settings"]);

export function createSolutionHandler(options: {
  db: Kysely<Database>;
  auth: Identity;
  origin: string;
  telegramWebhookOrigin?: string;
  secret: string;
  telegramEnabled?: boolean;
  vkEnabled?: boolean;
  metaEnabled?: boolean;
  telegram?: TelegramService;
}) {
  const solutions = new SolutionService(
    options.db,
    options.telegramEnabled,
    options.vkEnabled,
    options.metaEnabled,
  );
  return (
    request: Request,
    id: string,
    action: "setup" | "solutions" | "start",
  ) =>
    respond(request, async () => {
      if (
        !["GET", "POST"].includes(request.method) ||
        (action === "start" && request.method !== "POST")
      )
        throw new AppError(405, "METHOD_NOT_ALLOWED", "Метод недоступен.");
      if (request.method !== "GET") requireOrigin(request, options.origin);
      const session = await options.auth.api.getSession({
        headers: request.headers,
      });
      if (!session?.user.username)
        throw new AppError(401, "UNAUTHENTICATED", "Войдите в аккаунт.");
      if (action === "solutions") {
        if (request.method === "GET") {
          const draftCode = new URL(request.url).searchParams.get("draft");
          if (draftCode)
            return json(
              await solutions.getSetupDraft(
                session.user.id,
                id,
                draftCode,
              ),
            );
          return json(await solutions.list(session.user.id, id));
        }
        await limit(
          options.db,
          options.secret,
          "solution:" + session.user.id,
          30,
          60,
        );
        const body = await readJson(request);
        if (
          typeof body.action === "string" &&
          LIFECYCLE_ACTIONS.has(body.action)
        ) {
          const code = String(body.code ?? "");
          if (!code)
            throw new AppError(400, "INVALID_SOLUTION", "Укажите решение.");
          if (body.action === "cancel_setup")
            return json(
              await solutions.cancelSetup(session.user.id, id, code),
            );
          return json(
            await solutions.resetSettings(session.user.id, id, code),
          );
        }
        if (
          typeof body.action === "string" &&
          DRAFT_ACTIONS.has(body.action)
        ) {
          const code = String(body.code ?? "");
          if (!code)
            throw new AppError(400, "INVALID_SOLUTION", "Укажите решение.");
          if (body.action === "get_draft")
            return json(
              await solutions.getSetupDraft(session.user.id, id, code),
            );
          const businessId = await solutions.business(
            session.user.id,
            id,
            true,
          );
          if (body.action === "touch_draft") {
            const draft =
              body.draft && typeof body.draft === "object"
                ? (body.draft as Record<string, unknown>)
                : {};
            return json(
              await solutions.touchSetupDraft(businessId, code, draft),
            );
          }
          if (body.action === "complete_draft")
            return json(
              await solutions.completeSetupDraft(businessId, code),
            );
          return json(
            await solutions.cancelSetupDraft(businessId, code, {
              mode: "user_cancel",
            }),
          );
        }
        return json(
          await solutions.activate(session.user.id, id, body),
        );
      }
      if (action === "setup" && request.method === "GET")
        return json(await solutions.get(session.user.id, id));
      await limit(
        options.db,
        options.secret,
        "solution:" + session.user.id,
        30,
        60,
      );
      if (action === "setup")
        return json(
          await solutions.save(session.user.id, id, await readJson(request)),
        );
      return json(
        await (
          options.telegram ??
          new TelegramService(
            options.db,
            options.secret,
            options.telegramWebhookOrigin ?? options.origin,
            !!options.telegramEnabled,
          )
        ).start(session.user.id, id),
      );
    });
}
