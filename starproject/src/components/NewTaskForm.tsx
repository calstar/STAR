"use client";

import type { User } from "@prisma/client";
import { useRef } from "react";

import { createTask } from "@/lib/actions/tasks";

// One task-create form for every context: a project detail page pins the
// project (`projectId`); a subteam detail page pins the subteam (`subteamId`)
// and offers a project picker (`projects`); the /tasks workspace offers both
// pickers. A pinned field becomes a hidden input; an offered field a <select>.
export function NewTaskForm({
  projectId,
  projects,
  subteamId,
  users,
  subteams,
}: {
  projectId?: string;
  projects?: { id: string; label: string }[];
  subteamId?: string;
  users: User[];
  subteams?: { id: string; name: string }[];
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const control =
    "rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm";

  return (
    <form
      ref={formRef}
      action={async (fd) => {
        await createTask(fd);
        formRef.current?.reset();
      }}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3"
    >
      <input
        name="title"
        required
        placeholder="New task…"
        className={`min-w-56 flex-1 ${control}`}
      />

      {projectId ? (
        <input type="hidden" name="projectId" value={projectId} />
      ) : (
        <select
          name="projectId"
          required
          defaultValue=""
          className={control}
          aria-label="Project"
        >
          <option value="" disabled>
            Project…
          </option>
          {projects?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      )}

      <select name="priority" defaultValue="" className={control} aria-label="Priority">
        <option value="">Priority —</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>

      <select name="assigneeId" defaultValue="" className={control} aria-label="Assignee">
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name ?? u.email}
          </option>
        ))}
      </select>

      {subteamId ? (
        <input type="hidden" name="subteamId" value={subteamId} />
      ) : (
        <select name="subteamId" defaultValue="" className={control} aria-label="Subteam">
          <option value="">No subteam</option>
          {subteams?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      <input type="date" name="dueDate" className={control} aria-label="Due date" />
      <button
        type="submit"
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
      >
        Add task
      </button>
    </form>
  );
}
