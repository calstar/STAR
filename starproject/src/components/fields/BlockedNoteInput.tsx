"use client";

import { updateField } from "@/lib/fieldUpdate";

/** Free-text "why is this blocked" comment. Auto-saves on blur, like the
 * description field — no explicit save button. */
export function BlockedNoteInput({
  taskId,
  value,
}: {
  taskId: string;
  value: string;
}) {
  return (
    <textarea
      name="blockedNote"
      defaultValue={value}
      onBlur={(e) => updateField(taskId, "blockedNote", e.target.value)}
      rows={2}
      placeholder="Why is this blocked?…"
      className="w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
    />
  );
}
