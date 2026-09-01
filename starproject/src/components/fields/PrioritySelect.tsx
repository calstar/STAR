"use client";

import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { updateField } from "@/lib/fieldUpdate";
import { PRIORITY_BADGE } from "@/lib/tasks";

const OPTS: { value: string; label: string; badge?: string }[] = [
  { value: "", label: "—" },
  { value: "low", label: "Low", badge: PRIORITY_BADGE.low },
  { value: "medium", label: "Medium", badge: PRIORITY_BADGE.medium },
  { value: "high", label: "High", badge: PRIORITY_BADGE.high },
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
    <FieldSelect
      ariaLabel="Priority"
      value={v}
      options={OPTS}
      onChange={(next) => {
        setV(next);
        updateField(taskId, "priority", next);
      }}
    />
  );
}
