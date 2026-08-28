"use client";

import type { TaskStatus } from "@prisma/client";
import { useState } from "react";

import { updateTask } from "@/lib/actions/tasks";
import { STATUS_BADGE } from "@/lib/tasks";

const OPTS: [string, string][] = [
  ["backlog", "Backlog"],
  ["todo", "To do"],
  ["in_progress", "In progress"],
  ["done", "Done"],
];

export function StatusSelect({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  const [v, setV] = useState(value);
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <select
        name="status"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          e.currentTarget.form?.requestSubmit();
        }}
        className={`rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm font-medium ${
          STATUS_BADGE[v as TaskStatus] ?? ""
        }`}
      >
        {OPTS.map(([val, l]) => (
          <option key={val} value={val}>
            {l}
          </option>
        ))}
      </select>
    </form>
  );
}
