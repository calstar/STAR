"use client";

import { useRouter } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useTaskModal } from "@/components/TaskModalProvider";
import { setTaskDates } from "@/lib/actions/tasks";
import { type BoardTask, STATUS_COLUMNS } from "@/lib/board";
import {
  type TimelineGrouping,
  type TimelineItem,
  dayToDate,
  dayToYmd,
  toTimeline,
  todayDay,
} from "@/lib/gantt";

const VIEW_MODES = ["Day", "Week", "Month"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

// Pixels per day, and how many days of slack to show either side of the work.
const SCALE: Record<ViewMode, { ppd: number; pad: number }> = {
  Day: { ppd: 36, pad: 7 },
  Week: { ppd: 14, pad: 21 },
  Month: { ppd: 4, pad: 60 },
};

const ROW_H = 40;
const GROUP_H = 32;
const BAR_H = 22;
const MONTH_H = 22;
const DAYS_H = 24;
const DIAMOND = 14;

const STATUS_LABEL = Object.fromEntries(
  STATUS_COLUMNS.map((s) => [s.key, s.label]),
);

const fmtDay = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});
const fmtMonthLong = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const fmtMonthShort = new Intl.DateTimeFormat("en-US", {
  month: "short",
  timeZone: "UTC",
});
const dayLabel = (d: number) => fmtDay.format(dayToDate(d));

/** The Monday on or before `day` (day numbers are UTC). */
function mondayOf(day: number): number {
  return day - ((dayToDate(day).getUTCDay() + 6) % 7);
}

/** The 1st of the month containing `day`. */
function monthStartOf(day: number): number {
  const d = dayToDate(day);
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 86_400_000,
  );
}

function nextMonthStart(day: number): number {
  const d = dayToDate(day);
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 86_400_000,
  );
}

type Drag = {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  dd: number;
  moved: boolean;
};

type Row =
  | {
      kind: "group";
      key: string;
      label: string;
      color: string | null;
      count: number;
      start: number;
      end: number;
      y: number;
    }
  | { kind: "task"; item: TimelineItem; y: number };

