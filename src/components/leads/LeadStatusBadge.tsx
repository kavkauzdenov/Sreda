"use client";

import type { LeadStatus } from "@/types";
import { leadStatusLabel } from "@/lib/leadStatus";

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return (
    <span className={`status-chip status-chip--${status}`}>
      {leadStatusLabel(status)}
    </span>
  );
}
