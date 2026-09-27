"use client";

import { useEffect, useRef, useState } from "react";
import { useDialogFocusTrap } from "@/hooks/useDialogFocusTrap";
import type { InventoryRow } from "@/components/orders-v2/types";
import { adjustInventory } from "@/services/orders.service";

export function StockEditor({
  businessId,
  row,
  onClose,
  onSaved,
}: {
  businessId: string;
  row: InventoryRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const [mode, setMode] = useState<"set" | "delta">("set");
  const [quantity, setQuantity] = useState(
    row.stockQuantity != null ? String(row.stockQuantity) : "0",
  );
  const [delta, setDelta] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useDialogFocusTrap(dialogRef, onClose);

  useEffect(() => {
    setQuantity(row.stockQuantity != null ? String(row.stockQuantity) : "0");
  }, [row.stockQuantity]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "delta") {
        const n = Number(delta);
        if (!Number.isInteger(n)) {
          setError("Укажите целое изменение.");
          setBusy(false);
          return;
        }
        await adjustInventory(businessId, {
          productId: row.productId,
          variantId: row.variantId,
          delta: n,
        });
      } else {
        const n = Number(quantity);
        if (!Number.isInteger(n) || n < 0) {
          setError("Укажите целое количество ≥ 0.");
          setBusy(false);
          return;
        }
        await adjustInventory(businessId, {
          productId: row.productId,
          variantId: row.variantId,
          quantity: n,
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Не удалось обновить остаток.",
      );
    } finally {
      setBusy(false);
    }
  }

  const title = row.variantLabel
    ? `${row.name} · ${row.variantLabel}`
    : row.name;

  return (
    <div
      className="client-dialog-overlay"
      role="presentation"
      onClick={onClose}
    >
      <form
        ref={dialogRef}
        className="client-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Изменить остаток"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => void submit(e)}
      >
        <header className="client-dialog__head">
          <h2>Остаток</h2>
          <button
            type="button"
            className="button button--ghost"
            onClick={onClose}
          >
            Закрыть
          </button>
        </header>
        <p>
          <strong>{title}</strong>
        </p>
        {error ? (
          <p className="account-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="orders-create-dialog__client-mode">
          <button
            type="button"
            className={
              mode === "set" ? "button button--primary" : "button button--outline"
            }
            onClick={() => setMode("set")}
          >
            Установить
          </button>
          <button
            type="button"
            className={
              mode === "delta"
                ? "button button--primary"
                : "button button--outline"
            }
            onClick={() => setMode("delta")}
          >
            Изменить на
          </button>
        </div>
        {mode === "set" ? (
          <label className="field">
            <span className="field__label">Количество</span>
            <input
              className="field__control"
              inputMode="numeric"
              value={quantity}
              disabled={busy}
              onChange={(e) => setQuantity(e.target.value)}
              autoFocus
            />
          </label>
        ) : (
          <label className="field">
            <span className="field__label">Дельта (+/−)</span>
            <input
              className="field__control"
              inputMode="numeric"
              value={delta}
              disabled={busy}
              onChange={(e) => setDelta(e.target.value)}
              autoFocus
            />
          </label>
        )}
        <div className="client-dialog__actions">
          <button type="submit" className="button button--primary" disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button
            type="button"
            className="button button--outline"
            onClick={onClose}
          >
            Отмена
          </button>
        </div>
      </form>
    </div>
  );
}
