"use client";

import { updateTask } from "@/lib/actions/tasks";

export function DescriptionInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <textarea
        name="description"
        defaultValue={value}
        onBlur={(e) => e.currentTarget.form?.requestSubmit()}
        rows={3}
        placeholder="Add a description…"
        className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm"
      />
    </form>
  );
}
