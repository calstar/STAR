import type { TaskStatus } from "@prisma/client";

import type { BoardTask } from "@/lib/board";
import { displayNameOf } from "@/lib/names";
import { isBlocked } from "@/lib/tasks";

const DAY_MS = 86_400_000;

/** Whole days since the epoch for a stored date (dates are kept at UTC midnight). */
export function dayOf(d: Date | string): number {
  return Math.floor(new Date(d).getTime() / DAY_MS);
}

/** Today as a day number, from the viewer's local calendar date. */
export function todayDay(now = new Date()): number {
  return Math.floor(
    Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY_MS,
  );
}

/** Day number → YYYY-MM-DD, the format setTaskDates takes. */
export function dayToYmd(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Day number → the UTC Date at its midnight, for formatting labels. */
export function dayToDate(day: number): Date {
  return new Date(day * DAY_MS);
}

/** One task placed on the timeline. `start`/`end` are inclusive day numbers. */
export type TimelineItem = {
  id: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  start: number;
  end: number;
  /** Only a due date: drawn as a milestone marker, and a move keeps start empty. */
  dueOnly: boolean;
  blocked: boolean;
  overdue: boolean;
  assignees: string;
  /** Ids of on-chart tasks this one is blocked by. */
  deps: string[];
};

/** How the timeline's rows are grouped: by subproject (else project), or not at all. */
export type TimelineGrouping = "subproject" | "none";

export type TimelineGroup = {
  key: string;
  label: string;
  color: string | null;
  items: TimelineItem[];
};

/**
 * Lay tasks out for the timeline. A task is placed if it has a start and/or due
 * date (start = start ?? due, end = due ?? start, clamped so end ≥ start).
 * With "subproject" grouping, tasks are grouped by subproject, else by project,
 * and the groups ordered by their earliest start; with "none" they form one
 * chronological group. Inside a group, blocker-connected tasks sit in adjacent
 * rows (see orderByBlockers). Dependencies are kept only between placed tasks.
 */
export function toTimeline(
  tasks: (BoardTask & { projectName?: string })[],
  today = todayDay(),
  grouping: TimelineGrouping = "subproject",
): { groups: TimelineGroup[]; unscheduled: BoardTask[] } {
  const dated = tasks.filter((t) => t.startDate || t.dueDate);
  const ids = new Set(dated.map((t) => t.id));

  const byGroup = new Map<string, TimelineGroup>();
  for (const t of dated) {
    const start = dayOf((t.startDate ?? t.dueDate) as Date);
    const end = Math.max(start, dayOf((t.dueDate ?? t.startDate) as Date));
    const item: TimelineItem = {
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
      start,
      end,
      dueOnly: !t.startDate,
      blocked: t.status === "blocked" || isBlocked(t.blockedBy),
      overdue: !!t.dueDate && t.status !== "done" && end < today,
      assignees: assigneeLabel(t),
      deps: (t.blockedBy ?? [])
        .map((b) => b.blockedByTask.id)
        .filter((id) => ids.has(id)),
    };
    const key =
      grouping === "none"
        ? "all"
        : t.subproject
          ? `sub:${t.subproject.name}`
          : `proj:${t.projectId}`;
    let g = byGroup.get(key);
    if (!g) {
      g = {
        key,
        label: t.subproject?.name ?? t.projectName ?? "Tasks",
        color: t.subproject?.color ?? null,
        items: [],
      };
      byGroup.set(key, g);
    }
    g.items.push(item);
  }

  const groups = [...byGroup.values()].map((g) => ({
    ...g,
    items: orderByBlockers(g.items),
  }));
  groups.sort(
    (a, b) => byStart(a.items[0], b.items[0]) || a.label.localeCompare(b.label),
  );

  return {
    groups,
    unscheduled: tasks.filter((t) => !t.startDate && !t.dueDate),
  };
}

/** The flat shape the MCP `gantt` tool returns (frappe-gantt's input format,
 * which the timeline used to render). Kept stable for API callers. */
export type GanttInput = {
  id: string;
  name: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  progress: number;
  dependencies: string; // comma-separated task ids
  custom_class?: string;
};

/** The timeline as one chronological list in the MCP tool's flat shape:
 * blocker-connected tasks adjacent, dependencies only between placed tasks. */
export function toGanttTasks(tasks: (BoardTask & { projectName?: string })[]): {
  scheduled: GanttInput[];
  unscheduled: number;
} {
  const { groups, unscheduled } = toTimeline(tasks, todayDay(), "none");
  const scheduled = groups.flatMap((g) =>
    g.items.map((t) => ({
      id: t.id,
      name: t.title,
      start: dayToYmd(t.start),
      end: dayToYmd(t.end),
      progress: t.status === "done" ? 100 : t.status === "in_progress" ? 50 : 0,
      dependencies: t.deps.join(","),
      custom_class: `status-${t.status}`,
    })),
  );
  return { scheduled, unscheduled: unscheduled.length };
}

function assigneeLabel(t: BoardTask): string {
  const [first, ...rest] = t.assignees ?? [];
  if (!first) return "";
  return rest.length ? `${displayNameOf(first)} +${rest.length}` : displayNameOf(first);
}

// Compare by start, then end, then title, then id — a stable chronological
// order with deterministic tiebreaks.
function byStart(a: TimelineItem, b: TimelineItem): number {
  return (
    a.start - b.start ||
    a.end - b.end ||
    a.title.localeCompare(b.title) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Reorder rows so blocker-connected tasks (including transitive chains) sit in
 * adjacent rows. Tasks joined by blocker edges form connected components via
 * union-find; each component is sorted by start date, and the components are
 * ordered by their earliest start. Unconnected tasks are singleton components,
 * so everything still reads roughly chronologically top-to-bottom.
 */
function orderByBlockers(items: TimelineItem[]): TimelineItem[] {
  const index = new Map(items.map((t, i) => [t.id, i]));
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (const t of items) {
    for (const d of t.deps) {
      const j = index.get(d);
      if (j !== undefined) parent[find(index.get(t.id)!)] = find(j);
    }
  }

  const comps = new Map<number, TimelineItem[]>();
  items.forEach((t, i) => {
    const root = find(i);
    const c = comps.get(root);
    if (c) c.push(t);
    else comps.set(root, [t]);
  });

  return [...comps.values()]
    .map((c) => c.sort(byStart))
    .sort((c1, c2) => byStart(c1[0], c2[0]))
    .flat();
}
