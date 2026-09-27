"use client";

import { useState } from "react";
import { PlatformBadge } from "@/components/ui/PlatformBadge";
import { platformLabel } from "@/lib/labels";
import type { LeadChannel } from "@/lib/leadSetupV2";
import type { LeadFormField } from "@/components/leads/LeadFormBuilder";

const SAMPLE_ANSWERS: Record<string, string> = {
  name: "Анна",
  phone: "+7 900 123-45-67",
  email: "anna@example.com",
  message: "Хочу узнать подробности",
  service: "Консультация",
  comment: "Удобно после 18:00",
  address: "ул. Примерная, 1",
  budget: "до 50 000 ₽",
};

function sampleAnswer(field: LeadFormField): string {
  const known = SAMPLE_ANSWERS[field.fieldKey];
  if (known) return known;
  if (field.fieldType === "select" || field.fieldType === "multiselect") {
    const opts = Array.isArray(field.options) ? field.options : [];
    const first = opts[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object" && "label" in first)
      return String((first as { label: string }).label);
  }
  if (field.fieldType === "date") return "15 марта";
  if (field.fieldType === "checkbox") return "Да";
  if (field.fieldType === "attachment") return "фото.jpg";
  return field.placeholder || "Ответ клиента";
}

export function LeadPreview({
  businessName,
  buttonLabel,
  greeting,
  finalMessage,
  channels,
  fields,
}: {
  businessName: string;
  buttonLabel: string;
  greeting: string;
  finalMessage: string;
  channels: LeadChannel[];
  fields: LeadFormField[];
}) {
  const available: LeadChannel[] =
    channels.length > 0 ? channels : ["telegram", "vk"];
  const [tab, setTab] = useState<LeadChannel>(available[0] ?? "telegram");
  const active: LeadChannel = available.includes(tab)
    ? tab
    : (available[0] ?? "telegram");

  return (
    <div className="lead-preview" aria-label="Предпросмотр для клиента">
      <div className="preview-channel-switch" role="tablist" aria-label="Площадка">
        {available.map((channel) => (
          <button
            key={channel}
            type="button"
            role="tab"
            className="button button--outline"
            aria-selected={active === channel}
            onClick={() => setTab(channel)}
          >
            <PlatformBadge platform={channel} compact />
            {platformLabel(channel)}
          </button>
        ))}
      </div>
      <div className="conversation-preview" role="tabpanel">
        <div className="conversation-preview__heading">
          <PlatformBadge platform={active} compact />
          <strong>{businessName}</strong>
          <span>Пример</span>
        </div>
        <p className="chat-bubble chat-bubble--reply">
          [{buttonLabel || "Оставить заявку"}]
        </p>
        <p className="chat-bubble">
          {greeting || "Здравствуйте! Ответьте на несколько вопросов."}
        </p>
        {fields.map((field) => (
          <div key={field.id || field.fieldKey} className="chat-pair">
            <p className="chat-bubble">{field.label}</p>
            <p className="chat-bubble chat-bubble--reply">
              {sampleAnswer(field)}
            </p>
          </div>
        ))}
        {!fields.length ? (
          <p className="chat-bubble">Как вас зовут?</p>
        ) : null}
        <p className="chat-bubble">
          {finalMessage || "Спасибо! Заявка принята."}
        </p>
        <p className="account-footnote">
          Это пример диалога. Сообщения клиентам не отправляются.
        </p>
      </div>
    </div>
  );
}
