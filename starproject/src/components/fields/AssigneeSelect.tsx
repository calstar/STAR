"use client";

import type { User } from "@prisma/client";

import { updateField } from "@/lib/fieldUpdate";
import { shortName } from "@/lib/names";

export function AssigneeSelect({
  taskId,
  value,
  users,
}: {
  taskId: string;
  value: string;
  users: User[];
}) {
  return (
    <select
      name="assigneeId"
      defaultValue={value}
      onChange={(e) => updateField(taskId, "assigneeId", e.target.value)}
      className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    >
      <option value="">Unassigned</option>
      {users.map((u) => (
        <option key={u.id} value={u.id}>
          {shortName(u.name, u.email)}
        </option>
      ))}
    </select>
  );
}
