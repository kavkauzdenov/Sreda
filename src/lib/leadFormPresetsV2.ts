/**
 * User-facing lead form presets for Leads V2.
 * Presets seed lead_form_field rows — never collect sensitive medical data.
 */

export type LeadFormPresetId =
  | "universal"
  | "auto"
  | "beauty"
  | "construction"
  | "legal"
  | "delivery"
  | "clinic"
  | "other";

export type LeadFormPresetField = {
  fieldKey: string;
  label: string;
  fieldType: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
};

export type LeadFormPreset = {
  id: LeadFormPresetId;
  label: string;
  description: string;
  fields: LeadFormPresetField[];
};

const nameField = (label = "Имя"): LeadFormPresetField => ({
  fieldKey: "name",
  label,
  fieldType: "name",
  required: true,
  placeholder: "Как к вам обращаться",
});

export const LEAD_FORM_PRESETS: LeadFormPreset[] = [
  {
    id: "universal",
    label: "Универсальная заявка",
    description: "Имя, телефон и сообщение — для большинства бизнесов.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
        placeholder: "+7 900 000-00-00",
      },
      {
        fieldKey: "message",
        label: "Сообщение",
        fieldType: "message",
        required: false,
        placeholder: "Кратко опишите запрос",
      },
    ],
  },
  {
    id: "auto",
    label: "Автосервис",
    description: "Марка, проблема и удобное время.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "car_brand",
        label: "Марка и модель",
        fieldType: "text",
        required: true,
        placeholder: "Например, Toyota Camry",
      },
      {
        fieldKey: "problem",
        label: "Что случилось",
        fieldType: "textarea",
        required: true,
      },
      {
        fieldKey: "preferred_time",
        label: "Удобное время",
        fieldType: "text",
        required: false,
      },
    ],
  },
  {
    id: "beauty",
    label: "Салон красоты",
    description: "Услуга и желаемая дата.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "service",
        label: "Услуга",
        fieldType: "service",
        required: true,
      },
      {
        fieldKey: "preferred_date",
        label: "Желаемая дата",
        fieldType: "date",
        required: false,
      },
    ],
  },
  {
    id: "construction",
    label: "Строительство / ремонт",
    description: "Тип работ, адрес и бюджет.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "work_type",
        label: "Тип работ",
        fieldType: "select",
        required: true,
        options: ["Ремонт", "Отделка", "Строительство", "Другое"],
      },
      {
        fieldKey: "address",
        label: "Адрес объекта",
        fieldType: "address",
        required: false,
      },
      {
        fieldKey: "budget",
        label: "Бюджет",
        fieldType: "budget",
        required: false,
      },
    ],
  },
  {
    id: "legal",
    label: "Юридические услуги",
    description: "Тема обращения без сбора чувствительных данных.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "email",
        label: "Email",
        fieldType: "email",
        required: false,
      },
      {
        fieldKey: "topic",
        label: "Тема обращения",
        fieldType: "select",
        required: true,
        options: [
          "Консультация",
          "Договор",
          "Споры",
          "Регистрация бизнеса",
          "Другое",
        ],
      },
      {
        fieldKey: "description",
        label: "Краткое описание",
        fieldType: "textarea",
        required: true,
      },
    ],
  },
  {
    id: "delivery",
    label: "Доставка / логистика",
    description: "Откуда, куда и что везём.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "from_address",
        label: "Откуда",
        fieldType: "address",
        required: true,
      },
      {
        fieldKey: "to_address",
        label: "Куда",
        fieldType: "address",
        required: true,
      },
      {
        fieldKey: "cargo",
        label: "Что доставить",
        fieldType: "textarea",
        required: true,
      },
    ],
  },
  {
    id: "clinic",
    label: "Медицина / клиника",
    description: "Запись на приём без сбора медицинских диагнозов.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: true,
      },
      {
        fieldKey: "service",
        label: "Специалист или услуга",
        fieldType: "service",
        required: true,
        placeholder: "Например, терапевт",
      },
      {
        fieldKey: "preferred_date",
        label: "Желаемая дата",
        fieldType: "date",
        required: false,
      },
      {
        fieldKey: "comment",
        label: "Комментарий",
        fieldType: "textarea",
        required: false,
        placeholder: "Удобное время или пожелания",
      },
    ],
  },
  {
    id: "other",
    label: "Другое",
    description: "Минимальный набор — дополните своими полями.",
    fields: [
      nameField(),
      {
        fieldKey: "phone",
        label: "Телефон",
        fieldType: "phone",
        required: false,
      },
      {
        fieldKey: "message",
        label: "Сообщение",
        fieldType: "message",
        required: false,
      },
    ],
  },
];

export function leadFormPresetById(id: string): LeadFormPreset | undefined {
  return LEAD_FORM_PRESETS.find((p) => p.id === id);
}
