"use client";

import { useState } from "react";

import { updateTask } from "@/lib/actions/tasks";

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
      <form action={updateTask} className="flex-1">
        <input type="hidden" name="id" value={taskId} />
        <input
          name="title"
          defaultValue={value}
          autoFocus
          onBlur={(e) => {
            e.currentTarget.form?.requestSubmit();
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "Escape") setEditing(false);
          }}
          className="w-full rounded border border-neutral-300 px-2 py-1 text-2xl font-semibold focus:outline-none"
        />
      </form>
    );
  }

  return (
    <div className="flex flex-1 items-center gap-2">
      <h2 className="text-2xl font-semibold">{value}</h2>
      <button
        onClick={() => setEditing(true)}
        title="Rename"
        className="rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700"
      >
        ✎ Edit
      </button>
    </div>
  );
}
