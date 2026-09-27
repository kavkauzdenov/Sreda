import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { normalizeSolutionCode } from "../solutions/catalog.ts";
import { loadLeadSetupV2, parseLeadSetupV2 } from "./setup.ts";

type Db = Kysely<Database> | Transaction<Database>;

export type LeadReadinessCheck = {
  code: string;
  ok: boolean;
  message?: string;
  cta?: { label: string; href: string };
};

export type LeadReadiness = {
  ready: boolean;
  checks: LeadReadinessCheck[];
  setup: ReturnType<typeof parseLeadSetupV2>;
  revision: number;
};

const SELECT_TYPES = new Set(["select", "multiselect"]);

/**
 * Single source of truth for «Приём заявок» readiness.
 * Used by wizard, solutions card, bot gating, and launch.
 */
export async function getLeadReadiness(
  db: Db,
  businessId: string,
  setupOverride?: ReturnType<typeof parseLeadSetupV2>,
): Promise<LeadReadiness> {
  const checks: LeadReadinessCheck[] = [];
  const loaded = await loadLeadSetupV2(db, businessId);
  const setup = setupOverride ?? loaded.setup;
  const revision = loaded.revision;

  const now = new Date();
  const entitlement = await db
    .selectFrom("business_solution")
    .select(["status", "expires_at", "solution_code"])
    .where("business_id", "=", businessId)
    .where("solution_code", "in", ["leads", "sol_leads"])
    .executeTakeFirst();

  // Entitlement is granted on launch — for readiness we allow "can launch" without it,
  // but flag if disabled/paused after activation.
  const entitlementBlocked =
    entitlement?.status === "disabled" ||
    entitlement?.status === "paused" ||
    entitlement?.status === "expired" ||
    Boolean(entitlement?.expires_at && entitlement.expires_at <= now);
  if (entitlementBlocked) {
    checks.push({
      code: "ENTITLEMENT",
      ok: false,
      message:
        entitlement?.status === "paused"
          ? "Решение приостановлено. Возобновите его в разделе «Решения»."
          : "Решение недоступно. Включите его в разделе «Решения».",
      cta: { label: "Открыть решения", href: "/solutions" },
    });
  } else {
    // Absence is allowed before first launch: entitlement is granted during launch.
    checks.push({ code: "ENTITLEMENT", ok: true });
  }

  const fields = await db
    .selectFrom("lead_form_field")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("active", "=", true)
    .orderBy("position")
    .execute();

  const hasName = fields.some(
    (f) => f.field_key === "name" && f.required && f.field_type === "name",
  );
  if (!fields.length || !hasName) {
    checks.push({
      code: "FORM_FIELDS",
      ok: false,
      message: "Добавьте поля формы — имя обязательно.",
      cta: { label: "Настроить форму", href: "/solutions/leads/setup" },
    });
  } else {
    let optionsOk = true;
    for (const field of fields) {
      if (SELECT_TYPES.has(field.field_type)) {
        const opts = Array.isArray(field.options) ? field.options : [];
        if (opts.length < 1) {
          optionsOk = false;
          break;
        }
      }
    }
    checks.push(
      optionsOk
        ? { code: "FORM_FIELDS", ok: true }
        : {
            code: "FORM_FIELDS",
            ok: false,
            message: "У полей со списком должен быть хотя бы один вариант.",
          },
    );
  }

  const messagesOk =
    setup.buttonLabel.trim().length > 0 &&
    setup.greeting.trim().length > 0 &&
    setup.finalMessage.trim().length > 0;
  checks.push(
    messagesOk
      ? { code: "MESSAGES", ok: true }
      : {
          code: "MESSAGES",
          ok: false,
          message: "Заполните название кнопки, приветствие и финальный текст.",
        },
  );

  if (!setup.channels.length) {
    checks.push({
      code: "CHANNELS",
      ok: false,
      message: "Выберите хотя бы один канал: Telegram или VK.",
      cta: { label: "Выбрать каналы", href: "/solutions/leads/setup" },
    });
  } else {
    checks.push({ code: "CHANNELS", ok: true });
  }

  for (const channel of setup.channels) {
    const connection = await db
      .selectFrom("business_connection")
      .select(["id", "status"])
      .where("business_id", "=", businessId)
      .where("platform", "=", channel)
      .executeTakeFirst();

    if (!connection || connection.status !== "connected") {
      checks.push({
        code: channel === "telegram" ? "CHANNEL_TELEGRAM" : "CHANNEL_VK",
        ok: false,
        message:
          channel === "telegram"
            ? "Подключите Telegram"
            : "Подключите ВКонтакте",
        cta: {
          label: channel === "telegram" ? "Подключить Telegram" : "Подключить VK",
          href: "/connections",
        },
      });
      continue;
    }

    if (channel === "telegram") {
      const runtime = await db
        .selectFrom("telegram_runtime")
        .select("status")
        .where("connection_id", "=", connection.id)
        .executeTakeFirst();
      if (!runtime || runtime.status !== "ready") {
        checks.push({
          code: "CHANNEL_TELEGRAM",
          ok: false,
          message:
            runtime?.status === "error"
              ? "Ошибка запуска Telegram-бота"
              : "Telegram-бот не запущен",
          cta: { label: "Запустить бота", href: "/connections" },
        });
      } else {
        checks.push({ code: "CHANNEL_TELEGRAM", ok: true });
      }
    } else {
      const runtime = await db
        .selectFrom("vk_runtime")
        .select("status")
        .where("connection_id", "=", connection.id)
        .executeTakeFirst();
      if (!runtime || runtime.status !== "ready") {
        checks.push({
          code: "CHANNEL_VK",
          ok: false,
          message:
            runtime?.status === "error"
              ? "Ошибка запуска VK-бота"
              : "VK-бот не запущен",
          cta: { label: "Запустить бота", href: "/connections" },
        });
      } else {
        checks.push({ code: "CHANNEL_VK", ok: true });
      }
    }
  }

  // If channel not selected, still report as N/A skipped — already covered by CHANNELS.
  const ready = checks.every((c) => c.ok);
  return { ready, checks, setup, revision };
}

