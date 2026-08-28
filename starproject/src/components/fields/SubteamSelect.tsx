"use client";

import { updateTask } from "@/lib/actions/tasks";

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
    <form action={updateTask}>
      <input type="hidden" name="id" value={taskId} />
      <select
        name="subteamId"
        defaultValue={value}
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
        className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
      >
        <option value="">No subteam</option>
        {subteams.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    </form>
  );
}
