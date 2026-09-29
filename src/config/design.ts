export const SOLUTION_ACCENTS = {
  leads: {
    cssVar: "--solution-leads",
    label: "Приём заявок",
  },
  orders: {
    cssVar: "--solution-orders",
    label: "Приём заказов",
  },
  booking: {
    cssVar: "--solution-booking",
    label: "Онлайн-запись",
  },
  admin_messages: {
    cssVar: "--solution-messages",
    label: "Связь с клиентами",
  },
  autopost: {
    cssVar: "--solution-autopost",
    label: "Автопостинг",
  },
} as const;

export type SolutionAccentCode = keyof typeof SOLUTION_ACCENTS;
