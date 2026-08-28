"use client";

import "frappe-gantt/dist/frappe-gantt.css";

import { useEffect, useMemo, useRef, useState } from "react";

import type { BoardTask } from "@/lib/board";
import { toGanttTasks } from "@/lib/gantt";

const VIEW_MODES = ["Day", "Week", "Month"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

export function GanttChart({ tasks }: { tasks: BoardTask[] }) {
  const { scheduled, unscheduled } = useMemo(() => toGanttTasks(tasks), [tasks]);
  const [viewMode, setViewMode] = useState<ViewMode>("Week");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    if (!el || scheduled.length === 0) return;
    el.innerHTML = ""; // clear a previous render (view-mode change / re-run)

    // frappe-gantt touches `document`, so it's imported only in the browser.
    // Import the prebuilt UMD dist (the package `main` is SCSS source).
    import("frappe-gantt/dist/frappe-gantt.min.js").then((mod) => {
      if (cancelled || !ref.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Gantt: any = (mod as any).default ?? mod;
      new Gantt(ref.current, scheduled, {
        view_mode: viewMode,
        date_format: "YYYY-MM-DD",
        readonly: true, // forward-compatible hint; 0.6.1 ignores it (no handlers = display-only)
      });
    });

    return () => {
      cancelled = true;
    };
  }, [scheduled, viewMode]);

  if (scheduled.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500">
        No scheduled tasks. Add a start or due date to a task to place it on the
        timeline.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {VIEW_MODES.map((m) => (
          <button
            key={m}
            onClick={() => setViewMode(m)}
            className={`rounded px-3 py-1 text-sm ${
              viewMode === m
                ? "bg-neutral-900 text-white"
                : "text-neutral-600 hover:bg-neutral-100"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-white p-2">
        <div ref={ref} />
      </div>
      {unscheduled > 0 && (
        <p className="mt-2 text-sm text-neutral-500">
          {unscheduled} unscheduled task{unscheduled === 1 ? "" : "s"} (no dates)
          not shown.
        </p>
      )}
    </div>
  );
}
