import type { TaskStatus } from "@prisma/client";
import Link from "next/link";

import { BlockedBadge } from "@/components/BlockedBadge";
import { BlockerEditor } from "@/components/BlockerEditor";
import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { DescriptionInput } from "@/components/fields/DescriptionInput";
import { DueDateInput } from "@/components/fields/DueDateInput";
import { PrioritySelect } from "@/components/fields/PrioritySelect";
import { EditableTitle } from "@/components/fields/EditableTitle";
import { StatusSelect } from "@/components/fields/StatusSelect";
import { SubteamSelect } from "@/components/fields/SubteamSelect";
import { removeBlocker } from "@/lib/actions/blockers";
import type { TaskDetailData } from "@/lib/task-detail";
import { STATUS_BADGE, STATUS_LABEL, isBlocked } from "@/lib/tasks";

function pill(status: TaskStatus): string {
  return `rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`;
}

export function TaskDetail({ data }: { data: TaskDetailData }) {
  const { task, users, candidates, subteams } = data;
  const due = task.dueDate
    ? new Date(task.dueDate).toISOString().slice(0, 10)
    : "";

  const label = "text-xs font-medium uppercase tracking-wide text-neutral-500";
  const section = "rounded-lg border border-neutral-200 bg-white p-4 shadow-sm";

  return (
    <div>
      <div className="flex items-center gap-2 text-sm text-neutral-500">
        <Link href="/" className="hover:underline">
          Projects
        </Link>
        <span>/</span>
        {task.project.parent && (
          <>
            <Link
              href={`/projects/${task.project.parent.id}`}
              className="hover:underline"
            >
              {task.project.parent.name}
            </Link>
            <span>›</span>
          </>
        )}
        <Link href={`/projects/${task.project.id}`} className="hover:underline">
          {task.project.name}
        </Link>
      </div>

      <div className="mt-3 flex items-center gap-3 pr-8">
        <EditableTitle taskId={task.id} value={task.title} />
        {isBlocked(task.blockedBy) && <BlockedBadge />}
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className={section}>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <p className={label}>Status</p>
              <div className="mt-1">
                <StatusSelect taskId={task.id} value={task.status} />
              </div>
            </div>
            <div>
              <p className={label}>Priority</p>
              <div className="mt-1">
                <PrioritySelect taskId={task.id} value={task.priority ?? ""} />
              </div>
            </div>
            <div>
              <p className={label}>Assignee</p>
              <div className="mt-1">
                <AssigneeSelect
                  taskId={task.id}
                  value={task.assigneeId ?? ""}
                  users={users}
                />
              </div>
            </div>
            <div>
              <p className={label}>Due</p>
              <div className="mt-1">
                <DueDateInput taskId={task.id} value={due} />
              </div>
            </div>
          </div>
          <div className="mt-3">
            <p className={label}>Subteam</p>
            <div className="mt-1">
              <SubteamSelect
                taskId={task.id}
                value={task.subteamId ?? ""}
                subteams={subteams}
              />
            </div>
          </div>
          <div className="mt-3">
            <p className={label}>Description</p>
            <div className="mt-1">
              <DescriptionInput taskId={task.id} value={task.description ?? ""} />
            </div>
          </div>
        </div>

        <div className={section}>
          <p className={label}>Blocked by</p>
          <ul className="mt-2 space-y-1.5">
            {task.blockedBy.length === 0 && (
              <li className="text-sm text-neutral-500">
                Nothing blocking this task.
              </li>
            )}
            {task.blockedBy.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <Link
                  href={`/projects/${task.projectId}/tasks/${b.blockedByTask.id}`}
                  className="hover:underline"
                >
                  {b.blockedByTask.title}
                </Link>
                <span className={pill(b.blockedByTask.status)}>
                  {STATUS_LABEL[b.blockedByTask.status]}
                </span>
                <form action={removeBlocker} className="ml-auto">
                  <input type="hidden" name="taskId" value={task.id} />
                  <input type="hidden" name="blockedById" value={b.blockedById} />
                  <button className="text-xs text-red-600 hover:underline">
                    remove
                  </button>
                </form>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <BlockerEditor taskId={task.id} candidates={candidates} />
          </div>

          <p className={`${label} mt-5`}>Blocking</p>
          <ul className="mt-2 space-y-1.5">
            {task.blocking.length === 0 && (
              <li className="text-sm text-neutral-500">
                This task isn&apos;t blocking anything.
              </li>
            )}
            {task.blocking.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <Link
                  href={`/projects/${task.projectId}/tasks/${b.task.id}`}
                  className="hover:underline"
                >
                  {b.task.title}
                </Link>
                <span className={pill(b.task.status)}>
                  {STATUS_LABEL[b.task.status]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
