"use client";

import { updateField } from "@/lib/fieldUpdate";

export function TitleInput({
  taskId,
  value,
  className,
}: {
  taskId: string;
  value: string;
  className?: string;
}) {
  return (
    <input
      name="title"
      defaultValue={value}
      onBlur={(e) => updateField(taskId, "title", e.target.value)}
      className={
        className ??
        "w-full rounded border border-transparent px-2 py-1 hover:border-neutral-300 dark:hover:border-neutral-700 focus:border-neutral-400 focus:outline-none"
      }
    />
  );
}
