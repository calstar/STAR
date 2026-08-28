"use client";

import { useState } from "react";

import { updateTask } from "@/lib/actions/tasks";
import { PRIORITY_BADGE } from "@/lib/tasks";

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
  const [v, setV] = useState(value);
  return (
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <select
        name="priority"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          e.currentTarget.form?.requestSubmit();
        }}
        className={`rounded border border-neutral-300 px-2 py-1 text-sm font-medium ${
          PRIORITY_BADGE[v] ?? ""
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
