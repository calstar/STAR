"use client";

import { RichTextEditor } from "@/components/fields/RichTextEditor";

/** Free-text "why is this blocked" comment. Same markdown editor as the
 * description — auto-saves on blur, no explicit save button. */
export function BlockedNoteInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <RichTextEditor
      taskId={taskId}
      field="blockedNote"
      value={value}
      placeholder="Why is this blocked?…"
    />
  );
}