export function GanttChart({ tasks }: { tasks: BoardTask[] }) {
  const router = useRouter();
  const { openTask } = useTaskModal();
  const today = todayDay();
  const [grouping, setGrouping] = useState<TimelineGrouping>("subproject");
  const { groups, unscheduled } = useMemo(
    () => toTimeline(tasks, today, grouping),
    [tasks, today, grouping],
  );
  // Only offer the toggle when grouping would actually split the rows.
  const groupable = useMemo(
    () => toTimeline(tasks, today, "subproject").groups.length > 1,
    [tasks, today],
  );

  const [viewMode, setViewMode] = useState<ViewMode>("Week");
  const [leftW, setLeftW] = useState(272);
  const [viewW, setViewW] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDragState] = useState<Drag | null>(null);
  // The live drag also sits in a ref: pointer events can arrive faster than
  // React re-renders, and a handler reading state would see the previous one.
  const dragRef = useRef<Drag | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const [hover, setHover] = useState<{
    id: string;
    x: number;
    y: number;
  } | null>(null);
  // Dates committed by a drag, shown until the refreshed `tasks` arrive. Keyed
  // to the `tasks` they were made against, so a refresh drops them by itself.
  const [pending, setPending] = useState<{
    tasks: BoardTask[];
    dates: Record<string, { start: number; end: number }>;
  }>({ tasks, dates: {} });
  const committed = pending.tasks === tasks ? pending.dates : {};

  const scrollRef = useRef<HTMLDivElement>(null);

  // Phones get the denser Month view and a narrower task column. Checked on
  // mount (not in initial state) so server markup and hydration agree.
  useEffect(() => {
    if (window.matchMedia("(max-width: 640px)").matches) {
      setViewMode("Month");
      setLeftW(150);
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { ppd, pad } = SCALE[viewMode];
  const items = groups.flatMap((g) => g.items);
  const byId = new Map(items.map((t) => [t.id, t]));

  // Effective dates: committed drag result, then the live drag on top.
  const dates = (
    t: TimelineItem,
    live: Drag | null = drag,
  ): { start: number; end: number } => {
    const base = committed[t.id] ?? { start: t.start, end: t.end };
    if (!live || live.id !== t.id) return base;
    const { dd, mode } = live;
    if (mode === "move" || t.dueOnly)
      return { start: base.start + dd, end: base.end + dd };
    if (mode === "start")
      return { start: Math.min(base.start + dd, base.end), end: base.end };
    return { start: base.start, end: Math.max(base.end + dd, base.start) };
  };

  // Time range: the work plus slack, widened to fill the viewport. Day view
  // starts on a Monday; the coarser views start on the 1st of a month.
  const lo = Math.min(today, ...items.map((t) => t.start)) - pad;
  const origin = viewMode === "Day" ? mondayOf(lo) : monthStartOf(lo);
  const minDays = Math.ceil(Math.max(0, viewW - leftW) / ppd) + 1;
  const last = Math.max(today, ...items.map((t) => t.end)) + pad;
  const nDays = Math.max(last - origin + 1, minDays);
  const width = nDays * ppd;
  const x = (day: number) => (day - origin) * ppd;

  // Visible rows with their y offsets. Group headers only when there is more
  // than one group to tell apart.
  const showGroups = groups.length > 1;
  const rows: Row[] = [];
  let y = 0;
  for (const g of groups) {
    if (showGroups) {
      rows.push({
        kind: "group",
        key: g.key,
        label: g.label,
        color: g.color,
        count: g.items.length,
        start: Math.min(...g.items.map((t) => dates(t).start)),
        end: Math.max(...g.items.map((t) => dates(t).end)),
        y,
      });
      y += GROUP_H;
      if (collapsed.has(g.key)) continue;
    }
    for (const item of g.items) {
      rows.push({ kind: "task", item, y });
      y += ROW_H;
    }
  }
  const bodyH = y;
  const rowY = new Map(
    rows.flatMap((r) => (r.kind === "task" ? [[r.item.id, r.y] as const] : [])),
  );

  // Axis: month segments on top; day numbers below (every day in Day view,
  // Mondays otherwise). Gridlines: faint weeks, stronger month boundaries.
  const months: { start: number; end: number }[] = [];
  for (let m = origin; m < origin + nDays; m = nextMonthStart(m)) {
    months.push({ start: m, end: Math.min(nextMonthStart(m), origin + nDays) });
  }
  const ticks: number[] = [];
  for (
    let d = viewMode === "Day" ? origin : mondayOf(origin) + 7;
    d < origin + nDays;
    d += viewMode === "Day" ? 1 : 7
  ) {
    ticks.push(d);
  }

  const scrollToToday = (behavior: ScrollBehavior) => {
    const el = scrollRef.current;
    if (!el) return;
    const left = x(today) - (el.clientWidth - leftW) * 0.3;
    el.scrollTo({ left: Math.max(0, left), behavior });
  };
  // Land on today when the chart opens and whenever the scale changes.
  useLayoutEffect(() => {
    scrollToToday("instant");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, leftW, items.length > 0]);

  const commit = (t: TimelineItem, d: Drag) => {
    const next = dates(t, d);
    const base = committed[t.id] ?? { start: t.start, end: t.end };
    if (next.start === base.start && next.end === base.end) return;
    setPending({ tasks, dates: { ...committed, [t.id]: next } });
    setTaskDates(
      t.id,
      t.dueOnly ? "" : dayToYmd(next.start),
      dayToYmd(next.end),
    )
      .then(() => router.refresh())
      .catch(() => setPending({ tasks, dates: {} }));
  };

  // Dragging is mouse-only so a touch swipe scrolls instead of rescheduling;
  // a press that doesn't move is a click and opens the task.
  const onBarDown = (
    e: React.PointerEvent,
    t: TimelineItem,
    mode: Drag["mode"],
  ) => {
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ id: t.id, mode, x0: e.clientX, dd: 0, moved: false });
  };
  const onTrackMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.x0;
    const dd = Math.round(dx / ppd);
    const moved = drag.moved || Math.abs(dx) > 3;
    if (dd !== drag.dd || moved !== drag.moved) setDrag({ ...drag, dd, moved });
    setHover({ id: drag.id, x: e.clientX, y: e.clientY });
  };
  const onTrackUp = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    // Take the release position too, in case no move event preceded it.
    const dx = e.clientX - drag.x0;
    drag.dd = Math.round(dx / ppd);
    drag.moved = drag.moved || Math.abs(dx) > 3;
    const t = byId.get(drag.id);
    setDrag(null);
    if (!t) return;
    if (drag.moved) commit(t, drag);
    else openTask(t.projectId, t.id);
  };
  // Touch/pen taps (mouse presses are handled on pointer-up above).
  const onBarClick = (e: React.MouseEvent, t: TimelineItem) => {
    const type = (e.nativeEvent as PointerEvent).pointerType;
    if (type === "mouse") return;
    openTask(t.projectId, t.id);
  };

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const hovered = hover ? byId.get(hover.id) : undefined;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-800">
          {VIEW_MODES.map((m) => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`rounded-md px-4 py-2 text-sm sm:px-3 sm:py-1 ${
                viewMode === m
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
        {groupable && (
          <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 dark:border-neutral-800">
            {(
              [
                ["subproject", "By subproject"],
                ["none", "Chronological"],
              ] as const
            ).map(([g, label]) => (
              <button
                key={g}
                onClick={() => setGrouping(g)}
                aria-pressed={grouping === g}
                className={`rounded-md px-4 py-2 text-sm sm:px-3 sm:py-1 ${
                  grouping === g
                    ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                    : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => scrollToToday("smooth")}
          className="rounded-lg border border-neutral-200 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-200 dark:hover:bg-neutral-800 sm:px-3 sm:py-1"
        >
          Today
        </button>
        <Legend />
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400">
          No scheduled tasks. Add a start or due date to a task to place it on
          the timeline.
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="tl max-h-[70vh] overflow-auto overscroll-x-contain rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div
            style={{ width: leftW + width }}
            className={drag ? "select-none" : ""}
          >
            {/* Sticky axis */}
            <div className="sticky top-0 z-20 flex border-b border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
              <div
                style={{ width: leftW, height: MONTH_H + DAYS_H }}
                className="sticky left-0 z-10 flex shrink-0 items-end border-r border-neutral-200 bg-white px-3 pb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400"
              >
                Task
              </div>
              <div
                className="relative shrink-0"
                style={{ width, height: MONTH_H + DAYS_H }}
              >
                {months.map((m) => {
                  const w = (m.end - m.start) * ppd;
                  const d = dayToDate(m.start);
                  const label =
                    w >= 110
                      ? fmtMonthLong.format(d)
                      : w >= 30
                        ? fmtMonthShort.format(d)
                        : "";
                  return (
                    <div
                      key={m.start}
                      className="absolute top-0 border-l border-neutral-300 dark:border-neutral-700"
                      style={{
                        left: x(m.start),
                        width: w,
                        height: MONTH_H + DAYS_H,
                      }}
                    >
                      <span
                        className="sticky block w-max px-2 pt-1 text-xs font-semibold text-neutral-700 dark:text-neutral-200"
                        style={{ left: leftW }}
                      >
                        {label}
                      </span>
                    </div>
                  );
                })}
                {ticks.map((d) => {
                  const weekend =
                    viewMode === "Day" && dayToDate(d).getUTCDay() % 6 === 0;
                  return (
                    <span
                      key={d}
                      className={`absolute text-[11px] tabular-nums ${
                        weekend
                          ? "text-neutral-300 dark:text-neutral-600"
                          : "text-neutral-500 dark:text-neutral-400"
                      }`}
                      style={
                        viewMode === "Day"
                          ? {
                              left: x(d),
                              width: ppd,
                              top: MONTH_H + 4,
                              textAlign: "center",
                            }
                          : { left: x(d) + 3, top: MONTH_H + 4 }
                      }
                    >
                      {dayToDate(d).getUTCDate()}
                    </span>
                  );
                })}
                <span
                  className="absolute z-10 -translate-x-1/2 rounded-full bg-indigo-500 px-1.5 py-px text-[10px] font-semibold text-white"
                  style={{ left: x(today) + ppd / 2, top: MONTH_H + 3 }}
                >
                  Today
                </span>
              </div>
            </div>

            {/* Body: sticky task column + track */}
            <div className="flex">
              <div
                style={{ width: leftW, height: bodyH }}
                className="sticky left-0 z-10 shrink-0 border-r border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
              >
                {rows.map((r) =>
                  r.kind === "group" ? (
                    <button
                      key={r.key}
                      onClick={() => toggleGroup(r.key)}
                      aria-expanded={!collapsed.has(r.key)}
                      className="tl-group flex w-full items-center gap-2 border-b border-neutral-200 px-3 text-left text-xs font-semibold text-neutral-700 dark:border-neutral-800 dark:text-neutral-200"
                      style={{ height: GROUP_H }}
                    >
                      <svg
                        viewBox="0 0 16 16"
                        className={`h-3 w-3 shrink-0 text-neutral-400 transition-transform ${collapsed.has(r.key) ? "-rotate-90" : ""}`}
                        fill="currentColor"
                        aria-hidden
                      >
                        <path d="M3 5h10l-5 6z" />
                      </svg>
                      <span
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ background: r.color ?? "#a3a3a3" }}
                      />
                      <span className="truncate">{r.label}</span>
                      <span className="ml-auto font-normal text-neutral-400">
                        {r.count}
                      </span>
                    </button>
                  ) : (
                    <TaskLabel
                      key={r.item.id}
                      item={r.item}
                      {...dates(r.item)}
                      onOpen={() => openTask(r.item.projectId, r.item.id)}
                    />
                  ),
                )}
              </div>

              <div
                className="relative shrink-0"
                style={{ width, height: bodyH }}
                onPointerMove={onTrackMove}
                onPointerUp={onTrackUp}
                onPointerCancel={() => setDrag(null)}
              >
                <svg
                  className="pointer-events-none absolute inset-0"
                  width={width}
                  height={bodyH}
                  aria-hidden
                >
                  {viewMode === "Day" &&
                    ticks.map((d) => (
                      <line
                        key={`d${d}`}
                        x1={x(d)}
                        x2={x(d)}
                        y1={0}
                        y2={bodyH}
                        className="tl-grid-day"
                      />
                    ))}
                  {viewMode !== "Day" &&
                    ticks.map((d) => (
                      <line
                        key={`w${d}`}
                        x1={x(d)}
                        x2={x(d)}
                        y1={0}
                        y2={bodyH}
                        className="tl-grid-week"
                      />
                    ))}
                  {months.map((m) => (
                    <line
                      key={`m${m.start}`}
                      x1={x(m.start)}
                      x2={x(m.start)}
                      y1={0}
                      y2={bodyH}
                      className="tl-grid-month"
                    />
                  ))}
                  {rows.map((r) => (
                    <line
                      key={`r${r.y}`}
                      x1={0}
                      x2={width}
                      y1={r.y + (r.kind === "group" ? GROUP_H : ROW_H) - 0.5}
                      y2={r.y + (r.kind === "group" ? GROUP_H : ROW_H) - 0.5}
                      className="tl-grid-row"
                    />
                  ))}
                </svg>

                {rows.map((r) =>
                  r.kind === "group" ? (
                    <div
                      key={r.key}
                      className="tl-group absolute left-0"
                      style={{ top: r.y, width, height: GROUP_H - 1 }}
                    >
                      <div
                        className="absolute h-1.5 rounded-full opacity-60"
                        style={{
                          left: x(r.start),
                          width: (r.end - r.start + 1) * ppd,
                          top: (GROUP_H - 6) / 2,
                          background: r.color ?? "#a3a3a3",
                        }}
                      />
                    </div>
                  ) : null,
                )}

                <Connectors
                  rows={rows}
                  rowY={rowY}
                  byId={byId}
                  dates={dates}
                  x={x}
                  ppd={ppd}
                  width={width}
                  height={bodyH}
                />

                <div
                  className="pointer-events-none absolute top-0 w-0.5 -translate-x-1/2 bg-indigo-500"
                  style={{ left: x(today) + ppd / 2, height: bodyH }}
                />

                {rows.map((r) => {
                  if (r.kind !== "task") return null;
                  const t = r.item;
                  const { start, end } = dates(t);
                  const cls = `tl-${t.status} ${t.overdue ? "tl-overdue" : ""} ${
                    drag?.id === t.id ? "tl-dragging" : ""
                  }`;
                  const common = {
                    role: "button",
                    tabIndex: 0,
                    "aria-label": `${t.title}, ${STATUS_LABEL[t.status]}, ${
                      t.dueOnly
                        ? `due ${dayLabel(end)}`
                        : `${dayLabel(start)} to ${dayLabel(end)}`
                    }`,
                    onPointerEnter: (e: React.PointerEvent) =>
                      setHover({ id: t.id, x: e.clientX, y: e.clientY }),
                    onPointerMove: (e: React.PointerEvent) =>
                      !drag &&
                      setHover({ id: t.id, x: e.clientX, y: e.clientY }),
                    onPointerLeave: () => !drag && setHover(null),
                    onClick: (e: React.MouseEvent) => onBarClick(e, t),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openTask(t.projectId, t.id);
                      }
                    },
                  } as const;
                  if (t.dueOnly) {
                    return (
                      <div
                        key={t.id}
                        {...common}
                        onPointerDown={(e) => onBarDown(e, t, "move")}
                        className={`tl-diamond absolute cursor-grab rotate-45 rounded-[3px] ${cls}`}
                        style={{
                          left: x(end) + (ppd - DIAMOND) / 2,
                          top: r.y + (ROW_H - DIAMOND) / 2,
                          width: DIAMOND,
                          height: DIAMOND,
                        }}
                      />
                    );
                  }
                  const w = Math.max((end - start + 1) * ppd, 6);
                  return (
                    <div
                      key={t.id}
                      {...common}
                      onPointerDown={(e) => onBarDown(e, t, "move")}
                      className={`tl-bar group absolute cursor-grab rounded-md ${cls}`}
                      style={{
                        left: x(start),
                        top: r.y + (ROW_H - BAR_H) / 2,
                        width: w,
                        height: BAR_H,
                      }}
                    >
                      {w >= 28 && (
                        <>
                          <span
                            onPointerDown={(e) => onBarDown(e, t, "start")}
                            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize"
                          />
                          <span
                            onPointerDown={(e) => onBarDown(e, t, "end")}
                            className="absolute inset-y-0 right-0 flex w-2 cursor-ew-resize items-center justify-center"
                          >
                            <span className="h-2.5 w-px bg-current opacity-0 group-hover:opacity-50" />
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

      {hovered && hover && (
        <Tooltip item={hovered} {...dates(hovered)} x={hover.x} y={hover.y} />
      )}

      {unscheduled.length > 0 && (
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          {unscheduled.length} task{unscheduled.length === 1 ? "" : "s"} not on
          the timeline
        </p>
      )}
    </div>
  );
}

function TaskLabel({
  item,
  start,
  end,
  onOpen,
}: {
  item: TimelineItem;
  start: number;
  end: number;
  onOpen: () => void;
}) {
  const when = item.dueOnly
    ? `Due ${dayLabel(end)}`
    : start === end
      ? dayLabel(start)
      : `${dayLabel(start)} – ${dayLabel(end)}`;
  return (
    <button
      onClick={onOpen}
      className="flex w-full flex-col justify-center px-3 text-left hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
      style={{ height: ROW_H }}
    >
      <span className="flex w-full items-center gap-2">
        <span
          className={`tl-${item.status} h-2 w-2 shrink-0 rounded-full`}
          style={{ background: "var(--tl)" }}
        />
        <span className="truncate text-[13px] font-medium leading-tight text-neutral-900 dark:text-neutral-100">
          {item.title}
        </span>
      </span>
      <span className="truncate pl-4 text-[11px] leading-tight text-neutral-500 dark:text-neutral-400">
        {item.assignees && <>{item.assignees} · </>}
        <span className={item.overdue ? "text-red-600 dark:text-red-400" : ""}>
          {when}
        </span>
      </span>
    </button>
  );
}

/** Blocker → blocked connectors. Red when the blocker ends on or after the
 * day the blocked task starts — a schedule that can't be met as drawn. */
function Connectors({
  rows,
  rowY,
  byId,
  dates,
  x,
  ppd,
  width,
  height,
}: {
  rows: Row[];
  rowY: Map<string, number>;
  byId: Map<string, TimelineItem>;
  dates: (t: TimelineItem) => { start: number; end: number };
  x: (day: number) => number;
  ppd: number;
  width: number;
  height: number;
}) {
  const edge = (t: TimelineItem, side: "in" | "out") => {
    const { start, end } = dates(t);
    if (t.dueOnly)
      return (
        x(end) + ppd / 2 + (side === "out" ? DIAMOND / 2 + 2 : -DIAMOND / 2 - 2)
      );
    return side === "out" ? x(end + 1) : x(start);
  };
  const paths: { d: string; conflict: boolean; key: string }[] = [];
  for (const r of rows) {
    if (r.kind !== "task") continue;
    const t = r.item;
    for (const depId of t.deps) {
      const dep = byId.get(depId);
      const yd = rowY.get(depId);
      if (!dep || yd === undefined) continue;
      const x1 = edge(dep, "out");
      const y1 = yd + ROW_H / 2;
      const x2 = edge(t, "in");
      const y2 = r.y + ROW_H / 2;
      let d: string;
      if (x2 - x1 >= 16) {
        const xm = x1 + 8;
        d = `M${x1},${y1} H${xm} V${y2} H${x2}`;
      } else {
        const ym = y2 > y1 ? r.y : r.y + ROW_H;
        d = `M${x1},${y1} h8 V${ym} H${x2 - 8} V${y2} H${x2}`;
      }
      paths.push({
        d,
        conflict: dates(dep).end >= dates(t).start,
        key: `${depId}-${t.id}`,
      });
    }
  }
  if (paths.length === 0) return null;
  return (
    <svg
      className="pointer-events-none absolute inset-0 overflow-visible"
      width={width}
      height={height}
      aria-hidden
    >
      <defs>
        <marker
          id="tl-arrow"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 z" className="tl-link-head" />
        </marker>
        <marker
          id="tl-arrow-bad"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="6"
          markerHeight="6"
          orient="auto"
        >
          <path d="M0,0 L6,3 L0,6 z" fill="#ef4444" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          strokeWidth={1.25}
          className={p.conflict ? "stroke-red-500" : "tl-link"}
          markerEnd={`url(#${p.conflict ? "tl-arrow-bad" : "tl-arrow"})`}
        />
      ))}
    </svg>
  );
}

