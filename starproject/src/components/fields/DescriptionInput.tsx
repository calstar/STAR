"use client";

import { updateField } from "@/lib/fieldUpdate";

export function DescriptionInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <textarea
      name="description"
      defaultValue={value}
      onBlur={(e) => updateField(taskId, "description", e.target.value)}
      rows={3}
      placeholder="Add a description…"
      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    />
  );
}
