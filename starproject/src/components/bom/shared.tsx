"use client";

import { BOM_STATUSES, BOM_STATUS_LABEL, type BomLine, type BomStatus, statusChangeNeedsApprover } from "@/lib/bom";

// Small pieces the BOM sheet, the line editor and the import dialog share.

export type Option = { id: string; label: string };

export const STATUS_PILL: Record<BomStatus, string> = {
  planned: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  approved: "bg-sky-100 text-sky-800 dark:bg-sky-400/15 dark:text-sky-300",
  ordered: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  received: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
};

/** The line's status as a pill-styled select; steps only a PVP may take are
 * greyed out for everyone else. */
export function StatusSelect({
  line,
  canApprove,
  onChange,
  className = "",
}: {
  line: Pick<BomLine, "status" | "name">;
  canApprove: boolean;
  onChange: (to: BomStatus) => void;
  className?: string;
}) {
  return (
    <select
      aria-label={`Status of ${line.name}`}
      value={line.status}
      onChange={(e) => onChange(e.target.value as BomStatus)}
      className={`rounded-full border-0 px-2 py-0.5 text-xs font-semibold ${STATUS_PILL[line.status]} ${className}`}
    >
      {BOM_STATUSES.map((s) => (
        <option key={s} value={s} disabled={!canApprove && statusChangeNeedsApprover(line.status, s)}>
          {BOM_STATUS_LABEL[s]}
        </option>
      ))}
    </select>
  );
}
