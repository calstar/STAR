"use client";

import type { User } from "@prisma/client";
import Link from "next/link";

import { deleteTask, updateTask } from "@/lib/actions/tasks";
import type { BoardTask } from "@/lib/board";
import { isBlocked } from "@/lib/tasks";

import { BlockedBadge } from "./BlockedBadge";
import { AssigneeSelect } from "./fields/AssigneeSelect";
import { DueDateInput } from "./fields/DueDateInput";
import { PrioritySelect } from "./fields/PrioritySelect";
import { StatusSelect } from "./fields/StatusSelect";

export function TaskRow({ task, users }: { task: BoardTask; users: User[] }) {
  const due = task.dueDate
    ? new Date(task.dueDate).toISOString().slice(0, 10)
    : "";
  const cell = "px-2 py-1.5 align-middle";

  return (
    <tr className="border-b border-neutral-100">
      <td className={`${cell} w-full`}>
        <div className="flex items-center gap-2">
          <form action={updateTask} className="min-w-0 flex-1">
            <input type="hidden" name="id" value={task.id} />
            <input
              name="title"
              defaultValue={task.title}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              className="w-full rounded border border-transparent px-2 py-1 text-sm hover:border-neutral-300 focus:border-neutral-400 focus:outline-none"
            />
          </form>
          {isBlocked(task.blockedBy) && <BlockedBadge />}
          <Link
            href={`/projects/${task.projectId}/tasks/${task.id}`}
            className="shrink-0 rounded px-1.5 py-1 text-xs text-neutral-500 hover:bg-neutral-100"
            title="Open task"
          >
            ↗
          </Link>
        </div>
      </td>
      <td className={cell}>
        <StatusSelect taskId={task.id} value={task.status} />
      </td>
      <td className={cell}>
        <PrioritySelect taskId={task.id} value={task.priority ?? ""} />
      </td>
      <td className={cell}>
        <AssigneeSelect taskId={task.id} value={task.assigneeId ?? ""} users={users} />
      </td>
      <td className={cell}>
        <DueDateInput taskId={task.id} value={due} />
      </td>
      <td className={cell}>
        <form action={deleteTask}>
          <input type="hidden" name="id" value={task.id} />
          <button className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50">
            Delete
          </button>
        </form>
      </td>
    </tr>
  );
}
