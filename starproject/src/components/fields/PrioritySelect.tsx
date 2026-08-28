"use client";

import { updateTask } from "@/lib/actions/tasks";

const OPTS: [string, string][] = [
  ["", "—"],
  ["low", "Low"],
  ["medium", "Medium"],
  ["high", "High"],
];

export function PrioritySelect({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <select
        name="priority"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-sm"
      >
        {OPTS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </form>
  );
}
