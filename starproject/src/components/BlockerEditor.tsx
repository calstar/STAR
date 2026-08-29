"use client";

import { useActionState } from "react";

import { addBlockerAction, type BlockerFormState } from "@/lib/actions/blockers";

export function BlockerEditor({
  taskId,
  candidates,
}: {
  taskId: string;
  candidates: { id: string; title: string }[];
}) {
  const [state, formAction, pending] = useActionState<BlockerFormState, FormData>(
    addBlockerAction,
    {},
  );

  return (
    <div>
      <form action={formAction} className="flex items-center gap-2">
        <input type="hidden" name="taskId" value={taskId} />
        <select
          name="blockedById"
          defaultValue=""
          required
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1 text-sm"
        >
          <option value="" disabled>
            {candidates.length ? "Add a blocker…" : "No other tasks"}
          </option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
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
