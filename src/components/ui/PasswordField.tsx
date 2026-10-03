"use client";
import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is positioned against a wrapper that contains ONLY the input, never
 * the label — an absolutely positioned button anchored to a label+input container
 * drifts off the field (it measures from the label's top edge). Vertical centring
 * is done with `top: 50%` + `translateY(-50%)` so the button stays centred when
 * the input height changes (desktop vs mobile), and the space it occupies on the
 * right is reserved on the input itself via padding, so typed text never runs
 * underneath it.
 */
export function PasswordField({
  id,
  value,
  onChange,
  className,
  inputClassName,
  toggleClassName,
  placeholder,
  autoComplete = "current-password",
  minLength = 10,
  maxLength = 128,
  required = true,
  autoFocus,
  inputMode,
  pattern,
  name,
  "aria-describedby": ariaDescribedBy,
  "data-testid": dataTestId,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  /** Class for the positioning wrapper (must establish `position: relative`). */
  className?: string;
  inputClassName?: string;
  toggleClassName?: string;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  inputMode?: "numeric" | "text" | "tel" | "email" | "url" | "search" | "decimal" | "none";
  pattern?: string;
  name?: string;
  "aria-describedby"?: string;
  "data-testid"?: string;
}) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);
  return (
    <span className={className}>
      <input
        id={inputId}
        name={name}
        className={inputClassName}
        type={visible ? "text" : "password"}
        placeholder={placeholder}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        inputMode={inputMode}
        pattern={pattern}
        minLength={minLength}
        maxLength={maxLength}
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={ariaDescribedBy}
        data-testid={dataTestId}
      />
      <button
        type="button"
        className={toggleClassName}
        aria-label={visible ? "Скрыть пароль" : "Показать пароль"}
        aria-controls={inputId}
        aria-pressed={visible}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOff size={20} aria-hidden="true" />
        ) : (
          <Eye size={20} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}

/** Convenience wrapper for the standard `.field` markup used across settings. */
export function LabelledPasswordField({
  label,
  hint,
  ...props
}: {
  label: string;
  hint?: string;
} & React.ComponentProps<typeof PasswordField>) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label className="field" htmlFor={id}>
      <span className="field__label">{label}</span>
      <PasswordField
        {...props}
        id={id}
        className={cn("field__password", props.className)}
        inputClassName={cn("field__control", props.inputClassName)}
        toggleClassName={cn("field__password-toggle", props.toggleClassName)}
        aria-describedby={cn(props["aria-describedby"], hintId) || undefined}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}