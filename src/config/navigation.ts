import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Calendar,
  CalendarDays,
  MessageCircle,
  Bell,
  CreditCard,
  FileText,
  Home,
  Inbox,
  Settings,
  ShoppingBag,
  Sparkles,
  Users,
  Brain,
} from "lucide-react";
import { APP_NAME, APP_TAGLINE, SUPPORT_TELEGRAM_URL } from "@/config/brand";

export { APP_NAME, APP_TAGLINE, SUPPORT_TELEGRAM_URL };

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
}

/** Desktop sidebar primary navigation — order matches Biznesoty design. */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Главная", icon: Home },
  { href: "/solutions", label: "Решения", icon: Sparkles },
  { href: "/messages", label: "Сообщения", icon: MessageCircle },
  { href: "/orders", label: "Заказы", icon: ShoppingBag },
  { href: "/leads", label: "Заявки", icon: Inbox },
  { href: "/bookings", label: "Запись", icon: CalendarDays },
  { href: "/posts", label: "Посты", icon: FileText },
  { href: "/clients", label: "Клиенты", icon: Users },
  { href: "/settings", label: "Настройки", icon: Settings },
];

/** Secondary items available via «Ещё» / settings areas. */
export const SECONDARY_NAV_ITEMS: NavItem[] = [
  { href: "/intelligence", label: "Intelligence", icon: Brain },
  { href: "/analytics", label: "Аналитика", icon: BarChart3 },
  { href: "/calendar", label: "Календарь", icon: Calendar },
  { href: "/notifications", label: "Уведомления", icon: Bell },
  { href: "/billing", label: "Тариф", icon: CreditCard },
];

export const MOBILE_BOTTOM_NAV: NavItem[] = [
  { href: "/dashboard", label: "Главная", icon: Home },
  { href: "/messages", label: "Сообщения", icon: MessageCircle },
  { href: "/orders", label: "Заказы", icon: ShoppingBag },
  { href: "/settings", label: "Настройки", icon: Settings },
];
