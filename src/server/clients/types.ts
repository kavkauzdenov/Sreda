/** Clients V2 shared types and cursor helpers. */

export type ClientChannel = "telegram" | "vk" | "whatsapp" | "instagram";

export type ClientActivityFilter =
  | "today"
  | "7d"
  | "30d"
  | "inactive";

export type ClientListFilters = {
  search?: string;
  channel?: ClientChannel | "";
  activity?: ClientActivityFilter | "";
  hasLeads?: boolean;
  hasOrders?: boolean;
  hasBookings?: boolean;
  hasOpenConversation?: boolean;
  hasNotes?: boolean;
  tagId?: string;
  assignedUserId?: string;
  newOnly?: boolean;
  cursor?: string;
  limit?: number;
};

export type ClientSummary = {
  total: number;
  new30d: number;
  active30d: number;
  openConversations: number;
};

export type ClientTagDto = {
  id: string;
  name: string;
  colorKey: string;
};

export type ClientAssigneeDto = {
  id: string;
  name: string;
  role: string;
} | null;

export type ClientIdentityDto = {
  kind: string;
  value: string;
  username: string | null;
};

export type ClientLastActivityDto = {
  type: string;
  title: string;
  createdAt: string;
} | null;

export type ClientListItemDto = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  identities: ClientIdentityDto[];
  tags: ClientTagDto[];
  assignedUser: ClientAssigneeDto;
  leadCount: number;
  orderCount: number;
  bookingCount: number;
  openConversation: boolean;
  lastActivity: ClientLastActivityDto;
};

export type ClientListResponse = {
  items: ClientListItemDto[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type TimelineItemDto = {
  id: string;
  type: string;
  createdAt: string;
  title: string;
  description: string | null;
  actor: string | null;
  entityType: string | null;
  entityId: string | null;
  targetPath: string | null;
  metadata: Record<string, unknown> | null;
};

export function encodeClientCursor(lastSeenAt: Date, id: string): string {
  const payload = JSON.stringify({
    t: lastSeenAt.toISOString(),
    id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeClientCursor(raw: string): { t: Date; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, "base64url").toString("utf8"),
    ) as { t?: string; id?: string };
    if (
      typeof parsed.t !== "string" ||
      typeof parsed.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(parsed.id)
    ) {
      throw new Error("bad");
    }
    const t = new Date(parsed.t);
    if (Number.isNaN(t.getTime())) throw new Error("bad");
    return { t, id: parsed.id };
  } catch {
    throw Object.assign(new Error("INVALID_CURSOR"), { code: "INVALID_CURSOR" });
  }
}

export function encodeTimelineCursor(createdAt: Date, id: string): string {
  return encodeClientCursor(createdAt, id);
}

export function decodeTimelineCursor(raw: string) {
  return decodeClientCursor(raw);
}

export function normalizeTagName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function pairClients(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export const ACTIVITY_LABELS: Record<string, string> = {
  "client.created": "Клиент создан",
  "client.updated": "Карточка обновлена",
  "client.assigned": "Назначен ответственный",
  "client.reassigned": "Ответственный изменён",
  "client.profile_note_updated": "Профильная заметка обновлена",
  "client.merged": "Клиенты объединены",
  "client.note_added": "Добавлена внутренняя заметка",
  "lead.created": "Клиент оставил заявку",
  "lead.processing": "Заявка взята в работу",
  "lead.closed": "Заявка закрыта",
  "lead.assigned": "Заявка назначена",
  "message.received": "Клиент написал сообщение",
  "message.sent": "Сообщение отправлено клиенту",
  "order.created": "Создан заказ",
  "order.status": "Статус заказа изменён",
  "booking.created": "Создана запись",
  "booking.rescheduled": "Запись перенесена",
  "booking.cancelled": "Запись отменена",
  "booking.completed": "Запись завершена",
  "booking.no_show": "Клиент не пришёл",
};

export function activityTitle(type: string, metadata?: unknown): string {
  const base = ACTIVITY_LABELS[type] ?? type;
  if (!metadata || typeof metadata !== "object") return base;
  const meta = metadata as Record<string, unknown>;
  if (type === "order.created" && meta.number != null)
    return `Создан заказ №${meta.number}`;
  if (type === "lead.created" && meta.number != null)
    return `Клиент оставил заявку №${meta.number}`;
  if (type.startsWith("message.") && typeof meta.platform === "string") {
    const platform =
      meta.platform === "telegram"
        ? "Telegram"
        : meta.platform === "vk"
          ? "VK"
          : String(meta.platform);
    return type === "message.received"
      ? `Клиент написал в ${platform}`
      : `Сообщение отправлено в ${platform}`;
  }
  return base;
}
