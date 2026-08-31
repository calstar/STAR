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

  // Fire onChanged when a submit finishes successfully (so the modal can refresh).
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) {
      onChanged?.();
      setBlockedById(""); // clear the picker after a successful add
    }
    wasPending.current = pending;
  }, [pending, state, onChanged]);

  return (
    <div>
      <form action={formAction} className="flex items-center gap-2">
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
        <button
          disabled={pending || candidates.length === 0}
          className="rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {state.error && <p className="mt-1 text-sm text-red-600">{state.error}</p>}
    </div>
  );
}
