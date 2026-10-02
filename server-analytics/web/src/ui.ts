// Class strings copied from STARProject so both apps share one look:
// PAGE_CONTAINER / LIST_CARD (src/components/EntityRow.tsx), CARD_CLASS
// (src/components/TaskCard.tsx), the table (src/components/TaskTable.tsx) and
// the badge tones (src/lib/tasks.ts).
export const PAGE_CONTAINER = "mx-auto max-w-[88rem] px-4 py-6 sm:px-6 sm:py-8";
export const CARD =
  "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3.5 shadow-sm sm:p-4";
export const TABLE_WRAP =
  "overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900";
export const TH =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
export const TD = "px-3 py-2.5 md:py-1.5";
export const MUTED = "text-neutral-500 dark:text-neutral-400";
export const INPUT =
  "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm";
export const BUTTON =
  "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800";

export type Tone = "slate" | "blue" | "amber" | "green" | "red";
export const TONE: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-400/15 dark:text-slate-300",
  blue: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  amber: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  green: "bg-green-100 text-green-700 dark:bg-green-400/15 dark:text-green-300",
  red: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
};
