"use client";

import { RichTextEditor } from "@/components/fields/RichTextEditor";

export function DescriptionInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <RichTextEditor
      taskId={taskId}
      field="description"
      value={value}
      placeholder="Add a description…"
    />
  );
}
