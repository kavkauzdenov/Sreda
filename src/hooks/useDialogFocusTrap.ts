"use client";

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared accessible modal focus management:
 * - focus enters the container on open
 * - Tab / Shift+Tab cycle inside
 * - Escape closes
 * - optional body scroll lock
 * - restores focus to the prior element on unmount
 */
export function useDialogFocusTrap(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  {
    enabled = true,
    lockBodyScroll = true,
  }: { enabled?: boolean; lockBodyScroll?: boolean } = {},
) {
  useEffect(() => {
    if (!enabled) return;
    const root = ref.current;
    if (!root) return;

    const previousFocus = document.activeElement as HTMLElement | null;
    const first = root.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();

    const oldOverflow = document.body.style.overflow;
    if (lockBodyScroll) document.body.style.overflow = "hidden";

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const items = Array.from(
        root!.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((item) => item.offsetParent !== null || item === document.activeElement);
      if (!items.length) {
        event.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (lockBodyScroll) document.body.style.overflow = oldOverflow;
      previousFocus?.focus?.();
    };
  }, [enabled, lockBodyScroll, onClose, ref]);
}
