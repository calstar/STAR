"use client";

import type { User } from "@prisma/client";
import {
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useMemo, useState } from "react";

import { BlockedBadge } from "@/components/BlockedBadge";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubprojectBadge } from "@/components/SubprojectBadge";
import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { DueDateInput } from "@/components/fields/DueDateInput";
import { PrioritySelect } from "@/components/fields/PrioritySelect";
import { StatusSelect } from "@/components/fields/StatusSelect";
import { useTaskModal } from "@/components/TaskModalProvider";
import { deleteTask } from "@/lib/actions/tasks";
import { type TaskRowData, comparePriorityAsc } from "@/lib/board";

// Re-export so existing importers keep working.
export type { TaskRowData } from "@/lib/board";

const col = createColumnHelper<TaskRowData>();

// CSS-only responsive classes per column id, applied to both <th> and <td>.
// Mobile shows Task/Status/Due (+ admin delete); md: adds Priority +
// Assignees; lg: the rest. Columns absent here are visible at every width.
const columnClasses: Record<string, string> = {
  subproject: "hidden lg:table-cell",
  projectName: "hidden lg:table-cell",
  priority: "hidden md:table-cell",
  assigneeName: "hidden md:table-cell",
};

// The single list/table view used everywhere (project, subteam, /tasks). Cells
// are inline-editable; the Project/Subteam columns show only where relevant.
// Clicking a row (outside an editor) opens the task modal in place.
export function TaskTable({
  rows,
  users = [],
  admin = false,
  showProject = false,
  showSubproject = false,
  emptyText = "No tasks match.",
}: {
  rows: TaskRowData[];
  users?: User[];
  admin?: boolean;
  showProject?: boolean;
  showSubproject?: boolean;
  emptyText?: string;
}) {
  const { openTask } = useTaskModal();
  const [sorting, setSorting] = useState<SortingState>([]);
  const stop = (e: React.MouseEvent) => e.stopPropagation();

  const columns = useMemo(
    () => [
      col.accessor("title", {
        header: "Task",
        cell: (info) => (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{info.getValue()}</span>
            {info.row.original.blocked && <BlockedBadge />}
          </div>
        ),
      }),
      ...(showSubproject
        ? [
            col.accessor((r) => r.subproject?.name ?? "", {
              id: "subproject",
              header: "Subproject",
              cell: (info) => {
                const sp = info.row.original.subproject;
                return sp ? (
                  <SubprojectBadge name={sp.name} color={sp.color} />
                ) : (
                  "—"
                );
              },
            }),
          ]
        : []),
      ...(showProject
        ? [
            col.accessor("projectName", {
              header: "Project",
              cell: (info) => {
                const r = info.row.original;
                return r.projectShort ? (
                  <ProjectChip name={r.projectShort} color={r.projectColor} title={r.projectName} />
                ) : (
                  "—"
                );
              },
            }),
          ]
        : []),
      col.accessor("status", {
        header: "Status",
        cell: (info) => (
          <div onClick={stop}>
            <StatusSelect taskId={info.row.original.id} value={info.getValue()} />
          </div>
        ),
      }),
      col.accessor("priority", {
        header: "Priority",
        // By rank, not alphabetically ("high" < "low" < "medium").
        sortingFn: (a, b, id) =>
          comparePriorityAsc(a.getValue<string>(id), b.getValue<string>(id)),
        sortDescFirst: true,
        cell: (info) => (
          <div onClick={stop}>
            <PrioritySelect taskId={info.row.original.id} value={info.getValue()} />
          </div>
        ),
      }),
      col.accessor("assigneeName", {
        header: "Assignees",
        cell: (info) => (
          <div onClick={stop}>
            <AssigneeSelect
              taskId={info.row.original.id}
              value={info.row.original.assigneeIds}
              users={users}
            />
          </div>
        ),
      }),
      col.accessor("due", {
        header: "Due",
        cell: (info) => (
          <div onClick={stop} className={info.row.original.overdue ? "text-red-600" : ""}>
            <DueDateInput taskId={info.row.original.id} value={info.getValue()} />
          </div>
        ),
      }),
      ...(admin
        ? [
            col.display({
              id: "actions",
              header: "",
              cell: (info) => (
                <div onClick={stop}>
                  <ConfirmButton
                    action={deleteTask}
                    id={info.row.original.id}
                    label={<TrashIcon />}
                    ariaLabel={`Delete “${info.row.original.title}”`}
                    className="justify-center rounded p-1.5 text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                    title={`Delete “${info.row.original.title}”?`}
                    message="This permanently deletes the task. This cannot be undone."
                  />
                </div>
              ),
            }),
          ]
        : []),
    ],
    [showProject, showSubproject, users, admin],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
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
                  className={`cursor-pointer select-none px-3 py-3 font-medium md:py-2 ${columnClasses[h.column.id] ?? ""}`}
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
              <td
                colSpan={table.getAllColumns().length}
                className="px-3 py-4 text-neutral-500 dark:text-neutral-400"
              >
                {emptyText}
              </td>
            </tr>
          )}
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => openTask(row.original.projectId, row.original.id)}
              className="cursor-pointer border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className={`px-3 py-2.5 align-middle md:py-1.5 ${columnClasses[cell.column.id] ?? ""}`}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A project as a tinted chip in its own colour (neutral when it has none). */
function ProjectChip({
  name,
  color,
  title,
}: {
  name: string;
  color: string | null;
  title: string;
}) {
  const c = color ?? "#a3a3a3";
  return (
    <span
      title={title}
      className="inline-flex max-w-48 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium text-neutral-800 dark:text-neutral-100"
      style={{
        background: `color-mix(in srgb, ${c} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 30%, transparent)`,
      }}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: c }} />
      <span className="truncate">{name}</span>
    </span>
  );
}

function TrashIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </svg>
  );
}
