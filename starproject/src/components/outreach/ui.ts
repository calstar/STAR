// Class strings shared by the /outreach screens, so buttons, inputs and cards
// match each other and the rest of the app (neutral greys, blue for primary).

export const CARD =
  "rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900";
export const INPUT =
  "w-full rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-950";
/** A select/input that sits inline in a toolbar (INPUT without the full width). */
export const INPUT_INLINE =
  "w-auto rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-950";
export const LABEL = "mb-1 block text-xs font-medium text-neutral-500 dark:text-neutral-400";
export const BTN =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800";
export const BTN_PRIMARY =
  "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
export const BTN_SMALL =
  "inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800";
export const TH =
  "px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
export const TD = "px-3 py-2 align-top";
export const MUTED = "text-neutral-500 dark:text-neutral-400";

export const STAGE_TONE: Record<string, string> = {
  prospect: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  drafting: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  contacted: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  in_talks: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  committed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  received: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  thanked: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
  declined: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  ghosted: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-300",
};

export const PILL = "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap";
export const TAG =
  "inline-flex items-center rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300";
