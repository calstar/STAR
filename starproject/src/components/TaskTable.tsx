"use client";

import type { TaskStatus, User } from "@prisma/client";
import {
  type ColumnFiltersState,
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { PRIORITY_BADGE, STATUS_BADGE, STATUS_LABEL } from "@/lib/tasks";

import { BlockedBadge } from "./BlockedBadge";

export type TaskRowData = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: TaskStatus;
  priority: string;
  assigneeId: string;
  assigneeName: string;
  subteamId: string;
  subteamName: string;
  due: string;
  overdue: boolean;
  blocked: boolean;
};

const col = createColumnHelper<TaskRowData>();

const columns = [
  col.accessor("title", {
    header: "Task",
    cell: (info) => (
      <div className="flex items-center gap-2">
        <span className="font-medium">{info.getValue()}</span>
        {info.row.original.blocked && <BlockedBadge />}
      </div>
    ),
  }),
  col.accessor("projectId", {
    id: "project",
    header: "Project",
    filterFn: "equals",
    cell: (info) => info.row.original.projectName,
  }),
  col.accessor("subteamId", {
    id: "subteam",
    header: "Subteam",
    filterFn: "equals",
    cell: (info) => info.row.original.subteamName || "—",
  }),
  col.accessor("status", {
    header: "Status",
    filterFn: "equals",
    cell: (info) => (
      <span
        className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[info.getValue()]}`}
      >
        {STATUS_LABEL[info.getValue()]}
      </span>
    ),
  }),
  col.accessor("priority", {
    header: "Priority",
    filterFn: "equals",
    cell: (info) =>
      info.getValue() ? (
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium capitalize ${PRIORITY_BADGE[info.getValue()]}`}
        >
          {info.getValue()}
        </span>
      ) : (
        "—"
      ),
  }),
  col.accessor("assigneeId", {
    header: "Assignee",
    filterFn: "equals",
    cell: (info) => info.row.original.assigneeName || "—",
  }),
  col.accessor("due", {
    header: "Due",
    cell: (info) =>
      info.getValue() ? (
        <span className={info.row.original.overdue ? "font-medium text-red-600" : ""}>
          {info.getValue()}
        </span>
      ) : (
        "—"
      ),
  }),
];

export function TaskTable({
  rows,
  users = [],
  projects = [],
  subteams = [],
  currentUserId = "",
  initialSubteam,
  hideFilters = false,
}: {
  rows: TaskRowData[];
  users?: User[];
  projects?: { id: string; name: string }[];
  subteams?: { id: string; name: string }[];
  currentUserId?: string;
  initialSubteam?: string;
  hideFilters?: boolean;
}) {
  const router = useRouter();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(
    initialSubteam ? [{ id: "subteam", value: initialSubteam }] : [],
  );
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: (row, _id, value) => {
      const v = String(value).toLowerCase();
      const r = row.original;
      return [
        r.title,
        r.projectName,
        r.subteamName,
        r.assigneeName,
        r.priority,
        STATUS_LABEL[r.status],
      ]
        .join(" ")
        .toLowerCase()
        .includes(v);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const filterValue = (id: string) =>
    (columnFilters.find((f) => f.id === id)?.value as string) ?? "";
  const setFilter = (id: string, value: string) =>
    setColumnFilters((prev) => {
      const rest = prev.filter((f) => f.id !== id);
      return value ? [...rest, { id, value }] : rest;
    });

  const sel = "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm";

  return (
    <div>
      <div
        className={`mb-3 flex flex-wrap items-center gap-2 ${hideFilters ? "hidden" : ""}`}
      >
        <input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder="Search tasks…"
          className="min-w-48 flex-1 rounded border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm"
        />
        <button
          onClick={() =>
            setFilter(
              "assigneeId",
              filterValue("assigneeId") === currentUserId ? "" : currentUserId,
            )
          }
          className={`rounded px-3 py-1.5 text-sm font-medium ${
            filterValue("assigneeId") === currentUserId
              ? "bg-neutral-900 text-white"
              : "border border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100"
          }`}
        >
          My tasks
        </button>
        <select
          value={filterValue("project")}
          onChange={(e) => setFilter("project", e.target.value)}
          className={sel}
        >
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={filterValue("subteam")}
          onChange={(e) => setFilter("subteam", e.target.value)}
          className={sel}
        >
          <option value="">All subteams</option>
          {subteams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={filterValue("status")}
          onChange={(e) => setFilter("status", e.target.value)}
          className={sel}
        >
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          value={filterValue("assigneeId")}
          onChange={(e) => setFilter("assigneeId", e.target.value)}
          className={sel}
        >
          <option value="">All assignees</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name ?? u.email}
            </option>
          ))}
        </select>
        {(columnFilters.length > 0 || globalFilter) && (
          <button
            onClick={() => {
              setColumnFilters([]);
              setGlobalFilter("");
            }}
            className="text-sm text-neutral-500 dark:text-neutral-400 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr
                key={hg.id}
                className="border-b border-neutral-200 dark:border-neutral-800 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
              >
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    onClick={h.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none px-3 py-2 font-medium"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-4 text-neutral-500 dark:text-neutral-400">
                  No tasks match.
                </td>
              </tr>
            )}
            {table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                onClick={() =>
                  router.push(
                    `/projects/${row.original.projectId}/tasks/${row.original.id}`,
                  )
                }
                className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/40"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
