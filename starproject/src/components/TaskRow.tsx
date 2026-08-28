"use client";

import type { User } from "@prisma/client";
import Link from "next/link";

import { deleteTask } from "@/lib/actions/tasks";
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
          <Link
            href={`/projects/${task.projectId}/tasks/${task.id}`}
            className="min-w-0 flex-1 truncate rounded px-2 py-1 text-sm font-medium hover:bg-neutral-100 hover:underline"
          >
            {task.title}
          </Link>
          {isBlocked(task.blockedBy) && <BlockedBadge />}
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
