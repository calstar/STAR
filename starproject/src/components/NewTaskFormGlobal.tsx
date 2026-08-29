"use client";

import type { User } from "@prisma/client";
import { useRef } from "react";

import { createTask } from "@/lib/actions/tasks";

// Cross-project variant of NewTaskForm for the /tasks workspace: adds a required
// project selector since there's no ambient project here.
export function NewTaskFormGlobal({
  projects,
  users,
  subteams,
}: {
  projects: { id: string; label: string }[];
  users: User[];
  subteams: { id: string; name: string }[];
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
      <select name="projectId" required defaultValue="" className={control} aria-label="Project">
        <option value="" disabled>
          Project…
        </option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
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
      <select name="subteamId" defaultValue="" className={control} aria-label="Subteam">
        <option value="">No subteam</option>
        {subteams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
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
