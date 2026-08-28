"use client";

import { updateTask } from "@/lib/actions/tasks";

export function DueDateInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <input
        type="date"
        name="dueDate"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
      />
    </form>
  );
}
