import type { TaskStatus } from "@prisma/client";

/** A task is "blocked" if any task blocking it isn't done yet. Needs only the
 * blocker's status, so callers can select as little as `{ status }`. */
export function isBlocked(
  blockedBy?: { blockedByTask: { status: TaskStatus } }[] | null,
): boolean {
  return !!blockedBy?.some((b) => b.blockedByTask.status !== "done");
}

// A completed task auto-archives (drops out of the lists and timeline) and is
// stamped with when it was completed, which keeps it in the board's Done column
// for DONE_ON_BOARD_DAYS (src/lib/board.ts); moving it back out of Done restores
// it and clears the stamp. Returns the patch for a status change, or {} when the
// transition doesn't cross the Done boundary. Shared by the updateTask and
// moveTask actions so both mutation paths stay in sync.
export function statusChangePatch(
  oldStatus: TaskStatus,
  newStatus: TaskStatus,
  now: Date = new Date(),
): { archived?: boolean; completedAt?: Date | null } {
  if (newStatus === oldStatus) return {};
  if (newStatus === "done") return { archived: true, completedAt: now };
  if (oldStatus === "done") return { archived: false, completedAt: null };
  return {};
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  blocked: "Blocked",
};

// Shared color coding for status + priority, used everywhere they're shown.
export const STATUS_BADGE: Record<TaskStatus, string> = {
  backlog: "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
  todo: "bg-blue-100 text-blue-700 dark:bg-blue-400/15 dark:text-blue-300",
  in_progress: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  done: "bg-green-100 text-green-700 dark:bg-green-400/15 dark:text-green-300",
  blocked: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
};

export const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-slate-100 text-slate-600 dark:bg-slate-400/15 dark:text-slate-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-400/15 dark:text-amber-300",
  high: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
};
