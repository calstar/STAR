"use client";

import type { User } from "@prisma/client";

import { updateTask } from "@/lib/actions/tasks";

export function AssigneeSelect({
  taskId,
  value,
  users,
}: {
  taskId: string;
  value: string;
  users: User[];
}) {
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <select
        name="assigneeId"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
      >
        <option value="">Unassigned</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name ?? u.email}
          </option>
        ))}
      </select>
    </form>
  );
}
