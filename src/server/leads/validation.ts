import { normalizeIdentity } from "../clients/service.ts";
import { AppError } from "../http/errors.ts";

export type FormFieldSnapshot = {
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  placeholder: string;
  options: Array<string | { label: string; value: string }>;
  position: number;
};

export type LeadFormSnapshot = {
  version: 2;
  buttonLabel: string;
  greeting: string;
  finalMessage: string;
  fields: FormFieldSnapshot[];
  capturedAt: string;
};

function optionValues(options: FormFieldSnapshot["options"]): string[] {
  return options.map((o) => (typeof o === "string" ? o : o.value || o.label));
}

function optionLabels(options: FormFieldSnapshot["options"]): string[] {
  return options.map((o) => (typeof o === "string" ? o : o.label));
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function validateLeadAnswer(
  field: FormFieldSnapshot,
  raw: string,
  opts: { skip?: boolean } = {},
): { ok: true; value: string | string[] | boolean | null } | { ok: false; message: string } {
  const text = raw.trim();
  if (opts.skip || text === "/skip" || text === "Пропустить") {
    if (field.required)
      return { ok: false, message: "Это обязательный вопрос — ответьте, пожалуйста." };
    return { ok: true, value: null };
  }
  if (!text && field.required)
    return { ok: false, message: "Это обязательный вопрос — ответьте, пожалуйста." };
  if (!text) return { ok: true, value: null };
  if (CONTROL.test(text))
    return { ok: false, message: "Уберите спецсимволы из ответа." };

  switch (field.fieldType) {
    case "name":
    case "text":
    case "service":
    case "address":
    case "message":
    case "textarea": {
      const max =
        field.fieldType === "name"
          ? 100
          : field.fieldType === "textarea" || field.fieldType === "message"
            ? 2000
            : 900;
      if (text.length > max)
        return { ok: false, message: `Слишком длинный ответ (макс. ${max}).` };
      return { ok: true, value: text };
    }
    case "phone": {
      try {
        return { ok: true, value: normalizeIdentity({ kind: "phone", value: text }).value };
      } catch {
        return { ok: false, message: "Введите телефон в формате +79991234567." };
      }
    }
    case "email": {
      try {
        return { ok: true, value: normalizeIdentity({ kind: "email", value: text }).value };
      } catch {
        return { ok: false, message: "Проверьте email." };
      }
    }
    case "number": {
      if (!/^-?\d+([.,]\d+)?$/.test(text))
        return { ok: false, message: "Введите число." };
      return { ok: true, value: text.replace(",", ".") };
    }
    case "budget": {
      // Store as digit string (kopecks-friendly); reject floats with many decimals.
      const cleaned = text.replace(/\s/g, "").replace(",", ".");
      if (!/^\d+(\.\d{1,2})?$/.test(cleaned) && !/^\d+$/.test(cleaned.replace(/\D/g, ""))) {
        // Allow "от 10000" style lightly
        if (text.length > 80)
          return { ok: false, message: "Укажите бюджет короче." };
        return { ok: true, value: text };
      }
      return { ok: true, value: cleaned };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text) && !/^\d{1,2}[./]\d{1,2}[./]\d{2,4}$/.test(text))
        return { ok: false, message: "Укажите дату, например 25.12.2026." };
      return { ok: true, value: text };
    }
    case "checkbox": {
      const lower = text.toLowerCase();
      if (["да", "yes", "true", "1", "+", "✓"].includes(lower))
        return { ok: true, value: true };
      if (["нет", "no", "false", "0", "-"].includes(lower))
        return { ok: true, value: false };
      return { ok: false, message: "Ответьте «Да» или «Нет»." };
    }
    case "select": {
      const values = optionValues(field.options);
      const labels = optionLabels(field.options);
      const idx = labels.findIndex((l) => l === text);
      if (idx >= 0) return { ok: true, value: values[idx]! };
      if (values.includes(text)) return { ok: true, value: text };
      return { ok: false, message: "Выберите вариант из списка." };
    }
    case "multiselect": {
      // Comma-separated or single; full multi collected via "Готово" in bot flow.
      const values = optionValues(field.options);
      const labels = optionLabels(field.options);
      const parts = text.split(",").map((p) => p.trim()).filter(Boolean);
      const resolved: string[] = [];
      for (const part of parts) {
        const idx = labels.findIndex((l) => l === part);
        if (idx >= 0) resolved.push(values[idx]!);
        else if (values.includes(part)) resolved.push(part);
        else return { ok: false, message: "Выберите варианты из списка." };
      }
      return { ok: true, value: resolved };
    }
    case "attachment": {
      // Bot flow sets this via attachment handler; plain text rejected.
      return {
        ok: false,
        message: "Пришлите фото или файл.",
      };
    }
    default:
      if (text.length > 900)
        return { ok: false, message: "Слишком длинный ответ." };
      return { ok: true, value: text };
  }
}

export function promptForField(field: FormFieldSnapshot): string {
  const requiredMark = field.required ? "" : "\nМожно пропустить: Пропустить";
  const hint = field.placeholder ? `\n${field.placeholder}` : "";
  if (field.fieldType === "checkbox")
    return `${field.label}${hint}\nОтветьте «Да» или «Нет».${requiredMark}`;
  if (field.fieldType === "select" || field.fieldType === "multiselect") {
    const extra =
      field.fieldType === "multiselect"
        ? "\nМожно выбрать несколько. Когда закончите — нажмите «✓ Готово»."
        : "";
    return `${field.label}${hint}${extra}${requiredMark}`;
  }
  if (field.fieldType === "attachment")
    return `${field.label}\nПришлите фото или файл.${requiredMark}`;
  return `${field.label}${hint}${requiredMark}`;
}

export function keyboardForField(
  field: FormFieldSnapshot,
  page = 0,
  pageSize = 7,
): string[] {
  const base: string[] = ["Отмена"];
  if (!field.required) base.unshift("Пропустить");
  if (field.fieldType === "checkbox") return ["Да", "Нет", ...base];
  if (field.fieldType === "select" || field.fieldType === "multiselect") {
    const labels = optionLabels(field.options);
    const start = page * pageSize;
    const slice = labels.slice(start, start + pageSize);
    const nav: string[] = [];
    if (start + pageSize < labels.length) nav.push("Далее →");
    if (page > 0) nav.push("← Назад по списку");
    if (field.fieldType === "multiselect") nav.push("✓ Готово");
    return [...slice, ...nav, ...base];
  }
  return base;
}

export function assertFormSnapshot(raw: unknown): LeadFormSnapshot {
  if (!raw || typeof raw !== "object")
    throw new AppError(400, "INVALID_FORM", "Форма заявки недоступна.");
  const s = raw as LeadFormSnapshot;
  if (s.version !== 2 || !Array.isArray(s.fields) || !s.fields.length)
    throw new AppError(400, "INVALID_FORM", "Форма заявки недоступна.");
  return s;
}
