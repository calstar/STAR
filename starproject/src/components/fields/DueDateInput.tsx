"use client";

import { updateField } from "@/lib/fieldUpdate";

export function DueDateInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <input
      type="date"
      name="dueDate"
      defaultValue={value}
      onChange={(e) => updateField(taskId, "dueDate", e.target.value)}
      className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    />
  );
}
