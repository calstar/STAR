import type { Task, TaskStatus } from "@prisma/client";

export type BoardTask = Task & {
  assignee: { id: string; name: string | null; email: string } | null;
  blockedBy?: { blockedByTask: { id: string; title: string; status: TaskStatus } }[];
};

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
