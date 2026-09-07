"use client";

import type { TaskStatus, User } from "@prisma/client";
import { useMemo, useState } from "react";

import { Board } from "@/components/Board";
import { FieldSelect } from "@/components/fields/FieldSelect";
import { GanttChart } from "@/components/GanttChart";
import { TaskTable } from "@/components/TaskTable";
import { BOARD_SORT_OPTIONS, type BoardSort, type WorkspaceTask, toRowData } from "@/lib/board";
import { STATUS_LABEL } from "@/lib/tasks";

export type { WorkspaceTask } from "@/lib/board";

type View = "table" | "board" | "gantt";

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
    `min-h-11 flex-1 rounded px-3 py-1 text-sm sm:min-h-0 sm:flex-none ${
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
    <div>
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex items-center gap-1">
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

        <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-x-visible">
          <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Projects
          </span>
          {projects.map((p) => (
            <button
              key={p.id}
              onClick={() => setProjSel((s) => toggle(s, p.id))}
              className={chip(projSel.has(p.id))}
            >
              {p.label}
            </button>
          ))}
        </div>

        {subteams.length > 0 && (
          <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-x-visible">
            <span className="shrink-0 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
              Subteams
            </span>
            {subteams.map((s) => (
              <button
                key={s.id}
                onClick={() => setSubSel((sel) => toggle(sel, s.id))}
                className={chip(subSel.has(s.id))}
              >
                {s.name}
              </button>
            ))}
          </div>
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
