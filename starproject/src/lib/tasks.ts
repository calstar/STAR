import type { TaskStatus } from "@prisma/client";

/** A task is "blocked" if any task blocking it isn't done yet. Needs only the
 * blocker's status, so callers can select as little as `{ status }`. */
export function isBlocked(
  blockedBy?: { blockedByTask: { status: TaskStatus } }[] | null,
): boolean {
  return !!blockedBy?.some((b) => b.blockedByTask.status !== "done");
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
};

// Shared color coding for status + priority, used everywhere they're shown.
export const STATUS_BADGE: Record<TaskStatus, string> = {
  backlog: "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
  todo: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  done: "bg-green-100 text-green-700 dark:bg-green-400/15 dark:text-green-300",
};

export const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  high: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
};

// Solid per-option colors for native <select> dropdowns. Tailwind bg-*/opacity
// classes don't render on <option>s, so options get inline hex styles instead —
// each row shows its own status/priority color in the open list.
export const STATUS_OPTION_STYLE: Record<string, { backgroundColor: string; color: string }> = {
  backlog: { backgroundColor: "#e2e8f0", color: "#475569" },
  todo: { backgroundColor: "#dbeafe", color: "#1d4ed8" },
  in_progress: { backgroundColor: "#fef3c7", color: "#b45309" },
  done: { backgroundColor: "#dcfce7", color: "#15803d" },
};

export const PRIORITY_OPTION_STYLE: Record<string, { backgroundColor: string; color: string }> = {
  low: { backgroundColor: "#e2e8f0", color: "#475569" },
  medium: { backgroundColor: "#fef3c7", color: "#b45309" },
  high: { backgroundColor: "#fee2e2", color: "#b91c1c" },
};
