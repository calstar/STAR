"use client";

import type { User } from "@prisma/client";
import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { updateField } from "@/lib/fieldUpdate";
import { displayNameOf } from "@/lib/names";

export function AssigneeSelect({
  taskId,
  value,
  users,
}: {
  taskId: string;
  value: string | null;
  users: User[];
}) {
  const [v, setV] = useState(value ?? "");
  const options = [
    { value: "", label: "Unassigned" },
    ...users.map((u) => ({ value: u.id, label: displayNameOf(u) })),
  ];
  return (
    <FieldSelect
      ariaLabel="Assignee"
      searchable
      value={v}
      options={options}
      onChange={(next) => {
        setV(next);
        updateField(taskId, "assigneeId", next);
      }}
    />
  );
}
