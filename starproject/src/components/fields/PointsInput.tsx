"use client";

import { useState } from "react";

import { updateField } from "@/lib/fieldUpdate";
import { DEFAULT_TASK_POINTS } from "@/lib/leaderboard";
import { MAX_TASK_POINTS } from "@/lib/validation";

// The task's Points field for an admin: a whole number 0–1000; blank means the
// default (DEFAULT_TASK_POINTS), shown as the placeholder.
// Saves on blur or Enter when the value changed and is valid, like the other
// inline editors (updateField, no <form>).
export function PointsInput({ taskId, value }: { taskId: string; value: number | null }) {
  const [saved, setSaved] = useState(value == null ? "" : String(value));
  const [err, setErr] = useState<string | null>(null);

  const save = async (el: HTMLInputElement) => {
    const v = el.value.trim();
    if (v === saved) return;
    if (!el.validity.valid) {
      setErr(`A whole number from 0 to ${MAX_TASK_POINTS}.`);
      return;
    }
    setErr(null);
    await updateField(taskId, "points", v);
    setSaved(v);
  };

  return (
    <div>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={MAX_TASK_POINTS}
        step={1}
        defaultValue={saved}
        placeholder={`${DEFAULT_TASK_POINTS} (default)`}
        aria-label="Points"
        onBlur={(e) => save(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-28 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm tabular-nums"
      />
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
    </div>
  );
}
