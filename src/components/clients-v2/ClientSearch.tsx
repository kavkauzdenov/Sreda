"use client";

import { useEffect, useEffectEvent, useState } from "react";

export function ClientSearch({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = useEffectEvent((next: string) => {
    if (next === value) return;
    onChange(next);
  });

  useEffect(() => {
    const timer = window.setTimeout(() => commit(draft), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);

  return (
    <label className="field clients-search">
      <span className="field__label">Поиск</span>
      <input
        className="field__control"
        type="search"
        value={draft}
        disabled={disabled}
        placeholder="Имя, телефон, email, Telegram или VK…"
        onChange={(e) => setDraft(e.target.value)}
      />
    </label>
  );
}
