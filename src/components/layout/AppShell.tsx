"use client";
import { NotificationBell } from "../notifications/NotificationBell";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Ellipsis,
  Plus,
  BarChart3,
  Brain,
  ChevronDown,
} from "lucide-react";
import {
  BusinessProvider,
  useBusinessContext,
} from "@/hooks/useBusinessContext";
import { Sidebar } from "@/components/layout/Sidebar";
import { Brand } from "@/components/ui/Brand";
import { SignOutButton } from "@/components/account/SignOutButton";
import { CommandSearch } from "@/components/dashboard/CommandSearch";
import { MOBILE_BOTTOM_NAV } from "@/config/navigation";
import type { User } from "@/types";

const CREATE_ACTIONS = [
  { href: "/orders", label: "Заказ" },
  { href: "/leads", label: "Заявка" },
  { href: "/bookings", label: "Запись" },
  { href: "/clients", label: "Клиент" },
  { href: "/posts", label: "Пост" },
  { href: "/calendar", label: "Событие" },
] as const;

function AppShellInner({ children }: { children: React.ReactNode }) {
  const { user, currentBusiness } = useBusinessContext();
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const menu = useRef<HTMLDialogElement>(null);
  const createRef = useRef<HTMLDivElement>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);

  useEffect(() => {
    const dialog = menu.current;
    if (!dialog) return;
    if (open) dialog.showModal();
    else dialog.close();
    const old = document.body.style.overflow;
    if (open) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = old;
    };
  }, [open]);

  useEffect(() => {
    if (!createOpen && !profileOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (
        createOpen &&
        createRef.current &&
        !createRef.current.contains(e.target as Node)
      ) {
        setCreateOpen(false);
      }
      if (
        profileOpen &&
        profileRef.current &&
        !profileRef.current.contains(e.target as Node)
      ) {
        setProfileOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [createOpen, profileOpen]);

  const role = currentBusiness?.role;
  const roleLabel =
    role === "owner"
      ? "Владелец"
      : role === "admin"
        ? "Администратор"
        : role === "operator"
          ? "Сотрудник"
          : "Участник";

  return (
    <div className="app-shell">
      <div className="desktop-sidebar">
        <Sidebar />
      </div>
      <dialog
        ref={menu}
        className="mobile-menu"
        aria-label="Меню навигации"
        onCancel={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
      >
        <Sidebar mobile onClose={() => setOpen(false)} />
      </dialog>
      <div className="app-main">
        <header className="desktop-topbar" aria-label="Панель инструментов">
          <div className="desktop-topbar__spacer" />
          <div className="desktop-topbar__actions">
            <div className="desktop-topbar__utility">
              <CommandSearch compact />
              <Link
                href="/intelligence"
                className="icon-button"
                aria-label="Intelligence"
              >
                <Brain size={20} strokeWidth={1.7} aria-hidden />
              </Link>
              <Link
                href="/analytics"
                className="icon-button"
                aria-label="Аналитика"
              >
                <BarChart3 size={20} strokeWidth={1.7} aria-hidden />
              </Link>
              <NotificationBell />
            </div>
            <div className="create-menu" ref={createRef}>
              <button
                type="button"
                className="button button--primary create-menu__trigger"
                aria-expanded={createOpen}
                aria-haspopup="menu"
                onClick={() => setCreateOpen((v) => !v)}
              >
                <Plus size={18} strokeWidth={2.2} />
                Добавить
              </button>
              {createOpen && (
                <ul className="create-menu__panel" role="menu">
                  {CREATE_ACTIONS.map((action) => (
                    <li key={action.href} role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className="create-menu__item"
                        onClick={() => {
                          setCreateOpen(false);
                          router.push(action.href);
                        }}
                      >
                        {action.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="profile-menu" ref={profileRef}>
              <button
                type="button"
                className="desktop-profile"
                aria-expanded={profileOpen}
                aria-haspopup="menu"
                aria-label="Меню профиля"
                onClick={() => setProfileOpen((v) => !v)}
              >
                <span className="profile-avatar" aria-hidden>
                  {user.name.slice(0, 1)}
                </span>
                <span className="desktop-profile__meta">
                  <strong>{user.name}</strong>
                  <small>{roleLabel}</small>
                </span>
                <ChevronDown size={16} aria-hidden />
              </button>
              {profileOpen && (
                <ul className="profile-menu__panel" role="menu">
                  <li role="none">
                    <Link
                      href="/settings"
                      role="menuitem"
                      className="profile-menu__item"
                      onClick={() => setProfileOpen(false)}
                    >
                      Настройки
                    </Link>
                  </li>
                  <li role="none" className="profile-menu__sign-out">
                    <SignOutButton
                      variant="menu"
                      onSignedOut={() => setProfileOpen(false)}
                    />
                  </li>
                </ul>
              )}
            </div>
          </div>
        </header>

        <header className="mobile-header">
          <div className="mobile-header__brand">
            <Brand compact showTagline={false} />
          </div>
          <div className="mobile-header__actions">
            <CommandSearch mobile />
            <NotificationBell />
          </div>
        </header>

        <main
          id="main-content"
          className={pathname === "/dashboard" ? "main-dashboard" : "secondary-page"}
        >
          {children}
        </main>
      </div>
      <nav className="mobile-bottom-nav" aria-label="Быстрая навигация">
        {MOBILE_BOTTOM_NAV.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={
                pathname === item.href || pathname.startsWith(`${item.href}/`)
                  ? "page"
                  : undefined
              }
            >
              <Icon size={22} strokeWidth={1.7} />
              <span>{item.label}</span>
            </Link>
          );
        })}
        <button type="button" onClick={() => setOpen(true)} aria-expanded={open}>
          <Ellipsis size={24} />
          <span>Ещё</span>
        </button>
      </nav>
    </div>
  );
}

export function AppShell({
  children,
  user,
}: {
  children: React.ReactNode;
  user: User;
}) {
  return (
    <BusinessProvider user={user}>
      <a href="#main-content" className="skip-link">
        К содержимому
      </a>
      <AppShellInner>{children}</AppShellInner>
    </BusinessProvider>
  );
}
