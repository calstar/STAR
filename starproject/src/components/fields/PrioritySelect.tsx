"use client";

import { useState } from "react";

import { updateField } from "@/lib/fieldUpdate";
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
    <select
      name="priority"
      value={v}
      onChange={(e) => {
        setV(e.target.value);
        updateField(taskId, "priority", e.target.value);
      }}
      className={`rounded border border-neutral-300 dark:border-neutral-700 px-2 py-1 text-sm font-medium ${
        PRIORITY_BADGE[v] ?? ""
      }`}
    >
      {OPTS.map(([val, l]) => (
        <option key={val} value={val}>
          {l}
        </option>
      ))}
    </select>
  );
}
