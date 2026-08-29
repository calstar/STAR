"use client";

import { useState } from "react";

import { updateField } from "@/lib/fieldUpdate";

// Shows the title as text with an Edit button; clicking reveals an input that
// saves on blur/Enter. Used in the task detail popup.
export function EditableTitle({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <input
        name="title"
        defaultValue={value}
        autoFocus
        onBlur={(e) => {
          updateField(taskId, "title", e.target.value);
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            updateField(taskId, "title", (e.target as HTMLInputElement).value);
            setEditing(false);
          } else if (e.key === "Escape") {
            setEditing(false);
          }
        }}
        className="w-full rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-2xl font-semibold focus:outline-none"
      />
    );
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      <h2 className="text-2xl font-semibold">{value}</h2>
      <button
        onClick={() => setEditing(true)}
        title="Rename"
        className="rounded px-1.5 py-0.5 text-xs text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700 hover:text-neutral-700"
      >
        ✎ Edit
      </button>
    </div>
  );
}
