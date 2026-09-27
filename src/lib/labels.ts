import type { LeadStatus, Platform, PostStatus, SolutionStatus } from "@/types";

export function platformLabel(platform: Platform): string {
  switch (platform) {
    case "telegram":
      return "Telegram";
    case "vk":
      return "ВКонтакте";
    case "whatsapp":
      return "WhatsApp";
    case "instagram":
      return "Instagram";
    case "max":
      return "MAX";
    default:
      return platform;
  }
}

export function platformsLabel(platforms: Platform[]): string {
  return platforms.map(platformLabel).join(" + ");
}

export function leadStatusLabel(status: LeadStatus): string {
  switch (status) {
    case "new":
      return "Новая";
    case "processing":
      return "В работе";
    case "waiting_customer":
      return "Ждём клиента";
    case "completed":
      return "Выполнена";
    case "rejected":
      return "Отклонена";
    case "closed":
      return "Закрыта";
    default:
      return status;
  }
}

export function postStatusLabel(status: PostStatus): string {
  switch (status) {
    case "draft":
      return "Черновик";
    case "scheduled":
      return "Запланирован";
    case "published":
      return "Опубликован";
    default:
      return status;
  }
}

export function solutionStatusLabel(status: SolutionStatus): string {
  switch (status) {
    case "active":
      return "Подключено";
    case "available":
      return "Не подключено";
    case "setup_required":
      return "Продолжить настройку";
    case "paused":
      return "Нужна проверка";
    case "unavailable":
      return "Недоступно";
    default:
      return status;
  }
}
