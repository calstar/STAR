import type { Task, TaskStatus } from "@prisma/client";

import { isBlocked } from "@/lib/tasks";

export type BoardTask = Task & {
  assignee: { id: string; name: string | null; email: string } | null;
  blockedBy?: { blockedByTask: { id: string; title: string; status: TaskStatus } }[];
  // Set when a task shown in a parent project actually belongs to a subproject,
  // so the card/row can indicate which one.
  subproject?: { name: string; color: string | null } | null;
};

// A task enriched with the display names the list table and filters need. A
// superset of BoardTask, so it's accepted anywhere BoardTask is (Board, Gantt).
export type WorkspaceTask = BoardTask & {
  projectName: string;
  subteamName: string;
  assigneeName: string;
};

// The flat row shape the shared list table renders. Carries the raw values the
// inline editors need (status/priority/assigneeId/due) plus display names.
export type TaskRowData = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  priority: string;
  assigneeId: string;
  assigneeName: string;
  subteamId: string;
  subteamName: string;
  due: string;
  overdue: boolean;
  blocked: boolean;
  subproject?: { name: string; color: string | null } | null;
};

/** Flatten a task to the shared list-table row shape. */
export function toRowData(t: WorkspaceTask): TaskRowData {
  return {
    id: t.id,
    title: t.title,
    projectId: t.projectId,
    projectName: t.projectName,
    status: t.status,
    priority: t.priority ?? "",
    assigneeId: t.assigneeId ?? "",
    assigneeName: t.assigneeName,
    subteamId: t.subteamId ?? "",
    subteamName: t.subteamName,
    due: t.dueDate ? new Date(t.dueDate).toISOString().slice(0, 10) : "",
    overdue:
      !!t.dueDate &&
      t.status !== "done" &&
      new Date(t.dueDate).getTime() < Date.now(),
    blocked: isBlocked(t.blockedBy),
    subproject: t.subproject ?? null,
  };
}

export type Columns = Record<TaskStatus, BoardTask[]>;

export const STATUS_COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: "backlog", label: "Backlog" },
  { key: "todo", label: "To do" },
  { key: "in_progress", label: "In progress" },
  { key: "done", label: "Done" },
];

/** Group tasks into columns, each ordered by boardOrder then createdAt. */
export function groupByStatus(tasks: BoardTask[]): Columns {
  const cols: Columns = { backlog: [], todo: [], in_progress: [], done: [] };
  for (const t of tasks) cols[t.status].push(t);
  for (const key of Object.keys(cols) as TaskStatus[]) {
    cols[key].sort(
      (a, b) =>
        a.boardOrder - b.boardOrder ||
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }
  return cols;
}

/**
 * A boardOrder value that places a card between prev and next (either may be
 * undefined at a column's ends). Fractional — no bulk reindex on move.
 */
export function midpointOrder(prev?: number, next?: number): number {
  if (prev == null && next == null) return 0;
  if (prev == null) return (next as number) - 1;
  if (next == null) return prev + 1;
  return (prev + next) / 2;
}
