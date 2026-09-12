"use client";

import "frappe-gantt/dist/frappe-gantt.css";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { useTaskModal } from "@/components/TaskModalProvider";
import { setTaskDates } from "@/lib/actions/tasks";
import type { BoardTask } from "@/lib/board";
import { toGanttTasks } from "@/lib/gantt";

function ymd(d: Date): string {
  // Use local date parts so a bar dropped on a day keeps that day (avoids the
  // UTC shift that toISOString() can introduce near midnight).
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const VIEW_MODES = ["Day", "Week", "Month"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

// Matches the status bar fills in globals.css.
const LEGEND: [string, string][] = [
  ["Backlog", "#94a3b8"],
  ["To do", "#3b82f6"],
  ["In progress", "#f59e0b"],
  ["Done", "#22c55e"],
];

// frappe-gantt only draws a today marker in Day view; add one for every view so
// the current date is always visible.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function addTodayMarker(container: HTMLElement, gantt: any) {
  const bg = container.querySelector(".grid-background");
  const gridLayer = bg?.parentNode;
  const start = gantt?.gantt_start;
  const step = gantt?.options?.step;
  const cw = gantt?.options?.column_width;
  if (!bg || !gridLayer || !start || !step || !cw) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const hours = (today.getTime() - new Date(start).getTime()) / 3_600_000;
  const x = (hours / step) * cw;
  // A column spans `step` hours; highlight just today (one day wide), not the
  // whole week/month column. Keep a minimum so it stays visible in Month view.
  const dayWidth = Math.max(2, (24 / step) * cw);
  const ns = "http://www.w3.org/2000/svg";
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", String(x));
  rect.setAttribute("y", "0");
  rect.setAttribute("width", String(dayWidth));
  rect.setAttribute("height", bg.getAttribute("height") ?? "0");
  rect.setAttribute("class", "today-highlight");
  gridLayer.appendChild(rect);
}

export function GanttChart({ tasks }: { tasks: BoardTask[] }) {
  const { scheduled, unscheduled } = useMemo(() => toGanttTasks(tasks), [tasks]);
  const [viewMode, setViewMode] = useState<ViewMode>("Week");
  const ref = useRef<HTMLDivElement>(null);

  // On phones default to the denser Month view so more of the timeline fits in
  // one screenful. Checked once on mount (not in the initial state) so the
  // server-rendered markup and the hydration pass agree.
  useEffect(() => {
    if (window.matchMedia("(max-width: 640px)").matches) setViewMode("Month");
  }, []);
  const router = useRouter();
  const { openTask } = useTaskModal();
  const projById = useMemo(
    () => new Map(tasks.map((t) => [t.id, t.projectId])),
    [tasks],
  );

  useEffect(() => {
    let cancelled = false;
    const el = ref.current;
    if (!el || scheduled.length === 0) return;
    el.innerHTML = ""; // clear a previous render (view-mode change / re-run)

    // Open our standard task modal on a genuine click of a bar (frappe-gantt's
    // own popup is suppressed via CSS). A drag to reschedule moves the pointer,
    // so we only treat near-stationary press/release on the same bar as a click.
    let downPos: { x: number; y: number } | null = null;
    let downId: string | null = null;
    const barId = (target: EventTarget | null) =>
      (target as Element | null)
        ?.closest?.(".bar-wrapper")
        ?.getAttribute("data-id") ?? null;
    const onDown = (e: PointerEvent) => {
      downId = barId(e.target);
      downPos = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      const id = downId;
      const pos = downPos;
      downId = null;
      downPos = null;
      if (!id || !pos) return;
      if (Math.hypot(e.clientX - pos.x, e.clientY - pos.y) >= 6) return;
      if (barId(e.target) !== id) return;
      const pid = projById.get(id);
      if (pid) openTask(pid, id);
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);

    // frappe-gantt touches `document`, so it's imported only in the browser.
    import("frappe-gantt").then((mod) => {
      if (cancelled || !ref.current) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const Gantt: any = (mod as any).default ?? mod;
      // Taller bars/rows on small screens so each bar is a comfortable tap
      // target (28 + 16 padding ≈ 44px rows). column_width is not passed:
      // frappe-gantt 0.6.1 overwrites it per view mode in update_view_scale.
      const compact = window.matchMedia("(max-width: 640px)").matches;
      const gantt = new Gantt(ref.current, scheduled, {
        view_mode: viewMode,
        date_format: "YYYY-MM-DD",
        ...(compact ? { bar_height: 28, padding: 16 } : {}),
        // Drag or resize a bar to reschedule; persist the new start/due dates.
        // frappe-gantt 0.6.1 binds dragging to mouse events only, so touch
        // scrolling/tapping never triggers an accidental reschedule.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on_date_change: (task: any, start: Date, end: Date) => {
          setTaskDates(task.id, ymd(start), ymd(end)).then(() =>
            router.refresh(),
          );
        },
      });
      // frappe-gantt animates each bar's width from 0 via an injected <animate>
      // element on every (re)render; that replays on data refresh (e.g. after a
      // drag). Bars already carry their final width, so removing the animations
      // leaves them correct and static.
      ref.current.querySelectorAll("animate").forEach((el) => el.remove());
      // frappe-gantt pads the SVG height with an extra `padding + 100` below the
      // grid, leaving dead space. Trim the SVG to the grid's real height.
      const svg = ref.current.querySelector("svg");
      const bgH = ref.current
        .querySelector(".grid-background")
        ?.getAttribute("height");
      if (svg && bgH) svg.setAttribute("height", bgH);
      if (viewMode !== "Day") addTodayMarker(ref.current, gantt);
    });

    return () => {
      cancelled = true;
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
    };
  }, [scheduled, viewMode, router, projById, openTask]);

  if (scheduled.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 text-sm text-neutral-500 dark:text-neutral-400">
        No scheduled tasks. Add a start or due date to a task to place it on the
        timeline.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          {VIEW_MODES.map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`rounded px-4 py-3 text-sm sm:px-3 sm:py-1 ${
                viewMode === m
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          {LEGEND.map(([label, color]) => (
            <span key={label} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: color }}
              />
              {label}
            </span>
          ))}
        </div>
      </div>
      {/* The SVG is rendered at a fixed pixel width; it pans horizontally
          inside frappe's own .gantt-container scroller (touch momentum and
          overscroll containment are set in globals.css), so the timeline
          scrolls within this bordered box and never widens the page body. */}
      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-2">
        <div ref={ref} />
      </div>
      {unscheduled > 0 && (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {unscheduled} unscheduled task{unscheduled === 1 ? "" : "s"} (no dates)
          not shown.
        </p>
      )}
    </div>
  );
}
