import type { Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import { normalizeIdentity } from "../clients/service.ts";
import { CatalogService, OrderService } from "../orders/service.ts";
import {
  availableFulfillments,
  loadOrderSettingsForBusiness,
} from "../orders/settings.ts";
import { formatMoney } from "../../lib/money.ts";
import {
  getCustomerProfile,
} from "./customer-profile-flow.ts";
import type { BotQueue, OutboxButton } from "./types.ts";

function lineUnit(productPrice: string, variantPrice: string | null) {
  return variantPrice != null && variantPrice !== ""
    ? variantPrice
    : productPrice;
}

const NAV_CATALOG: OutboxButton[] = ["Корзина", "← Назад", "Главное меню"];
const NAV_PRODUCT: OutboxButton[] = ["← Назад", "Корзина", "Главное меню"];
const NAV_CART: OutboxButton[] = ["← Назад", "Главное меню"];

function isBack(text: string) {
  return text === "← Назад" || text === "Назад";
}

export async function ordersFlow(
  tx: Transaction<Database>,
  input: {
    businessId: string;
    connectionId: string;
    platform: "telegram" | "vk";
    userId: string;
    username?: string;
    eventId: string;
    text: string;
  },
  queue: BotQueue,
) {
  const { businessId, connectionId, platform, userId, eventId, text } = input;
  const table = platform === "telegram" ? "telegram_dialog" : "vk_dialog";
  const state = await tx
    .selectFrom(table)
    .selectAll()
    .where("connection_id", "=", connectionId)
    .where("chat_id", "=", userId)
    .executeTakeFirst();
  if (
    !["Каталог", "Корзина", "Мои заказы"].includes(text) &&
    !state?.mode.startsWith("orders:")
  )
    return false;

  const catalog = new CatalogService(tx);
  const orders = new OrderService(tx);
  let answers: Record<string, string> = state ? JSON.parse(state.answers) : {};

  const save = async (
    mode: string,
    choices: { label: string; value: string }[] = [],
  ) => {
    const row = {
      connection_id: connectionId,
      chat_id: userId,
      mode: "orders:" + mode,
      fields: JSON.stringify(choices),
      answers: JSON.stringify(answers),
      position: 0,
      config: "{}",
      last_update_id: eventId,
      updated_at: new Date(),
    };
    await tx
      .insertInto(table)
      .values(row)
      .onConflict((oc) =>
        oc.columns(["connection_id", "chat_id"]).doUpdateSet(row),
      )
      .execute();
  };

  const menu = async (message: string) => {
    await tx
      .updateTable(table)
      .set({ mode: "menu", answers: "{}", last_update_id: eventId })
      .where("connection_id", "=", connectionId)
      .where("chat_id", "=", userId)
      .execute();
    await queue(message, [
      "Главное меню",
      "Каталог",
      "Корзина",
      "Мои заказы",
      "Профиль",
    ]);
  };

  const statusLabel = (status: string) => {
    switch (status) {
      case "new":
        return "новый";
      case "accepted":
        return "принят";
      case "assembling":
        return "собирается";
      case "ready":
        return "готов";
      case "handed_over":
        return "выдан";
      case "delivered":
        return "доставлен";
      case "completed":
        return "завершён";
      case "cancelled":
        return "отменён";
      default:
        return status;
    }
  };

  const showMyOrders = async () => {
    const list = await orders.listForCustomer(businessId, platform, userId);
    if (!list.length) {
      await save("my_orders", []);
      await queue("У вас пока нет заказов.", [
        "Каталог",
        "← Назад",
        "Главное меню",
      ]);
      return;
    }
    const choices = list.map((o) => ({
      label: `№${o.order_number ?? "—"} · ${statusLabel(o.status)} · ${formatMoney(o.total, o.currency)}`.slice(
        0,
        100,
      ),
      value: o.id,
    }));
    await showChoices(
      "my_orders",
      "Ваши заказы:",
      choices,
      0,
      ["← Назад", "Главное меню"],
    );
  };

  const showChoices = async (
    mode: string,
    title: string,
    choices: { label: string; value: string }[],
    page = 0,
    extra: OutboxButton[] = [],
  ) => {
    answers.choicePage = String(page);
    await save(mode, choices);
    await queue(
      title,
      ([
        ...choices.slice(page * 7, page * 7 + 7).map((c) => c.label),
        ...(page > 0 ? (["← Назад по списку"] as const) : []),
        ...((page + 1) * 7 < choices.length ? (["Далее →"] as const) : []),
        ...extra,
      ] as OutboxButton[]),
    );
  };

  const findConversationId = async () => {
    const row = await tx
      .selectFrom("communication_conversation")
      .select("id")
      .where("business_id", "=", businessId)
      .where("platform", "=", platform)
      .where("external_user_id", "=", userId)
      .executeTakeFirst();
    return row?.id ?? null;
  };

  const formatCart = async () => {
    const cart = await orders.getCart(businessId, platform, userId);
    if (!cart.items.length) return { cart, text: "Корзина пуста." };
    let total = 0;
    const currency = cart.items[0]?.currency ?? "RUB";
    let mixed = false;
    const lines = cart.items.map((item, i) => {
      const unit = lineUnit(item.product_price, item.variant_price);
      const line = Math.round(Number(unit) * item.quantity * 100) / 100;
      if (item.currency !== currency) mixed = true;
      else total += line;
      const variant = item.variant_label ? ` (${item.variant_label})` : "";
      return `${i + 1}. ${item.product_name}${variant} × ${item.quantity} = ${formatMoney(line, item.currency)}`;
    });
    const footer = mixed
      ? "\n\nВ корзине товары в разных валютах. Оформите заказ по одной валюте."
      : "\n\nИтого: " + formatMoney(total, currency);
    return {
      cart,
      mixed,
      text: "Ваша корзина:\n" + lines.join("\n") + footer,
    };
  };

  const showCart = async (prefix = "") => {
    const { cart, text: body, mixed } = await formatCart();
    const choices = cart.items.map((item, i) => ({
      label: `${i + 1}. ${item.product_name}`.slice(0, 100),
      value: item.id,
    }));
    answers = { choicePage: "0" };
    await save("cart", choices);
    const buttons: OutboxButton[] = cart.items.length
      ? [
          ...(mixed ? [] : ["Оформить заказ"]),
          "Изменить позицию",
          "Очистить корзину",
          ...NAV_CART,
        ]
      : NAV_CATALOG;
    await queue((prefix ? prefix + "\n\n" : "") + body, buttons);
  };

  const showProductList = async (categoryId: string) => {
    answers.categoryId = categoryId;
    const data = await catalog.catalogForBusiness(businessId);
    const products =
      categoryId === "_"
        ? data.products.filter((p) => !p.category_id)
        : data.products.filter((p) => p.category_id === categoryId);
    const productChoices = products.map((p, i) => ({
      label: `${i + 1}. ${p.name} · ${formatMoney(p.price, p.currency)}`.slice(
        0,
        100,
      ),
      value: p.id,
    }));
    await showChoices(
      "products",
      productChoices.length
        ? "Выберите товар."
        : "В категории пока нет товаров.",
      productChoices,
      0,
      NAV_CATALOG,
    );
  };

  const showCategories = async () => {
    answers = {};
    const data = await catalog.catalogForBusiness(businessId);
    const withProducts = data.categories.filter((c) =>
      data.products.some((p) => p.category_id === c.id),
    );
    const uncategorized = data.products.filter((p) => !p.category_id);
    const choices = withProducts.map((c, i) => ({
      label: `${i + 1}. ${c.name}`.slice(0, 100),
      value: c.id,
    }));
    if (uncategorized.length)
      choices.push({
        label: `${choices.length + 1}. Без категории`,
        value: "_",
      });
    if (!choices.length && data.products.length) {
      const productChoices = data.products.map((p, i) => ({
        label:
          `${i + 1}. ${p.name} · ${formatMoney(p.price, p.currency)}`.slice(
            0,
            100,
          ),
        value: p.id,
      }));
      await showChoices(
        "products",
        "Выберите товар.",
        productChoices,
        0,
        NAV_CATALOG,
      );
      return;
    }
    await showChoices(
      "categories",
      choices.length ? "Выберите категорию." : "Каталог пока пуст.",
      choices,
      0,
      NAV_CATALOG,
    );
  };

  const showProductCard = async (productId: string) => {
    const product = await catalog.productForBusiness(businessId, productId);
    answers.productId = product.id;
    delete answers.variantId;
    delete answers.quantity;
    const attachmentIds = product.images.map((img) => img.attachment_id);
    const desc = product.description?.trim()
      ? "\n" + product.description.trim().slice(0, 800)
      : "";
    const body =
      `${product.name}\n${formatMoney(product.price, product.currency)}` + desc;
    if (product.use_variants) {
      const variants = product.variants.filter((v) => v.active !== false);
      const choices = variants.map((v, i) => ({
        label:
          `${i + 1}. ${v.label || "Вариант"}` +
          (v.price ? ` · ${formatMoney(v.price, product.currency)}` : ""),
        value: v.id,
      }));
      answers.choicePage = "0";
      await save("variant", choices);
      await queue(
        body +
          (choices.length
            ? "\n\nВыберите вариант."
            : "\n\nВарианты недоступны."),
        [
          ...choices.slice(0, 7).map((c) => c.label),
          ...NAV_PRODUCT,
        ] as OutboxButton[],
        attachmentIds,
      );
      return;
    }
    await save("qty");
    await queue(
      body + "\n\nСколько добавить в корзину?",
      ["1", "2", "3", "5", "10", ...NAV_PRODUCT],
      attachmentIds,
    );
  };

  const askCheckoutName = async () => {
    await save("checkout_name");
    await queue("Как к вам обращаться?", ["← Назад", "Главное меню"]);
  };

  const askCheckoutPhone = async () => {
    await save("checkout_phone");
    if (platform === "telegram") {
      await queue("Ваш телефон в формате +79991234567.", [
        {
          text: "📱 Отправить номер телефона",
          request_contact: true,
        },
        "Ввести вручную",
        "← Назад",
        "Главное меню",
      ]);
    } else {
      await queue("Ваш телефон в формате +79991234567.", [
        "← Назад",
        "Главное меню",
      ]);
    }
  };

  const askFulfillment = async () => {
    const settings = await loadOrderSettingsForBusiness(tx, businessId);
    const options = availableFulfillments(settings);
    if (options.length === 0) {
      await queue(
        "Сейчас нельзя оформить заказ: доставка и самовывоз отключены.",
        ["Корзина", "Главное меню"],
      );
      return;
    }
    if (options.length === 1 && options[0] === "delivery") {
      answers.fulfillment = "delivery";
      await save("checkout_address");
      await queue("Адрес доставки?", ["← Назад", "Главное меню"]);
      return;
    }
    if (options.length === 1 && options[0] === "pickup") {
      answers.fulfillment = "pickup";
      answers.address = "";
      await save("checkout_comment");
      await queue("Комментарий к заказу?\nМожно пропустить: /skip.", [
        "/skip",
        "← Назад",
        "Главное меню",
      ]);
      return;
    }
    await save("checkout_fulfillment");
    const buttons: OutboxButton[] = [];
    if (options.includes("delivery")) buttons.push("Доставка");
    if (options.includes("pickup")) buttons.push("Самовывоз");
    buttons.push("← Назад", "Главное меню");
    await queue("Доставка или самовывоз?", buttons);
  };

  const startCheckout = async () => {
    const cart = await orders.getCart(businessId, platform, userId);
    if (!cart.items.length) {
      await showCart();
      return;
    }
    const profile = await getCustomerProfile(
      tx,
      businessId,
      platform,
      userId,
    );
    if (profile) {
      answers.name = profile.name;
      answers.phone = profile.phone;
      await save("checkout_profile");
      await queue(
        `Использовать данные профиля?\n${profile.name}\n${profile.phone}`,
        [
          "Использовать данные профиля",
          "Изменить",
          "← Назад",
          "Главное меню",
        ],
      );
      return;
    }
    await askCheckoutName();
  };

  if (text === "Каталог") {
    await showCategories();
    return true;
  }

  if (text === "Корзина") {
    await showCart();
    return true;
  }

  if (text === "Мои заказы") {
    await showMyOrders();
    return true;
  }

  const choices = state
    ? (JSON.parse(state.fields) as { label: string; value: string }[])
    : [];
  const picked = choices.find(
    (c) => c.label === text || c.value === text,
  )?.value;
  const mode = state?.mode.slice(7);

  if (mode === "my_orders" && picked) {
    const list = await orders.listForCustomer(businessId, platform, userId);
    const order = list.find((o) => o.id === picked);
    if (!order) {
      await showMyOrders();
      return true;
    }
    const items = Array.isArray(order.items_snapshot)
      ? (order.items_snapshot as { name?: string; quantity?: number; line_total?: string }[])
      : [];
    const lines = items
      .map(
        (it, i) =>
          `${i + 1}. ${it.name ?? "Товар"} × ${it.quantity ?? 1}` +
          (it.line_total
            ? ` = ${formatMoney(it.line_total, order.currency)}`
            : ""),
      )
      .join("\n");
    answers.orderId = order.id;
    await save("order_detail", []);
    const canCancel = ["new", "accepted", "assembling", "ready"].includes(
      order.status,
    );
    await queue(
      `Заказ №${order.order_number ?? "—"}\nСтатус: ${statusLabel(order.status)}\nСумма: ${formatMoney(order.total, order.currency)}\n\n${lines || "Состав недоступен."}`,
      [
        ...(canCancel ? (["Отменить заказ"] as const) : []),
        "Мои заказы",
        "← Назад",
        "Главное меню",
      ],
    );
    return true;
  }

  if (mode === "order_detail") {
    if (text === "Мои заказы" || isBack(text)) {
      await showMyOrders();
      return true;
    }
    if (text === "Отменить заказ" && answers.orderId) {
      await save("order_cancel_confirm", []);
      await queue("Отменить заказ? Это нельзя отменить.", [
        "Да, отменить заказ",
        "Нет",
        "Мои заказы",
      ]);
      return true;
    }
  }

  if (mode === "order_cancel_confirm") {
    if (text === "Да, отменить заказ" && answers.orderId) {
      try {
        const result = await orders.cancelForCustomer(
          businessId,
          platform,
          userId,
          answers.orderId,
        );
        await menu(
          result.status === "cancelled"
            ? "Заказ отменён."
            : "Статус заказа обновлён.",
        );
      } catch (error) {
        await menu(
          error instanceof AppError
            ? error.message
            : "Не удалось отменить заказ.",
        );
      }
      return true;
    }
    if (text === "Нет" || text === "Мои заказы" || isBack(text)) {
      await showMyOrders();
      return true;
    }
  }

  if (
    ["categories", "products", "variant", "cart", "cart_pick", "my_orders"].includes(
      mode ?? "",
    ) &&
    ["Далее →", "← Назад по списку"].includes(text)
  ) {
    const page = Math.max(
      0,
      Math.min(
        Math.floor((choices.length - 1) / 7),
        Number(answers.choicePage ?? 0) + (text === "Далее →" ? 1 : -1),
      ),
    );
    const extra =
      mode === "variant"
        ? NAV_PRODUCT
        : mode === "cart" || mode === "cart_pick"
          ? NAV_CART
          : NAV_CATALOG;
    await showChoices(mode!, "Выберите вариант.", choices, page, extra);
    return true;
  }

  // Contextual back navigation
  if (isBack(text)) {
    if (mode === "categories") {
      await menu("Выберите действие.");
      return true;
    }
    if (mode === "products") {
      await showCategories();
      return true;
    }
    if (mode === "variant" || mode === "qty") {
      if (mode === "qty" && answers.variantId && answers.productId) {
        await showProductCard(answers.productId);
        return true;
      }
      if (answers.categoryId) await showProductList(answers.categoryId);
      else await showCategories();
      return true;
    }
    if (mode === "cart") {
      await showCategories();
      return true;
    }
    if (mode === "cart_pick" || mode === "cart_edit") {
      await showCart();
      return true;
    }
    if (mode === "cart_qty") {
      await save("cart_edit");
      await queue("Что сделать с позицией?", [
        "Изменить количество",
        "Удалить",
        ...NAV_PRODUCT,
      ]);
      return true;
    }
    if (mode === "checkout_profile") {
      await showCart();
      return true;
    }
    if (mode === "checkout_name") {
      await showCart();
      return true;
    }
    if (mode === "checkout_phone" || mode === "checkout_phone_manual") {
      await askCheckoutName();
      return true;
    }
    if (mode === "checkout_fulfillment") {
      const profile = await getCustomerProfile(
        tx,
        businessId,
        platform,
        userId,
      );
      if (profile && answers.name === profile.name && answers.phone === profile.phone) {
        answers.name = profile.name;
        answers.phone = profile.phone;
        await save("checkout_profile");
        await queue(
          `Использовать данные профиля?\n${profile.name}\n${profile.phone}`,
          [
            "Использовать данные профиля",
            "Изменить",
            "← Назад",
            "Главное меню",
          ],
        );
      } else await askCheckoutPhone();
      return true;
    }
    if (mode === "checkout_address") {
      await askFulfillment();
      return true;
    }
    if (mode === "checkout_comment") {
      if (answers.fulfillment === "delivery") {
        await save("checkout_address");
        await queue("Адрес доставки?", ["← Назад", "Главное меню"]);
      } else await askFulfillment();
      return true;
    }
    if (mode === "checkout_confirm") {
      await save("checkout_comment");
      await queue("Комментарий к заказу?\nМожно пропустить: /skip.", [
        "/skip",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
  }

  if (mode === "categories" && picked) {
    await showProductList(picked);
    return true;
  }

  if (mode === "products" && picked) {
    await showProductCard(picked);
    return true;
  }

  if (mode === "variant" && picked) {
    answers.variantId = picked;
    await save("qty");
    await queue("Сколько добавить в корзину?", [
      "1",
      "2",
      "3",
      "5",
      "10",
      ...NAV_PRODUCT,
    ]);
    return true;
  }

  if (mode === "qty") {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      await queue("Введите количество от 1 до 999.", [
        "1",
        "2",
        "3",
        "5",
        "10",
        ...NAV_PRODUCT,
      ]);
      return true;
    }
    try {
      await orders.addCartItem(businessId, platform, userId, {
        product_id: answers.productId,
        variant_id: answers.variantId || null,
        quantity: qty,
      });
      await showCart("Товар добавлен в корзину.");
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      await queue(error.message, NAV_CATALOG);
    }
    return true;
  }

  if (mode === "cart") {
    if (text === "Оформить заказ") {
      await startCheckout();
      return true;
    }
    if (text === "Очистить корзину") {
      await orders.clearCart(businessId, platform, userId);
      await showCart("Корзина очищена.");
      return true;
    }
    if (text === "Изменить позицию") {
      if (!choices.length) {
        await showCart();
        return true;
      }
      await showChoices(
        "cart_pick",
        "Выберите позицию для изменения.",
        choices,
        0,
        NAV_CART,
      );
      return true;
    }
  }

  if (mode === "cart_pick" && picked) {
    answers.itemId = picked;
    await save("cart_edit");
    await queue("Что сделать с позицией?", [
      "Изменить количество",
      "Удалить",
      ...NAV_PRODUCT,
    ]);
    return true;
  }

  if (mode === "cart_edit") {
    if (text === "Удалить") {
      await orders.removeCartItem(
        businessId,
        platform,
        userId,
        answers.itemId!,
      );
      await showCart("Позиция удалена.");
      return true;
    }
    if (text === "Изменить количество") {
      await save("cart_qty");
      await queue("Новое количество?", [
        "1",
        "2",
        "3",
        "5",
        "10",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
  }

  if (mode === "cart_qty") {
    const qty = Number(text);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) {
      await queue("Введите количество от 1 до 999.", [
        "1",
        "2",
        "3",
        "5",
        "10",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    try {
      await orders.updateCartItem(
        businessId,
        platform,
        userId,
        answers.itemId!,
        qty,
      );
      await showCart("Количество обновлено.");
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      await queue(error.message, NAV_CART);
    }
    return true;
  }

  if (mode === "checkout_profile") {
    if (text === "Использовать данные профиля") {
      if (!answers.name || !answers.phone) {
        await askCheckoutName();
        return true;
      }
      await askFulfillment();
      return true;
    }
    if (text === "Изменить") {
      delete answers.name;
      delete answers.phone;
      await askCheckoutName();
      return true;
    }
    await queue("Выберите действие.", [
      "Использовать данные профиля",
      "Изменить",
      "← Назад",
      "Главное меню",
    ]);
    return true;
  }

  if (mode === "checkout_name") {
    if (!text.trim() || text.length > 100) {
      await queue("Введите имя до 100 символов.", [
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    answers.name = text.trim();
    await askCheckoutPhone();
    return true;
  }

  if (mode === "checkout_phone") {
    if (text === "Ввести вручную") {
      await save("checkout_phone_manual");
      await queue("Введите телефон в формате +79991234567.", [
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    try {
      answers.phone = normalizeIdentity({ kind: "phone", value: text }).value;
    } catch {
      if (platform === "telegram") {
        await queue("Введите телефон в формате +79991234567.", [
          {
            text: "📱 Отправить номер телефона",
            request_contact: true,
          },
          "Ввести вручную",
          "← Назад",
          "Главное меню",
        ]);
      } else {
        await queue("Введите телефон в формате +79991234567.", [
          "← Назад",
          "Главное меню",
        ]);
      }
      return true;
    }
    await askFulfillment();
    return true;
  }

  if (mode === "checkout_phone_manual") {
    try {
      answers.phone = normalizeIdentity({ kind: "phone", value: text }).value;
    } catch {
      await queue("Введите телефон в формате +79991234567.", [
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    await askFulfillment();
    return true;
  }

  if (mode === "checkout_fulfillment") {
    const settings = await loadOrderSettingsForBusiness(tx, businessId);
    const options = availableFulfillments(settings);
    if (text === "Доставка" && options.includes("delivery")) {
      answers.fulfillment = "delivery";
      await save("checkout_address");
      await queue("Адрес доставки?", ["← Назад", "Главное меню"]);
      return true;
    }
    if (text === "Самовывоз" && options.includes("pickup")) {
      answers.fulfillment = "pickup";
      answers.address = "";
      await save("checkout_comment");
      await queue("Комментарий к заказу?\nМожно пропустить: /skip.", [
        "/skip",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    const buttons: OutboxButton[] = [];
    if (options.includes("delivery")) buttons.push("Доставка");
    if (options.includes("pickup")) buttons.push("Самовывоз");
    buttons.push("← Назад", "Главное меню");
    await queue(
      options.length
        ? "Выберите доставку или самовывоз."
        : "Сейчас нельзя оформить заказ: доставка и самовывоз отключены.",
      buttons.length > 2 ? buttons : ["Корзина", "Главное меню"],
    );
    return true;
  }

  if (mode === "checkout_address") {
    if (!text.trim() || text.length > 500) {
      await queue("Укажите адрес доставки до 500 символов.", [
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    answers.address = text.trim();
    await save("checkout_comment");
    await queue("Комментарий к заказу?\nМожно пропустить: /skip.", [
      "/skip",
      "← Назад",
      "Главное меню",
    ]);
    return true;
  }

  if (mode === "checkout_comment") {
    if (text.startsWith("/") && text !== "/skip") {
      await queue("Комментарий к заказу?\nМожно пропустить: /skip.", [
        "/skip",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    if (text.length > 2000) {
      await queue("Комментарий слишком длинный.", [
        "/skip",
        "← Назад",
        "Главное меню",
      ]);
      return true;
    }
    answers.comment = text === "/skip" ? "" : text.trim();
    const { text: cartText } = await formatCart();
    await save("checkout_confirm");
    await queue(
      cartText +
        "\n\n" +
        answers.name +
        "\n" +
        answers.phone +
        "\n" +
        (answers.fulfillment === "delivery"
          ? "Доставка: " + answers.address
          : "Самовывоз") +
        (answers.comment ? "\n" + answers.comment : "") +
        "\n\nПодтвердить заказ?",
      ["Подтвердить", "← Назад", "Главное меню"],
    );
    return true;
  }

  if (mode === "checkout_confirm" && text === "Подтвердить") {
    try {
      const conversationId = await findConversationId();
      const order = await orders.checkout(businessId, {
        request_key: connectionId + ":" + eventId,
        source: platform,
        platform,
        external_user_id: userId,
        customer_name: answers.name,
        customer_phone: answers.phone,
        fulfillment: answers.fulfillment,
        delivery_address: answers.address || "",
        comment: answers.comment || "",
        conversation_id: conversationId,
      });
      await menu(
        "Заказ принят № " +
          (order.order_number ?? "") +
          ".\nСумма: " +
          formatMoney(order.total, order.currency) +
          ".\nМы свяжемся с вами для подтверждения.",
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      await queue(error.message, ["Корзина", "Каталог", "Главное меню"]);
    }
    return true;
  }

  await queue("Выберите действие кнопкой или напишите /cancel.", NAV_CATALOG);
  return true;
}
