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

  return { scheduled, unscheduled: tasks.length - dated.length };
}
