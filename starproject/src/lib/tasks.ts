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
