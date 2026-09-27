/** Lead Setup V2 — metadata only. Form fields live in lead_form_field (SoT). */

export type LeadChannel = "telegram" | "vk";

export type LeadSetupV2 = {
  version: 2;
  buttonLabel: string;
  greeting: string;
  finalMessage: string;
  channels: LeadChannel[];
  defaultStatus: "new";
  processing: {
    autoAssign: boolean;
    duplicateDetection: boolean;
    firstResponseSlaMinutes: number | null;
  };
  notifications: {
    inApp: boolean;
    staffTelegram: boolean;
    email: boolean;
  };
  setupStep: number;
  completed: boolean;
};

export const LEAD_SETUP_STEPS = [
  { id: 0, title: "О бизнесе" },
  { id: 1, title: "Форма заявки" },
  { id: 2, title: "Каналы" },
  { id: 3, title: "Обработка" },
  { id: 4, title: "Уведомления" },
  { id: 5, title: "Предпросмотр" },
  { id: 6, title: "Проверка и запуск" },
] as const;

export const DEFAULT_BUTTON_LABEL = "Оставить заявку";
export const DEFAULT_GREETING =
  "Здравствуйте! Ответьте на несколько вопросов — это займёт пару минут.";
export const DEFAULT_FINAL_MESSAGE =
  "Спасибо! Заявка принята. Мы скоро свяжемся с вами.";

export const SLA_PRESETS = [null, 15, 30, 60, 120] as const;

export function newLeadSetupV2(): LeadSetupV2 {
  return {
    version: 2,
    buttonLabel: DEFAULT_BUTTON_LABEL,
    greeting: DEFAULT_GREETING,
    finalMessage: DEFAULT_FINAL_MESSAGE,
    channels: [],
    defaultStatus: "new",
    processing: {
      autoAssign: false,
      duplicateDetection: true,
      firstResponseSlaMinutes: null,
    },
    notifications: {
      inApp: true,
      staffTelegram: false,
      email: false,
    },
    setupStep: 0,
    completed: false,
  };
}

export function clampText(value: unknown, max: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, max);
}

export function isLeadChannel(value: unknown): value is LeadChannel {
  return value === "telegram" || value === "vk";
}
