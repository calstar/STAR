import type { Task, TaskStatus } from "@prisma/client";

import { isBlocked } from "@/lib/tasks";

// The minimal user shape the cards/pickers need to render a person's name.
export type AssigneeLite = {
  id: string;
  name: string | null;
  email: string;
  displayName: string | null;
};

export type BoardTask = Task & {
  assignees: AssigneeLite[];
  blockedBy?: { blockedByTask: { id: string; title: string; status: TaskStatus } }[];
  // Set when a task shown in a parent project actually belongs to a subproject,
  // so the card/row can indicate which one.
  subproject?: { name: string; color: string | null } | null;
};

// A task enriched with the display names the list table and filters need. A
// superset of BoardTask, so it's accepted anywhere BoardTask is (Board, Gantt).
// `assigneeName` is the joined display names of every assignee (for search/sort).
export type WorkspaceTask = BoardTask & {
  projectName: string;
  subteamName: string;
  assigneeName: string;
};

// The flat row shape the shared list table renders. Carries the raw values the
// inline editors need (status/priority/assigneeIds/due) plus display names.
export type TaskRowData = {
  id: string;
  number: number;
  title: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  priority: string;
  assigneeIds: string[];
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
    number: t.number,
    title: t.title,
    projectId: t.projectId,
    projectName: t.projectName,
    status: t.status,
    priority: t.priority ?? "",
    assigneeIds: t.assignees.map((a) => a.id),
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
  { key: "blocked", label: "Blocked" },
  { key: "done", label: "Done" },
];

/** boardOrder then createdAt — the manual/creation fallback used to break ties. */
function byManualOrder(a: BoardTask, b: BoardTask): number {
  return (
    a.boardOrder - b.boardOrder ||
    new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );
}

/**
 * Order a column by due date so the most critical items sit at the top.
 * Non-done columns sort soonest-due first, so overdue tasks float up; the done
 * column sorts most-recently-due first. Tasks without a due date always sink to
 * the bottom, and boardOrder/createdAt break ties among equal or absent dues.
 */
function byDueDate(a: BoardTask, b: BoardTask, desc: boolean): number {
  const da = a.dueDate ? new Date(a.dueDate).getTime() : null;
  const db = b.dueDate ? new Date(b.dueDate).getTime() : null;
  if (da == null && db == null) return byManualOrder(a, b);
  if (da == null) return 1; // a has no due date → after b
  if (db == null) return -1; // b has no due date → after a
  if (da !== db) return desc ? db - da : da - db;
  return byManualOrder(a, b);
}

/** Rank priority high→low, with "none" last; used by the priority sort. */
const PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };
function priorityRank(p: string | null): number {
  return p ? (PRIORITY_RANK[p] ?? 3) : 3;
}

// The sort orders a user can pick for the board's columns. "due" is the default
// (most critical at the top); "manual" honours drag-and-drop order. Every sort
// falls back to manual/due order to break ties, so equal items stay stable.
export type BoardSort = "due" | "priority" | "created" | "title" | "manual";

function comparatorFor(
  sort: BoardSort,
  isDone: boolean,
): (a: BoardTask, b: BoardTask) => number {
  switch (sort) {
    case "manual":
      return byManualOrder;
    case "priority":
      return (a, b) =>
        priorityRank(a.priority) - priorityRank(b.priority) ||
        byDueDate(a, b, isDone);
    case "created":
      return (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime() ||
        byManualOrder(a, b);
    case "title":
      return (a, b) => a.title.localeCompare(b.title) || byManualOrder(a, b);
    default:
      return (a, b) => byDueDate(a, b, isDone);
  }
}

// Labels for the board sort picker, in display order. Shared by every board.
export const BOARD_SORT_OPTIONS: { value: BoardSort; label: string }[] = [
  { value: "due", label: "Sort: Due date" },
  { value: "priority", label: "Sort: Priority" },
  { value: "created", label: "Sort: Recently created" },
  { value: "title", label: "Sort: Title (A–Z)" },
  { value: "manual", label: "Sort: Manual (drag)" },
];

/**
 * Group tasks into columns and sort each by `sort` (default "due"). For "due",
 * the most critical items sit at the top: non-done columns show overdue/soonest-
 * due first, the done column shows most-recently-due first, undated last.
 */
export function groupByStatus(
  tasks: BoardTask[],
  sort: BoardSort = "due",
): Columns {
  const cols: Columns = { backlog: [], todo: [], in_progress: [], blocked: [], done: [] };
  for (const t of tasks) cols[t.status].push(t);
  for (const key of Object.keys(cols) as TaskStatus[]) {
    cols[key].sort(comparatorFor(sort, key === "done"));
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
