"use client";

import { useSyncExternalStore } from "react";

/** Greeting bands by local hour. Kept in one place so the dashboard and tests agree. */
export function greetingForHour(hour: number): string {
  if (!Number.isFinite(hour)) return "Добрый день";
  const normalized = ((Math.floor(hour) % 24) + 24) % 24;
  if (normalized < 5) return "Доброй ночи";
  if (normalized < 12) return "Доброе утро";
  if (normalized < 18) return "Добрый день";
  return "Добрый вечер";
}

const subscribe = () => () => {};
const serverSnapshot = () => "";
const subscribeToMinuteTick = (onChange: () => void) => {
  const timer = window.setInterval(onChange, 60_000);
  window.addEventListener("focus", onChange);
  return () => {
    window.clearInterval(timer);
    window.removeEventListener("focus", onChange);
  };
};

/**
 * Time-of-day greeting in the viewer's own timezone.
 *
 * `useSyncExternalStore` gives us two things for free: the server renders an
 * empty string (so there is no hydration mismatch and no UTC-based greeting for
 * someone in another timezone), and the value re-reads on focus/minute ticks so
 * a long-lived tab doesn't keep a stale greeting.
 */
export function useLocalGreeting(): string {
  return useSyncExternalStore(
    subscribeToMinuteTick,
    () => greetingForHour(new Date().getHours()),
    serverSnapshot,
  );
}

/** Long-form local date, e.g. «пятница, 3 октября». Empty on the server. */
export function useLocalDateLabel(): string {
  return useSyncExternalStore(
    subscribe,
    () =>
      new Intl.DateTimeFormat("ru-RU", {
        weekday: "long",
        day: "numeric",
        month: "long",
      }).format(new Date()),
    serverSnapshot,
  );
}