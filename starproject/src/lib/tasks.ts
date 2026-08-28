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
  backlog: "bg-slate-100 text-slate-600",
  todo: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  done: "bg-green-100 text-green-700",
};

export const PRIORITY_BADGE: Record<string, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-red-100 text-red-700",
};
