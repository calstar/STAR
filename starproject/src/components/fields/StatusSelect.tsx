"use client";

import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { updateField } from "@/lib/fieldUpdate";
import { STATUS_BADGE } from "@/lib/tasks";

const OPTS: { value: string; label: string; badge: string }[] = [
  { value: "backlog", label: "Backlog", badge: STATUS_BADGE.backlog },
  { value: "todo", label: "To do", badge: STATUS_BADGE.todo },
  { value: "in_progress", label: "In progress", badge: STATUS_BADGE.in_progress },
  { value: "done", label: "Done", badge: STATUS_BADGE.done },
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
    <FieldSelect
      ariaLabel="Status"
      value={v}
      options={OPTS}
      onChange={(next) => {
        setV(next);
        updateField(taskId, "status", next);
      }}
    />
  );
}
