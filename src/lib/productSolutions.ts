/** User-facing product catalog — single source for names, pricing, CTAs, setup. */

export type ProductSolutionCode =
  | "leads"
  | "orders"
  | "booking"
  | "admin_messages"
  | "autopost";

export type ProductSolutionDefinition = {
  code: ProductSolutionCode;
  id: string;
  name: string;
  description: string;
  /** 0 = free (no paid billing UI). */
  price: number;
  /** Soft monthly soft-cap shown in UI when set (e.g. free inbox). */
  messageLimit?: number;
  setupPath: string;
  openPath: string;
  nextSteps: string[];
};

export const PRODUCT_SOLUTIONS: readonly ProductSolutionDefinition[] = [
  {
    code: "leads",
    id: "sol_leads",
    name: "Приём заявок",
    description:
      "Форма заявки в Telegram и ВКонтакте: стандартные и свои вопросы, статусы и «Взять в работу».",
    price: 250,
    setupPath: "/solutions/leads/setup",
    openPath: "/leads",
    nextSteps: [
      "Настроить форму заявки",
      "Подключить Telegram или VK",
      "Принимать обращения в разделе «Заявки»",
    ],
  },
  {
    code: "orders",
    id: "sol_orders",
    name: "Приём заказов",
    description:
      "Каталог, товары, варианты, остатки и обработка заказов из бота.",
    price: 250,
    setupPath: "/orders?tab=catalog",
    openPath: "/orders",
    nextSteps: [
      "Выбрать тип бизнеса",
      "Добавить первый товар или услугу",
      "Настроить доставку и самовывоз",
      "Подключить каналы Telegram / VK",
      "Проверить готовность и принимать заказы",
    ],
  },
  {
    code: "booking",
    id: "sol_booking",
    name: "Онлайн-запись",
    description:
      "Услуги, специалисты, расписание, переносы и отмены для клиентов.",
    price: 250,
    setupPath: "/bookings?tab=config",
    openPath: "/bookings",
    nextSteps: [
      "Создать услугу",
      "Добавить специалиста или режим без выбора",
      "Настроить расписание",
    ],
  },
  {
    code: "admin_messages",
    id: "sol_admin_messages",
    name: "Связь с администратором",
    description:
      "Единый inbox: диалоги Telegram и VK, клиент, заявки, заказы и записи.",
    price: 0,
    messageLimit: 300,
    setupPath: "/connections",
    openPath: "/messages",
    nextSteps: [
      "Подключить Telegram или VK",
      "Открыть «Сообщения»",
      "Отвечать клиентам и брать диалоги в работу",
    ],
  },
  {
    code: "autopost",
    id: "sol_autopost",
    name: "Автопостинг",
    description:
      "Публикации в Telegram и VK: текст, вложения, AI-черновик, расписание.",
    price: 250,
    setupPath: "/posts",
    openPath: "/posts",
    nextSteps: [
      "Выбрать площадку Telegram или VK",
      "Создать первую публикацию",
      "Запланировать или опубликовать",
    ],
  },
] as const;

export function productSolutionByCode(code: string) {
  const normalized = code === "sales" ? "orders" : code;
  return PRODUCT_SOLUTIONS.find((item) => item.code === normalized) ?? null;
}

export function productSolutionCta(
  status: string,
  code?: string,
  entitlementStatus?: string,
): string {
  if (entitlementStatus === "disabled") return "Подключить снова";
  if (entitlementStatus === "paused") return "Возобновить";
  switch (status) {
    case "active":
      return code === "admin_messages" ? "Открыть" : "Настроить";
    case "setup_required":
      return "Продолжить настройку";
    case "paused":
      return "Продолжить настройку";
    case "available":
      return "Подключить";
    case "unavailable":
      return "Недоступно";
    default:
      return "Подключить";
  }
}

export function productSolutionHref(status: string, code: string): string {
  const def = productSolutionByCode(code);
  if (!def) return "/solutions";
  if (status === "available") return def.setupPath;
  if (status === "setup_required" || status === "paused") return def.setupPath;
  return def.openPath;
}

export function formatSolutionPrice(price: number, messageLimit?: number) {
  if (price <= 0) {
    return messageLimit
      ? `Бесплатно · до ${messageLimit} сообщений/мес.`
      : "Бесплатно";
  }
  return `${price} ₽/мес.`;
}
