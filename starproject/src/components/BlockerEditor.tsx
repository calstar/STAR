"use client";

import { useActionState, useEffect, useRef, useState } from "react";

import { FieldSelect } from "@/components/fields/FieldSelect";
import { addBlockerAction, type BlockerFormState } from "@/lib/actions/blockers";

export function BlockerEditor({
  taskId,
  candidates,
  onChanged,
}: {
  taskId: string;
  candidates: { id: string; title: string }[];
  onChanged?: () => void;
}) {
  const [state, formAction, pending] = useActionState<BlockerFormState, FormData>(
    addBlockerAction,
    {},
  );
  const [blockedById, setBlockedById] = useState("");
  const [note, setNote] = useState("");

  // Fire onChanged when a submit finishes successfully (so the modal can refresh).
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      onChanged?.();
      setBlockedById(""); // clear the picker + note after a successful add
      setNote("");
    }
    wasPending.current = pending;
  }, [pending, state, onChanged]);

  return (
    <div>
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <FieldSelect
          name="blockedById"
          ariaLabel="Add a blocker"
          placeholder={candidates.length ? "Add a blocker…" : "No other tasks"}
          disabled={candidates.length === 0}
          value={blockedById}
          onChange={setBlockedById}
          options={candidates.map((c) => ({ value: c.id, label: c.title }))}
        />
        <input
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note (optional)"
          maxLength={300}
          disabled={candidates.length === 0}
          aria-label="Blocker note"
          className="min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm disabled:opacity-50 sm:min-h-0 sm:w-auto sm:min-w-40 sm:flex-1"
        />
        <button
          disabled={pending || candidates.length === 0}
          className="min-h-11 rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-50 sm:min-h-0"
        >
          Add
        </button>
      </form>
      {state.error && <p className="mt-1 text-sm text-red-600">{state.error}</p>}
    </div>
  );
}
