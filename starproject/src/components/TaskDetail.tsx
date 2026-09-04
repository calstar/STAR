"use client";

import type { TaskStatus } from "@prisma/client";
import Link from "next/link";
import { useState } from "react";

import { ActivityItem, renderActivity, timeAgo } from "@/components/ActivityLine";
import { BlockedBadge } from "@/components/BlockedBadge";
import { BlockerEditor } from "@/components/BlockerEditor";
import { CopyLinkButton } from "@/components/CopyLinkButton";
import { useTaskModal } from "@/components/TaskModalProvider";
import { AssigneeSelect } from "@/components/fields/AssigneeSelect";
import { BlockedNoteInput } from "@/components/fields/BlockedNoteInput";
import { DescriptionInput } from "@/components/fields/DescriptionInput";
import { DueDateInput } from "@/components/fields/DueDateInput";
import { PrioritySelect } from "@/components/fields/PrioritySelect";
import { EditableTitle } from "@/components/fields/EditableTitle";
import { StatusSelect } from "@/components/fields/StatusSelect";
import { SubteamSelect } from "@/components/fields/SubteamSelect";
import { removeBlocker } from "@/lib/actions/blockers";
import { archiveTask } from "@/lib/actions/tasks";
import { dateLabel } from "@/lib/activity";
import type { TaskDetailData } from "@/lib/task-detail";
import { STATUS_BADGE, STATUS_LABEL, isBlocked } from "@/lib/tasks";

function pill(status: TaskStatus): string {
  return `rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_BADGE[status]}`;
}

export function TaskDetail({ data }: { data: TaskDetailData }) {
  const { openTask, refresh } = useTaskModal();
  const { task, users, candidates, subteams } = data;
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggleArchive = async (archived: boolean) => {
    setBusy(true);
    try {
      await archiveTask(task.id, archived);
      refresh();
    } finally {
      setBusy(false);
    }
  };
  const due = task.dueDate
    ? new Date(task.dueDate).toISOString().slice(0, 10)
    : "";

  const label = "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
  const section = "rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-sm";

  return (
    <div>
      <div className="flex items-center gap-2 pr-8 text-sm text-neutral-500 dark:text-neutral-400">
        <Link href="/projects" className="hover:underline">
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
        <span className="ml-auto">
          <CopyLinkButton taskId={task.id} />
        </span>
      </div>

      <div className="mt-3 flex items-center gap-3 pr-8">
        <span className="text-2xl font-semibold text-neutral-400 dark:text-neutral-500">
          #{task.number}
        </span>
        <EditableTitle taskId={task.id} value={task.title} />
        {isBlocked(task.blockedBy) && <BlockedBadge />}
      </div>

      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        Created by {task.createdBy.email} · {dateLabel(task.createdAt)}
      </p>

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
              <p className={label}>Assignees</p>
              <div className="mt-1">
                <AssigneeSelect
                  taskId={task.id}
                  value={task.assignees.map((a) => a.id)}
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
              <li className="text-sm text-neutral-500 dark:text-neutral-400">
                Nothing blocking this task.
              </li>
            )}
            {task.blockedBy.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => openTask(task.projectId, b.blockedByTask.id)}
                  className="text-left hover:underline"
                >
                  {b.blockedByTask.title}
                </button>
                <span className={pill(b.blockedByTask.status)}>
                  {STATUS_LABEL[b.blockedByTask.status]}
                </span>
                {b.note && (
                  <span
                    className="min-w-0 flex-1 truncate italic text-neutral-500 dark:text-neutral-400"
                    title={b.note}
                  >
                    {b.note}
                  </span>
                )}
                <form
                  action={async (fd) => {
                    await removeBlocker(fd);
                    refresh();
                  }}
                  className="ml-auto"
                >
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
            <BlockerEditor
              taskId={task.id}
              candidates={candidates}
              onChanged={refresh}
            />
          </div>

          <p className={`${label} mt-5`}>Blocking</p>
          <ul className="mt-2 space-y-1.5">
            {task.blocking.length === 0 && (
              <li className="text-sm text-neutral-500 dark:text-neutral-400">
                This task isn&apos;t blocking anything.
              </li>
            )}
            {task.blocking.map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-sm">
                <button
                  type="button"
                  onClick={() => openTask(task.projectId, b.task.id)}
                  className="text-left hover:underline"
                >
                  {b.task.title}
                </button>
                <span className={pill(b.task.status)}>
                  {STATUS_LABEL[b.task.status]}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5">
            <p className={label}>Blocked comment</p>
            <div className="mt-1">
              <BlockedNoteInput
                taskId={task.id}
                value={task.blockedNote ?? ""}
              />
            </div>
          </div>
        </div>
      </div>

      <div className={`mt-4 ${section}`}>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          aria-expanded={showHistory}
          className="flex w-full items-center gap-2 text-left"
        >
          <span className={label}>History</span>
          <span className="text-xs text-neutral-400">
            ({task.activities.length})
          </span>
          <span className="ml-auto text-neutral-400" aria-hidden>
            {showHistory ? "▾" : "▸"}
          </span>
        </button>
        {showHistory && (
          <ul className="mt-2 divide-y divide-neutral-100 dark:divide-neutral-800">
            {task.activities.length === 0 && (
              <li className="py-1.5 text-sm text-neutral-500 dark:text-neutral-400">
                No history yet.
              </li>
            )}
            {task.activities.map((a) => (
              <li
                key={a.id}
                className="flex items-start justify-between gap-4 py-1.5 text-sm"
              >
                <span className="text-neutral-700 dark:text-neutral-200">
                  {renderActivity(a as ActivityItem, { withTask: false })}
                </span>
                <span className="shrink-0 text-xs text-neutral-400">
                  {timeAgo(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        {task.archived ? (
          <>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Archived — hidden from the board and lists.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => toggleArchive(false)}
              className="rounded border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-100 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              Unarchive
            </button>
          </>
        ) : task.status === "done" ? (
          <>
            <span className="text-xs text-neutral-500 dark:text-neutral-400">
              Done — archive it to move it off the board into Archived.
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => toggleArchive(true)}
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              Archive
            </button>
          </>
        ) : (
          <span className="text-xs text-neutral-400">
            Marking this task Done archives it automatically.
          </span>
        )}
      </div>
    </div>
  );
}
