import type { LeadStatus } from "../db/schema.ts";
import { AppError } from "../http/errors.ts";
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TRANSITIONS,
  allowedLeadTransitions,
} from "../../lib/leadStatus.ts";

export { LEAD_STATUS_LABELS, allowedLeadTransitions };

export function assertLeadTransition(from: LeadStatus, to: LeadStatus) {
  if (from === to) return;
  if (!LEAD_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new AppError(
      400,
      "INVALID_STATUS_TRANSITION",
      `Нельзя сменить статус «${LEAD_STATUS_LABELS[from]}» на «${LEAD_STATUS_LABELS[to]}».`,
    );
  }
}

/** Waiting time / SLA display helpers. */
export function leadWaitMeta(
  createdAt: Date | string,
  processingAt: Date | string | null | undefined,
  slaMinutes: number | null | undefined,
  now = Date.now(),
): {
  waitedMinutes: number;
  overdue: boolean;
  overdueMinutes: number;
  label: string | null;
} {
  const start = new Date(createdAt).getTime();
  const end = processingAt ? new Date(processingAt).getTime() : now;
  const waitedMinutes = Math.max(0, Math.floor((end - start) / 60000));
  if (!slaMinutes) {
    return {
      waitedMinutes,
      overdue: false,
      overdueMinutes: 0,
      label: processingAt ? null : `Ждёт ${waitedMinutes} мин`,
    };
  }
  const overdue = !processingAt && waitedMinutes > slaMinutes;
  const overdueMinutes = overdue ? waitedMinutes - slaMinutes : 0;
  return {
    waitedMinutes,
    overdue,
    overdueMinutes,
    label: processingAt
      ? null
      : overdue
        ? `Просрочено на ${overdueMinutes} мин`
        : `Ждёт ${waitedMinutes} мин`,
  };
}
