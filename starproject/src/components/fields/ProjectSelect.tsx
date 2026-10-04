"use client";

import { useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { updateField } from "@/lib/fieldUpdate";

/** Move a task to another project or subproject. `onMoved` fires once the move
 * is saved, so the caller can re-open the task under its new project. */
export function ProjectSelect({
  taskId,
  value,
  projects,
  onMoved,
}: {
  taskId: string;
  value: string;
  projects: { id: string; label: string }[];
  onMoved: (projectId: string) => void;
}) {
  const [v, setV] = useState(value);
  return (
    <FieldSelect
      ariaLabel="Project"
      searchable
      value={v}
      options={projects.map((p) => ({ value: p.id, label: p.label }))}
      onChange={async (next) => {
        if (next === v) return;
        setV(next);
        await updateField(taskId, "projectId", next);
        onMoved(next);
      }}
    />
  );
}
