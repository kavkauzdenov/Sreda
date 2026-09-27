/** Форматирование дат и имён для UI (без бизнес-логики). */

const DATE_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const TIME_FORMATTER = new Intl.DateTimeFormat("ru-RU", {
  hour: "2-digit",
  minute: "2-digit",
});

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function partsInZone(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

function zonedDayKey(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function getFirstName(fullName: string): string {
  const [first] = fullName.trim().split(/\s+/);
  return first || fullName;
}

export function getGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 5) return "Доброй ночи";
  if (hour < 12) return "Доброе утро";
  if (hour < 18) return "Добрый день";
  return "Добрый вечер";
}

export function formatRelativeDateTime(
  iso: string,
  now = new Date(),
): string {
  const date = new Date(iso);
  const today = startOfDay(now);
  const target = startOfDay(date);
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
  );
  const time = TIME_FORMATTER.format(date);

  if (diffDays === 0) return `Сегодня, ${time}`;
  if (diffDays === -1) return `Вчера, ${time}`;
  if (diffDays === 1) return `Завтра, ${time}`;

  return DATE_FORMATTER.format(date);
}

/** Relative datetime in a business timezone (not the browser zone). */
export function formatRelativeDateTimeInZone(
  iso: string,
  timeZone: string,
  now = new Date(),
): string {
  const date = new Date(iso);
  const zone = timeZone || "UTC";
  const todayKey = zonedDayKey(now, zone);
  const targetKey = zonedDayKey(date, zone);
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  const [ty, tm, td] = todayKey.split("-").map(Number);
  const [ay, am, ad] = targetKey.split("-").map(Number);
  const todayUtc = Date.UTC(ty!, tm! - 1, td!);
  const targetUtc = Date.UTC(ay!, am! - 1, ad!);
  const diffDays = Math.round((targetUtc - todayUtc) / 86400000);

  if (diffDays === 0) return `Сегодня, ${time}`;
  if (diffDays === -1) return `Вчера, ${time}`;
  if (diffDays === 1) return `Завтра, ${time}`;

  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function formatMoney(
  amount: string | number,
  currency = "RUB",
): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(value)) return String(amount);
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString("ru-RU")} ${currency}`;
  }
}

export function formatMoneyRub(amount: number): string {
  return `${amount.toLocaleString("ru-RU")} ₽/мес.`;
}

export function initialsFromName(name: string): string {
  const cleaned = name.replace(/[«»“”"']/g, " ").replace(/\s+/g, " ").trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return `${parts[0]!.slice(0, 1)}${parts[1]!.slice(0, 1)}`.toUpperCase();
}
