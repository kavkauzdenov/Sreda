import { getRuntime } from "../runtime";
import { createApplication } from "./application";
import { AppError, json, readJson, requireOrigin, respond } from "./errors";
import { limit } from "./limits";
import { CatalogService, OrderService } from "../orders/service";
import type { CartPlatform } from "../orders/schema";
import {
  getOrderSummary,
  listOrdersV2,
  parseOrderListFilters,
} from "../orders/list";
import { assignOrder, claimOrder } from "../orders/assignment";
import {
  getOrderSettingsV2,
  saveOrderSettingsV2,
} from "../orders/settings";
import { adjustInventory, listInventory } from "../orders/inventory";
import { listAssignees } from "../clients/tags";

function cartIdentity(body: Record<string, unknown>, search: URLSearchParams) {
  const platform = String(
    body.platform ?? search.get("platform") ?? "",
  ) as CartPlatform;
  const externalUserId = String(
    body.external_user_id ?? search.get("external_user_id") ?? "",
  );
  if (!["telegram", "vk", "web"].includes(platform))
    throw new AppError(400, "INVALID_ORDER", "Проверьте площадку.");
  if (!externalUserId || externalUserId.length > 200)
    throw new AppError(400, "INVALID_ORDER", "Проверьте пользователя.");
  return { platform, externalUserId };
}

export function ordersHandler(
  request: Request,
  publicId: string,
  resource: "products" | "categories" | "orders" | "cart",
  resourceId?: string,
) {
  return respond(request, async () => {
    const runtime = getRuntime();
    const user = await createApplication(runtime).requireUser(request.headers);
    const catalog = new CatalogService(runtime.db);
    const orders = new OrderService(runtime.db);
    const search = new URL(request.url).searchParams;
    if (request.method !== "GET") {
      requireOrigin(request, runtime.origin);
      await limit(
        runtime.db,
        runtime.secret,
        "orders:" + publicId + ":" + user.id,
        60,
        60,
      );
    }

    if (resource === "categories") {
      if (request.method === "GET")
        return json(await catalog.listCategories(user.id, publicId));
      if (request.method === "POST")
        return json(
          await catalog.saveCategory(
            user.id,
            publicId,
            await readJson(request, 8000),
          ),
          201,
        );
      if ((request.method === "PATCH" || request.method === "PUT") && resourceId)
        return json(
          await catalog.saveCategory(
            user.id,
            publicId,
            await readJson(request, 8000),
            resourceId,
          ),
        );
      if (request.method === "DELETE" && resourceId)
        return json(
          await catalog.deleteCategory(user.id, publicId, resourceId),
        );
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    if (resource === "products") {
      if (request.method === "GET")
        return json(
          resourceId
            ? await catalog.getProduct(user.id, publicId, resourceId)
            : await catalog.listProducts(
                user.id,
                publicId,
                search.get("category") ?? undefined,
              ),
        );
      if (request.method === "POST")
        return json(
          await catalog.saveProduct(
            user.id,
            publicId,
            await readJson(request, 100000),
          ),
          201,
        );
      if ((request.method === "PATCH" || request.method === "PUT") && resourceId)
        return json(
          await catalog.saveProduct(
            user.id,
            publicId,
            await readJson(request, 100000),
            resourceId,
          ),
        );
      if (request.method === "DELETE" && resourceId)
        return json(await catalog.deleteProduct(user.id, publicId, resourceId));
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    if (resource === "cart") {
      const body =
        request.method === "GET" ? {} : await readJson(request, 20000);
      const { platform, externalUserId } = cartIdentity(body, search);
      const business = await runtime.db
        .selectFrom("business as b")
        .innerJoin("business_member as m", "m.business_id", "b.id")
        .select("b.id")
        .where("b.public_id", "=", publicId)
        .where("b.archived_at", "is", null)
        .where("m.user_id", "=", user.id)
        .where("m.status", "=", "active")
        .executeTakeFirst();
      if (!business)
        throw new AppError(404, "BUSINESS_NOT_FOUND", "Бизнес не найден.");
      if (request.method === "GET")
        return json(
          await orders.getCart(business.id, platform, externalUserId),
        );
      if (request.method === "POST") {
        const action = String(body.action ?? "add");
        if (action === "add")
          return json(
            await orders.addCartItem(
              business.id,
              platform,
              externalUserId,
              body,
            ),
            201,
          );
        if (action === "update")
          return json(
            await orders.updateCartItem(
              business.id,
              platform,
              externalUserId,
              String(body.item_id),
              body.quantity,
            ),
          );
        if (action === "remove")
          return json(
            await orders.removeCartItem(
              business.id,
              platform,
              externalUserId,
              String(body.item_id),
            ),
          );
        if (action === "clear")
          return json(
            await orders.clearCart(business.id, platform, externalUserId),
          );
        if (action === "checkout")
          return json(
            await orders.checkout(
              business.id,
              { ...body, platform, external_user_id: externalUserId },
              user.id,
            ),
            201,
          );
      }
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    const view = search.get("view") ?? "";

    if (view === "settings") {
      if (request.method === "GET")
        return json(await getOrderSettingsV2(runtime.db, user.id, publicId));
      if (request.method === "PATCH" || request.method === "PUT")
        return json(
          await saveOrderSettingsV2(
            runtime.db,
            user.id,
            publicId,
            await readJson(request, 20000),
          ),
        );
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    if (view === "inventory") {
      if (request.method === "GET")
        return json(
          await listInventory(runtime.db, user.id, publicId, {
            search: search.get("search") ?? search.get("q") ?? undefined,
            state: search.get("state") ?? undefined,
          }),
        );
      if (request.method === "POST" || request.method === "PATCH")
        return json(
          await adjustInventory(
            runtime.db,
            user.id,
            publicId,
            await readJson(request, 8000),
          ),
        );
      throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
    }

    if (view === "assignees" && request.method === "GET")
      return json(await listAssignees(runtime.db, user.id, publicId));

    if (request.method === "GET") {
      if (resourceId)
        return json(await orders.get(user.id, publicId, resourceId));
      if (view === "summary")
        return json(await getOrderSummary(runtime.db, user.id, publicId));
      if (view === "v2")
        return json(
          await listOrdersV2(
            runtime.db,
            user.id,
            publicId,
            parseOrderListFilters(search),
          ),
        );
      return json(
        await orders.list(
          user.id,
          publicId,
          search.get("status") ?? undefined,
          Number(search.get("page") ?? 0),
        ),
      );
    }

    if (request.method === "POST" && resourceId) {
      const body = await readJson(request, 8000);
      const action = String(body.action ?? "");
      if (action === "claim")
        return json(await claimOrder(runtime.db, user.id, publicId, resourceId));
      if (action === "assign")
        return json(
          await assignOrder(
            runtime.db,
            user.id,
            publicId,
            resourceId,
            body.assignedUserId ?? body.assigned_user_id,
          ),
        );
      throw new AppError(400, "INVALID_ACTION", "Неизвестное действие.");
    }

    if (request.method === "POST" && !resourceId)
      return json(
        await orders.checkoutForBusiness(
          user.id,
          publicId,
          await readJson(request, 40000),
        ),
        201,
      );

    if (request.method === "PATCH" && resourceId)
      return json(
        await orders.transitionStatus(
          user.id,
          publicId,
          resourceId,
          await readJson(request),
        ),
      );

    throw new AppError(405, "METHOD_NOT_ALLOWED", "Действие недоступно.");
  });
}
