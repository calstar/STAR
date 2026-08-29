"use client";

import { updateField } from "@/lib/fieldUpdate";

export function SubteamSelect({
  taskId,
  value,
  subteams,
}: {
  taskId: string;
  value: string;
  subteams: { id: string; name: string }[];
}) {
  return (
    <select
      name="subteamId"
      defaultValue={value}
      onChange={(e) => updateField(taskId, "subteamId", e.target.value)}
      className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    >
      <option value="">No subteam</option>
      {subteams.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
