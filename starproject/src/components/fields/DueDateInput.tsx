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
      min="1900-01-01"
      max="9999-12-31"
      defaultValue={value}
      onChange={(e) => {
        // A 5–6 digit year exceeds `max` below → the field is invalid; don't save
        // it, since it would feed an Invalid Date to the update and crash the request.
        if (e.currentTarget.validity.valid) {
          updateField(taskId, "dueDate", e.currentTarget.value);
        }
      }}
      className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    />
  );
}
