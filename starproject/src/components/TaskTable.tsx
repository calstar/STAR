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
import type { TaskRowData } from "@/lib/board";

// Re-export so existing importers keep working.
export type { TaskRowData } from "@/lib/board";

const col = createColumnHelper<TaskRowData>();

// The single list/table view used everywhere (project, subteam, /tasks). Cells
// are inline-editable; the Project/Subteam columns show only where relevant.
// Clicking a row (outside an editor) opens the task modal in place.
export function TaskTable({
  rows,
  users = [],
  admin = false,
  showProject = false,
  showSubproject = false,
  showSubteam = false,
  emptyText = "No tasks match.",
}: {
  rows: TaskRowData[];
  users?: User[];
  admin?: boolean;
  showProject?: boolean;
  showSubproject?: boolean;
  showSubteam?: boolean;
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
          <div className="flex items-center gap-2">
            <span className="text-neutral-400 dark:text-neutral-500">
              #{info.row.original.number}
            </span>
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
              cell: (info) => info.getValue() || "—",
            }),
          ]
        : []),
      ...(showSubteam
        ? [
            col.accessor("subteamName", {
              header: "Subteam",
              cell: (info) => info.getValue() || "—",
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
                    className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                    title={`Delete “${info.row.original.title}”?`}
                    message="This permanently deletes the task. This cannot be undone."
                  />
                </div>
              ),
            }),
          ]
        : []),
    ],
    [showProject, showSubproject, showSubteam, users, admin],
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
                <td key={cell.id} className="px-3 py-1.5 align-middle">
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