export function leadSolutionCardState(
  readiness: LeadReadiness,
  entitled: boolean,
) {
  const entitlementFail = readiness.checks.find(
    (c) => c.code === "ENTITLEMENT" && !c.ok,
  );
  if (entitlementFail) {
    return {
      state: "paused" as const,
      label: "Выключено",
      detail: entitlementFail.message,
      actionLabel: "Открыть решения",
      href: entitlementFail.cta?.href ?? "/solutions",
    };
  }

  if (entitled && readiness.ready && readiness.setup.completed) {
    return {
      state: "active" as const,
      label: "Работает",
      actionLabel: "Открыть",
      href: "/leads",
    };
  }

  const channelFail = readiness.checks.find(
    (c) =>
      !c.ok &&
      (c.code === "CHANNEL_TELEGRAM" || c.code === "CHANNEL_VK"),
  );
  if (readiness.setup.completed && channelFail) {
    return {
      state: "attention" as const,
      label: "Требует внимания",
      detail: channelFail.message,
      actionLabel: "Исправить",
      href: channelFail.cta?.href ?? "/connections",
    };
  }

  if (readiness.ready && !readiness.setup.completed) {
    return {
      state: "ready" as const,
      label: "Готово к запуску",
      actionLabel: "Запустить",
      href: "/solutions/leads/setup",
    };
  }

  if (readiness.setup.setupStep > 0 || readiness.setup.completed) {
    return {
      state: "in_progress" as const,
      label: "Настройка не завершена",
      actionLabel: "Продолжить настройку",
      href: "/solutions/leads/setup",
    };
  }

  return {
    state: "not_configured" as const,
    label: "Не настроено",
    actionLabel: "Настроить",
    href: "/solutions/leads/setup",
  };
}

export async function isLeadCustomerReady(
  db: Db,
  businessId: string,
  platform: "telegram" | "vk",
): Promise<{ ready: boolean; buttonLabel: string }> {
  const now = new Date();
  const enabled = await db
    .selectFrom("business_solution")
    .select(["solution_code", "status", "expires_at"])
    .where("business_id", "=", businessId)
    .where("status", "in", ["active", "trial"])
    .where((eb) =>
      eb.or([eb("expires_at", "is", null), eb("expires_at", ">", now)]),
    )
    .execute();
  const codes = new Set(
    enabled.map((row) => normalizeSolutionCode(row.solution_code)),
  );
  if (!codes.has("leads")) return { ready: false, buttonLabel: "Оставить заявку" };

  const { setup } = await loadLeadSetupV2(db, businessId);
  if (!setup.completed || !setup.channels.includes(platform)) {
    return { ready: false, buttonLabel: setup.buttonLabel };
  }

  const connection = await db
    .selectFrom("business_connection")
    .select(["id", "status"])
    .where("business_id", "=", businessId)
    .where("platform", "=", platform)
    .where("status", "=", "connected")
    .executeTakeFirst();
  if (!connection) return { ready: false, buttonLabel: setup.buttonLabel };

  if (platform === "telegram") {
    const runtime = await db
      .selectFrom("telegram_runtime")
      .select("status")
      .where("connection_id", "=", connection.id)
      .executeTakeFirst();
    if (runtime?.status !== "ready")
      return { ready: false, buttonLabel: setup.buttonLabel };
  } else {
    const runtime = await db
      .selectFrom("vk_runtime")
      .select("status")
      .where("connection_id", "=", connection.id)
      .executeTakeFirst();
    if (runtime?.status !== "ready")
      return { ready: false, buttonLabel: setup.buttonLabel };
  }

  return { ready: true, buttonLabel: setup.buttonLabel };
}