function Tooltip({
  item,
  start,
  end,
  x,
  y,
}: {
  item: TimelineItem;
  start: number;
  end: number;
  x: number;
  y: number;
}) {
  const days = end - start + 1;
  // Keep it on screen: flip to the left of the cursor near the right edge.
  const flip = typeof window !== "undefined" && x > window.innerWidth - 260;
  return (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 w-60 rounded-lg border border-neutral-200 bg-white p-2.5 text-xs shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
      style={{ top: y + 14, left: flip ? x - 252 : x + 12 }}
    >
      <p className="font-medium text-neutral-900 dark:text-neutral-100">
        {item.title}
      </p>
      <p className="mt-1 text-neutral-600 dark:text-neutral-300">
        {item.dueOnly
          ? `Due ${dayLabel(end)}`
          : `${dayLabel(start)} → ${dayLabel(end)} · ${days} day${days === 1 ? "" : "s"}`}
      </p>
      <p className="mt-0.5 text-neutral-500 dark:text-neutral-400">
        {item.assignees || "Unassigned"}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <span
          className={`tl-${item.status} inline-flex items-center gap-1 text-neutral-700 dark:text-neutral-200`}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{ background: "var(--tl)" }}
          />
          {STATUS_LABEL[item.status]}
        </span>
        {item.blocked && item.status !== "blocked" && (
          <span className="rounded bg-red-50 px-1 text-red-700 dark:bg-red-950/50 dark:text-red-300">
            Blocked
          </span>
        )}
        {item.overdue && (
          <span className="rounded bg-red-50 px-1 text-red-700 dark:bg-red-950/50 dark:text-red-300">
            Overdue
          </span>
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500 dark:text-neutral-400">
      {STATUS_COLUMNS.map((s) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span
            className={`tl-bar tl-${s.key} inline-block h-2.5 w-4 rounded-sm`}
          />
          {s.label}
        </span>
      ))}
      <span className="flex items-center gap-1.5">
        <span className="tl-bar tl-todo tl-overdue inline-block h-2.5 w-4 rounded-sm" />
        Overdue
      </span>
      <span className="flex items-center gap-1.5">
        <span className="tl-diamond tl-todo inline-block h-2 w-2 rotate-45 rounded-[2px]" />
        Due date
      </span>
    </div>
  );
}
