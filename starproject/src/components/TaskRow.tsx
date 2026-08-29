"use client";

import type { User } from "@prisma/client";
import { useRouter } from "next/navigation";

import { deleteTask } from "@/lib/actions/tasks";
import type { BoardTask } from "@/lib/board";
import { isBlocked } from "@/lib/tasks";

import { BlockedBadge } from "./BlockedBadge";
import { AssigneeSelect } from "./fields/AssigneeSelect";
import { DueDateInput } from "./fields/DueDateInput";
import { PrioritySelect } from "./fields/PrioritySelect";
import { StatusSelect } from "./fields/StatusSelect";

export function TaskRow({
  task,
  users,
  isAdmin = false,
}: {
  task: BoardTask;
  users: User[];
  isAdmin?: boolean;
}) {
  const router = useRouter();
  const due = task.dueDate
    ? new Date(task.dueDate).toISOString().slice(0, 10)
    : "";
  const cell = "px-2 py-1.5 align-middle";

  return (
    <tr
      onClick={() => router.push(`/projects/${task.projectId}/tasks/${task.id}`)}
      className="cursor-pointer border-b border-neutral-100 hover:bg-neutral-50 dark:hover:bg-neutral-900 dark:border-neutral-800 dark:hover:bg-neutral-800/40"
    >
      <td className={`${cell} w-full`}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate px-2 py-1 text-sm font-medium">
            {task.title}
          </span>
          {isBlocked(task.blockedBy) && <BlockedBadge />}
        </div>
      </td>
      <td className={cell} onClick={(e) => e.stopPropagation()}>
        <StatusSelect taskId={task.id} value={task.status} />
      </td>
      <td className={cell} onClick={(e) => e.stopPropagation()}>
        <PrioritySelect taskId={task.id} value={task.priority ?? ""} />
      </td>
      <td className={cell} onClick={(e) => e.stopPropagation()}>
        <AssigneeSelect taskId={task.id} value={task.assigneeId ?? ""} users={users} />
      </td>
      <td className={cell} onClick={(e) => e.stopPropagation()}>
        <DueDateInput taskId={task.id} value={due} />
      </td>
      <td className={cell} onClick={(e) => e.stopPropagation()}>
        {isAdmin && (
          <form action={deleteTask}>
            <input type="hidden" name="id" value={task.id} />
            <button className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50">
              Delete
            </button>
          </form>
        )}
      </td>
    </tr>
  );
}
