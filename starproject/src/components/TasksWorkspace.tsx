"use client";

import type { TaskStatus, User } from "@prisma/client";
import { useMemo, useState } from "react";

import { Board } from "@/components/Board";
import { FieldSelect } from "@/components/fields/FieldSelect";
import { GanttChart } from "@/components/GanttChart";
import { TaskTable } from "@/components/TaskTable";
import { ViewDock } from "@/components/ViewDock";
import { BOARD_SORT_OPTIONS, type BoardSort, type WorkspaceTask, toRowData } from "@/lib/board";
import { STATUS_LABEL } from "@/lib/tasks";

export type { WorkspaceTask } from "@/lib/board";

type View = "table" | "board" | "gantt";

// How many filter chips a row shows before collapsing behind "+N more".
const CHIP_LIMIT = 8;

// A capped filter-chip row: shows the first CHIP_LIMIT options (plus any
// selected ones beyond the cap, so an active filter is never hidden) with a
// "+N more" chip to expand. Collapsed on mobile it stays a single
// horizontally-scrollable line; expanded it wraps at every width.
function ChipRow({
  label,
  options,
  selected,
  onToggle,
  chip,
}: {
  label: string;
  options: { id: string; label: string }[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  chip: (active: boolean) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  // No point hiding a single option behind a "+1 more" chip of the same size.
  const collapsible = options.length > CHIP_LIMIT + 1;
  const visible =
    expanded || !collapsible
      ? options
      : [
          ...options.slice(0, CHIP_LIMIT),
          ...options.slice(CHIP_LIMIT).filter((o) => selected.has(o.id)),
        ];
  const hiddenCount = options.length - visible.length;

  // The label sits outside the scroll container so it stays pinned on the
  // left while the chips carousel past it on mobile.
  return (
    <div className={`flex gap-1.5 ${expanded ? "items-start" : "items-center"}`}>
      <span
        className={`shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400 ${
          expanded ? "py-2.5 sm:py-1" : ""
        }`}
      >
        {label}
      </span>
      <div
        className={`flex min-w-0 flex-1 items-center gap-1.5 ${
          expanded
            ? "flex-wrap"
            : "flex-nowrap overflow-x-auto sm:flex-wrap sm:overflow-x-visible"
        }`}
      >
        {visible.map((o) => (
          <button
            key={o.id}
            onClick={() => onToggle(o.id)}
            className={chip(selected.has(o.id))}
          >
            {o.label}
          </button>
        ))}
        {collapsible && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className={`${chip(false)} font-medium`}
          >
            {expanded ? "Show less" : `+${hiddenCount} more`}
          </button>
        )}
      </div>
    </div>
  );
}

export function TasksWorkspace({
  tasks,
  projects,
  subteams,
  users,
  admin,
  currentUserId,
  initialSubteam,
  initialMine = false,
}: {
  tasks: WorkspaceTask[];
  projects: { id: string; label: string }[];
  subteams: { id: string; name: string }[];
  users: User[];
  admin: boolean;
  currentUserId: string;
  initialSubteam?: string;
  initialMine?: boolean;
}) {
  const [view, setView] = useState<View>("table");
  const [boardSort, setBoardSort] = useState<BoardSort>("due");
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [myOnly, setMyOnly] = useState(initialMine);
  const [projSel, setProjSel] = useState<Set<string>>(new Set());
  const [subSel, setSubSel] = useState<Set<string>>(
    initialSubteam ? new Set([initialSubteam]) : new Set(),
  );

  const filtered = useMemo(
    () =>
      tasks.filter((t) => {
        if (status && t.status !== status) return false;
        if (myOnly && !t.assignees.some((a) => a.id === currentUserId))
          return false;
        if (projSel.size && !projSel.has(t.projectId)) return false;
        if (subSel.size && (!t.subteamId || !subSel.has(t.subteamId)))
          return false;
        if (search) {
          const hay =
            `${t.title} ${t.projectName} ${t.subteamName} ${t.assigneeName}`.toLowerCase();
          if (!hay.includes(search.toLowerCase())) return false;
        }
        return true;
      }),
    [tasks, status, myOnly, currentUserId, projSel, subSel, search],
  );

  const active = useMemo(() => filtered.filter((t) => !t.archived), [filtered]);
  const archived = useMemo(() => filtered.filter((t) => t.archived), [filtered]);
  const rows = useMemo(() => active.map(toRowData), [active]);
  const archivedRows = useMemo(() => archived.map(toRowData), [archived]);

  function toggle(set: Set<string>, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }

  const anyFilter =
    !!search || !!status || myOnly || projSel.size > 0 || subSel.size > 0;

  const tabBtn = (v: View) =>
    `rounded px-3 py-1 text-sm ${
      view === v
        ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;
  const chip = (active: boolean) =>
    `min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 py-0.5 text-sm sm:min-h-0 sm:shrink sm:px-2.5 ${
      active
        ? "border-neutral-900 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
        : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;

  return (
    // pb-20 keeps content clear of the mobile ViewDock (the page container has
    // no extra bottom padding of its own on mobile).
    <div className="pb-20 sm:pb-0">
      <ViewDock
        active={view === "table" ? "list" : view}
        onSelect={(v) => setView(v === "list" ? "table" : v)}
      />
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          {/* Desktop tabs; the ViewDock replaces them on mobile. */}
          <div className="hidden items-center gap-1 sm:flex">
            <button onClick={() => setView("table")} className={tabBtn("table")}>
              List
            </button>
            <button onClick={() => setView("board")} className={tabBtn("board")}>
              Board
            </button>
            <button onClick={() => setView("gantt")} className={tabBtn("gantt")}>
              Timeline
            </button>
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks…"
            className="min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm sm:min-h-0 sm:w-auto sm:min-w-48 sm:flex-1"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setMyOnly((v) => !v)}
              className={`min-h-11 rounded px-3 py-1.5 text-sm font-medium sm:min-h-0 ${
                myOnly
                  ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                  : "border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              }`}
            >
              My tasks
            </button>
            <FieldSelect
              ariaLabel="Filter by status"
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "All statuses" },
                ...(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => ({
                  value: s,
                  label: STATUS_LABEL[s],
                })),
              ]}
            />
            {view === "board" && (
              <FieldSelect
                ariaLabel="Sort board"
                value={boardSort}
                onChange={(v) => setBoardSort(v as BoardSort)}
                options={BOARD_SORT_OPTIONS}
              />
            )}
            {anyFilter && (
              <button
                onClick={() => {
                  setSearch("");
                  setStatus("");
                  setMyOnly(false);
                  setProjSel(new Set());
                  setSubSel(new Set());
                }}
                className="min-h-11 px-2 text-sm text-neutral-500 dark:text-neutral-400 hover:underline sm:min-h-0 sm:px-0"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        <ChipRow
          label="Projects"
          options={projects.map((p) => ({ id: p.id, label: p.label }))}
          selected={projSel}
          onToggle={(id) => setProjSel((s) => toggle(s, id))}
          chip={chip}
        />

        {subteams.length > 0 && (
          <ChipRow
            label="Subteams"
            options={subteams.map((s) => ({ id: s.id, label: s.name }))}
            selected={subSel}
            onToggle={(id) => setSubSel((sel) => toggle(sel, id))}
            chip={chip}
          />
        )}
      </div>

      <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
        {active.length} task{active.length === 1 ? "" : "s"}
      </p>

      <div className="mt-2">
        {view === "table" && (
          <TaskTable
            rows={rows}
            users={users}
            admin={admin}
            showProject
            showSubteam
          />
        )}
        {view === "board" && <Board tasks={active} sort={boardSort} />}
        {view === "gantt" && <GanttChart tasks={active} />}
      </div>

      {archived.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
            className="flex items-center gap-2"
          >
            <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Archived
            </span>
            <span className="text-xs text-neutral-400">({archived.length})</span>
            <span className="text-neutral-400" aria-hidden>
              {showArchived ? "▾" : "▸"}
            </span>
          </button>
          {showArchived && (
            <div className="mt-2">
              <TaskTable
                rows={archivedRows}
                users={users}
                admin={admin}
                showProject
                showSubteam
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
