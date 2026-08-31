import type { BoardTask } from "@/lib/board";

// The task shape frappe-gantt consumes.
export type GanttInput = {
  id: string;
  name: string;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  progress: number;
  dependencies: string; // comma-separated task ids
  custom_class?: string;
};

function ymd(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

/**
 * Map tasks to frappe-gantt inputs. A task is placed only if it has a start
 * and/or due date (start = start ?? due, end = due ?? start, clamped so
 * end ≥ start). Dependencies come from blocker edges, filtered to tasks that
 * are actually on the chart (frappe-gantt errors on dangling dependency ids).
 */
export function toGanttTasks(tasks: BoardTask[]): {
  scheduled: GanttInput[];
  unscheduled: number;
} {
  const dated = tasks.filter((t) => t.startDate || t.dueDate);
  const ids = new Set(dated.map((t) => t.id));

  const scheduled: GanttInput[] = dated.map((t) => {
    const start = ymd((t.startDate ?? t.dueDate) as Date);
    let end = ymd((t.dueDate ?? t.startDate) as Date);
    if (end < start) end = start; // lexicographic compare == chronological for YYYY-MM-DD

    const progress =
      t.status === "done" ? 100 : t.status === "in_progress" ? 50 : 0;

    const dependencies = (t.blockedBy ?? [])
      .map((b) => b.blockedByTask.id)
      .filter((id) => ids.has(id))
      .join(",");

    return {
      id: t.id,
      name: t.title,
      start,
      end,
      progress,
      dependencies,
      custom_class: `status-${t.status}`,
    };
  });

  // Blocker edges among tasks that are on the chart (both endpoints scheduled).
  const edges: [string, string][] = [];
  for (const t of dated) {
    for (const b of t.blockedBy ?? []) {
      if (ids.has(b.blockedByTask.id)) edges.push([t.id, b.blockedByTask.id]);
    }
  }

  return {
    scheduled: orderByBlockers(scheduled, edges),
    unscheduled: tasks.length - dated.length,
  };
}

// Compare by start date, then end, then name, then id — a stable chronological
// order with deterministic tiebreaks.
function byStart(a: GanttInput, b: GanttInput): number {
  return (
    a.start.localeCompare(b.start) ||
    a.end.localeCompare(b.end) ||
    a.name.localeCompare(b.name) ||
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
function orderByBlockers(
  items: GanttInput[],
  edges: [string, string][],
): GanttInput[] {
  const index = new Map(items.map((t, i) => [t.id, i]));
  const parent = items.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    parent[find(a)] = find(b);
  };
  for (const [a, b] of edges) {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) union(ia, ib);
  }

  const groups = new Map<number, GanttInput[]>();
  items.forEach((t, i) => {
    const root = find(i);
    const g = groups.get(root);
    if (g) g.push(t);
    else groups.set(root, [t]);
  });

  return [...groups.values()]
    .map((g) => g.sort(byStart))
    .sort((g1, g2) => byStart(g1[0], g2[0]))
    .flat();
}
