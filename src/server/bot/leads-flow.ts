import type { Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import type { InboundAttachment } from "../attachments/service.ts";
import { MAX_ATTACHMENT } from "../attachments/storage.ts";
import type { OutboxButton } from "./types.ts";
import { createLead } from "../leads/service.ts";
import { loadLeadSetupV2 } from "../leads/setup.ts";
import {
  assertFormSnapshot,
  keyboardForField,
  promptForField,
  validateLeadAnswer,
  type FormFieldSnapshot,
  type LeadFormSnapshot,
} from "../leads/validation.ts";
import { getAvailableCustomerActions } from "../solutions/customer-actions.ts";
import { isLeadCustomerReady } from "../leads/readiness.ts";
import { randomUUID } from "node:crypto";

type Queue = (
  message: string,
  buttons?: OutboxButton[],
  attachmentIds?: string[],
) => Promise<void>;

type Save = (
  mode: string,
  fields?: string[],
  answers?: Record<string, unknown>,
  position?: number,
  snapshot?: LeadFormSnapshot | Record<string, never>,
  extra?: Record<string, unknown>,
) => Promise<void>;

const PAGE_SIZE = 7;
const FLOW_META = "_flow";

function optionLabels(field: FormFieldSnapshot): string[] {
  return field.options.map((o) => (typeof o === "string" ? o : o.label));
}

async function loadActiveFields(
  tx: Transaction<Database>,
  businessId: string,
): Promise<FormFieldSnapshot[]> {
  const rows = await tx
    .selectFrom("lead_form_field")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("active", "=", true)
    .orderBy("position")
    .orderBy("created_at")
    .execute();
  return rows.map((row) => ({
    fieldKey: row.field_key,
    label: row.label,
    fieldType: row.field_type,
    required: row.required,
    placeholder: row.placeholder,
    options: Array.isArray(row.options) ? (row.options as FormFieldSnapshot["options"]) : [],
    position: row.position,
  }));
}

function formatAnswer(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "—";
  return String(value);
}

/**
 * Dynamic leads questionnaire for Telegram/VK.
 * Form fields come from lead_form_field; a snapshot is frozen in dialog config
 * so mid-flow owner edits do not change the in-progress questionnaire.
 */
export async function leadsFlow(
  tx: Transaction<Database>,
  input: {
    businessId: string;
    connectionId: string;
    platform: "telegram" | "vk";
    userId: string;
    username?: string;
    eventId: string;
    text: string;
    attachments?: InboundAttachment[];
  },
  helpers: {
    queue: Queue;
    save: Save;
    showMenu: (message?: string) => Promise<void>;
    current: {
      mode: string;
      fields: string;
      answers: string;
      position: number;
      config: string;
      updated_at: Date;
    } | null;
    startLead: boolean;
  },
): Promise<boolean> {
  const { businessId, connectionId, platform, userId, eventId } = input;
  const text = input.text.trim();
  const { queue, save, showMenu, current, startLead } = helpers;

  const ready = await isLeadCustomerReady(tx, businessId, platform);
  const { setup } = await loadLeadSetupV2(tx, businessId);
  const buttonLabel = ready.buttonLabel || setup.buttonLabel;

  // Start new questionnaire with frozen field snapshot.
  if (startLead) {
    if (!ready.ready) {
      await showMenu("Приём заявок временно недоступен.");
      return true;
    }
    const fields = await loadActiveFields(tx, businessId);
    if (!fields.length) {
      await showMenu("Форма заявки ещё не настроена.");
      return true;
    }
    const snapshot: LeadFormSnapshot = {
      version: 2,
      buttonLabel,
      greeting: setup.greeting,
      finalMessage: setup.finalMessage,
      fields,
      capturedAt: new Date().toISOString(),
    };
    const keys = fields.map((f) => f.fieldKey);
    await save("leads", keys, {}, 0, snapshot, { selectPage: 0, multi: [] });
    const first = fields[0]!;
    await queue(
      `${snapshot.greeting}\n\n${promptForField(first)}`,
      keyboardForField(first, 0, PAGE_SIZE),
    );
    return true;
  }

  if (
    !current ||
    !["leads", "review", "leads_edit"].includes(current.mode) ||
    Date.now() - current.updated_at.getTime() > 86400000
  ) {
    return false;
  }

  if (!ready.ready) {
    await showMenu("Приём заявок временно недоступен.");
    return true;
  }

  let snapshot: LeadFormSnapshot;
  try {
    snapshot = assertFormSnapshot(JSON.parse(current.config));
  } catch {
    await showMenu("Сессия заявки устарела. Начните заново.");
    return true;
  }

  const fieldKeys = JSON.parse(current.fields) as string[];
  const answers = JSON.parse(current.answers) as Record<string, unknown>;
  const byKey = new Map(snapshot.fields.map((f) => [f.fieldKey, f]));

  // --- Review mode ---
  if (current.mode === "review") {
    if (text === "Изменить") {
      const labels = snapshot.fields.map((f) => f.label);
      await save("leads_edit", fieldKeys, answers, 0, snapshot);
      await queue("Какое поле изменить?", [...labels, "Назад к проверке", "Отмена"]);
      return true;
    }
    if (text !== "Отправить") {
      await queue("Проверьте заявку и нажмите «Отправить».", [
        "Отправить",
        "Изменить",
        "Отмена",
      ]);
      return true;
    }
    const name =
      typeof answers.name === "string" && answers.name
        ? answers.name
        : "Клиент";
    const phone =
      typeof answers.phone === "string" ? answers.phone : null;
    const messageParts = ["message", "service", "comment", "description", "problem"]
      .map((k) => answers[k])
      .filter((v) => typeof v === "string" && v)
      .map(String);
    await createLead(tx, businessId, {
      source: platform,
      name,
      phone,
      message: messageParts.join("\n") || null,
      externalEventId: connectionId + ":" + eventId,
      platformUserId: userId,
      username: input.username,
      answers,
    });
    await save("menu");
    const fresh = await getAvailableCustomerActions(tx, businessId, platform);
    await queue(snapshot.finalMessage, fresh.labels);
    return true;
  }

  // --- Field-level edit from review ---
  if (current.mode === "leads_edit") {
    if (text === "Назад к проверке") {
      await save("review", fieldKeys, answers, fieldKeys.length, snapshot);
      await queue(reviewText(snapshot, fieldKeys, answers), [
        "Отправить",
        "Изменить",
        "Отмена",
      ]);
      return true;
    }
    const field = snapshot.fields.find((f) => f.label === text);
    if (!field) {
      await queue("Выберите поле из списка.", [
        ...snapshot.fields.map((f) => f.label),
        "Назад к проверке",
        "Отмена",
      ]);
      return true;
    }
    const idx = fieldKeys.indexOf(field.fieldKey);
    await save("leads", fieldKeys, answers, Math.max(0, idx), snapshot, {
      selectPage: 0,
      multi: [],
      returnToReview: true,
    });
    await queue(promptForField(field), keyboardForField(field, 0, PAGE_SIZE));
    return true;
  }

  // --- Collecting answers ---
  const fieldKey = fieldKeys[current.position];
  if (!fieldKey) {
    await showMenu();
    return true;
  }
  const field = byKey.get(fieldKey);
  if (!field) {
    await showMenu("Форма изменилась. Начните заявку заново.");
    return true;
  }

  // Go back one question
  if (text === "Назад" && current.position > 0) {
    const prev = current.position - 1;
    const prevField = byKey.get(fieldKeys[prev]!);
    await save("leads", fieldKeys, answers, prev, snapshot, {
      selectPage: 0,
      multi: [],
    });
    if (prevField) {
      await queue(promptForField(prevField), [
        ...keyboardForField(prevField, 0, PAGE_SIZE).filter((b) => b !== "Отмена"),
        "Назад",
        "Отмена",
      ]);
    }
    return true;
  }

  // Pagination for select options
  if (text === "Далее →" || text === "← Назад по списку") {
    const meta = readMeta(current.config);
    let page = meta.selectPage ?? 0;
    page = text === "Далее →" ? page + 1 : Math.max(0, page - 1);
    await save("leads", fieldKeys, answers, current.position, snapshot, {
      ...meta,
      selectPage: page,
    });
    await queue(promptForField(field), withNav(keyboardForField(field, page, PAGE_SIZE), current.position));
    return true;
  }

  // Multiselect accumulate
  if (field.fieldType === "multiselect") {
    const meta = readMeta(current.config);
    const multi = Array.isArray(meta.multi) ? [...meta.multi] : [];
    if (text === "✓ Готово") {
      if (field.required && multi.length === 0) {
        await queue("Выберите хотя бы один вариант.", keyboardForField(field, meta.selectPage ?? 0, PAGE_SIZE));
        return true;
      }
      answers[field.fieldKey] = multi;
      return advance(tx, {
        input,
        queue,
        save,
        showMenu,
        snapshot,
        fieldKeys,
        answers,
        position: current.position,
        returnToReview: Boolean(meta.returnToReview),
      });
    }
    const labels = optionLabels(field);
    if (labels.includes(text)) {
      if (!multi.includes(text)) multi.push(text);
      await save("leads", fieldKeys, answers, current.position, snapshot, {
        ...meta,
        multi,
      });
      await queue(
        `Выбрано: ${multi.join(", ") || "—"}\nДобавьте ещё или нажмите «✓ Готово».`,
        withNav(keyboardForField(field, meta.selectPage ?? 0, PAGE_SIZE), current.position),
      );
      return true;
    }
  }

  // Attachment
  if (field.fieldType === "attachment") {
    const skip =
      text === "/skip" || text === "Пропустить";
    if (skip && !field.required) {
      answers[field.fieldKey] = null;
      return advance(tx, {
        input,
        queue,
        save,
        showMenu,
        snapshot,
        fieldKeys,
        answers,
        position: current.position,
        returnToReview: Boolean(readMeta(current.config).returnToReview),
      });
    }
    const files = input.attachments ?? [];
    if (!files.length) {
      await queue(
        promptForField(field),
        withNav(keyboardForField(field), current.position),
      );
      return true;
    }
    const ids: string[] = [];
    for (const file of files.slice(0, 10)) {
      if (file.size && file.size > MAX_ATTACHMENT) continue;
      const id = randomUUID();
      await tx
        .insertInto("attachment")
        .values({
          id,
          business_id: businessId,
          type: file.type,
          provider: platform,
          storage_key: null,
          connection_id: connectionId,
          external: JSON.stringify(file.external),
          filename: file.filename.slice(0, 150),
          mime_type: file.mime,
          size_bytes: file.size ? String(file.size) : null,
        })
        .execute();
      ids.push(id);
    }
    if (!ids.length) {
      await queue(
        promptForField(field),
        withNav(keyboardForField(field), current.position),
      );
      return true;
    }
    answers[field.fieldKey] = ids;
    return advance(tx, {
      input,
      queue,
      save,
      showMenu,
      snapshot,
      fieldKeys,
      answers,
      position: current.position,
      returnToReview: Boolean(readMeta(current.config).returnToReview),
    });
  }

  if (text.startsWith("/") && text !== "/skip") {
    await queue(
      `Проверьте ответ.\n${promptForField(field)}`,
      withNav(keyboardForField(field), current.position),
    );
    return true;
  }

  const result = validateLeadAnswer(field, text, {
    skip: text === "/skip" || text === "Пропустить",
  });
  if (!result.ok) {
    await queue(
      `${result.message}\n${promptForField(field)}`,
      withNav(keyboardForField(field), current.position),
    );
    return true;
  }
  answers[field.fieldKey] = result.value;
  return advance(tx, {
    input,
    queue,
    save,
    showMenu,
    snapshot,
    fieldKeys,
    answers,
    position: current.position,
    returnToReview: Boolean(readMeta(current.config).returnToReview),
  });
}

function withNav(buttons: string[], position: number): string[] {
  if (position <= 0) return buttons;
  const without = buttons.filter((b) => b !== "Назад" && b !== "Отмена");
  return [...without, "Назад", "Отмена"];
}

function readMeta(configJson: string): {
  selectPage: number;
  multi: string[];
  returnToReview: boolean;
} {
  try {
    const parsed = JSON.parse(configJson) as Record<string, unknown>;
    const flow =
      parsed[FLOW_META] && typeof parsed[FLOW_META] === "object"
        ? (parsed[FLOW_META] as Record<string, unknown>)
        : parsed;
    return {
      selectPage: typeof flow.selectPage === "number" ? flow.selectPage : 0,
      multi: Array.isArray(flow.multi)
        ? flow.multi.filter((x): x is string => typeof x === "string")
        : [],
      returnToReview: flow.returnToReview === true,
    };
  } catch {
    return { selectPage: 0, multi: [], returnToReview: false };
  }
}

function reviewText(
  snapshot: LeadFormSnapshot,
  fieldKeys: string[],
  answers: Record<string, unknown>,
) {
  return (
    "Проверьте заявку:\n\n" +
    fieldKeys
      .map((key) => {
        const field = snapshot.fields.find((f) => f.fieldKey === key);
        return `${field?.label || key}: ${formatAnswer(answers[key])}`;
      })
      .join("\n")
  );
}

async function advance(
  tx: Transaction<Database>,
  args: {
    input: {
      businessId: string;
      connectionId: string;
      platform: "telegram" | "vk";
      userId: string;
      eventId: string;
    };
    queue: Queue;
    save: Save;
    showMenu: (message?: string) => Promise<void>;
    snapshot: LeadFormSnapshot;
    fieldKeys: string[];
    answers: Record<string, unknown>;
    position: number;
    returnToReview: boolean;
  },
) {
  const {
    queue,
    save,
    snapshot,
    fieldKeys,
    answers,
    position,
    returnToReview,
  } = args;
  if (returnToReview) {
    await save("review", fieldKeys, answers, fieldKeys.length, snapshot);
    await queue(reviewText(snapshot, fieldKeys, answers), [
      "Отправить",
      "Изменить",
      "Отмена",
    ]);
    return true;
  }
  const next = position + 1;
  if (next < fieldKeys.length) {
    const nextField = snapshot.fields.find((f) => f.fieldKey === fieldKeys[next]);
    await save("leads", fieldKeys, answers, next, snapshot, {
      selectPage: 0,
      multi: [],
    });
    if (nextField) {
      await queue(
        promptForField(nextField),
        withNav(keyboardForField(nextField, 0, PAGE_SIZE), next),
      );
    }
    return true;
  }
  await save("review", fieldKeys, answers, next, snapshot);
  await queue(reviewText(snapshot, fieldKeys, answers), [
    "Отправить",
    "Изменить",
    "Отмена",
  ]);
  return true;
}
