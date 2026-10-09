"use client";

import { useState, useTransition } from "react";

import {
  approveReimbursement,
  cancelReimbursement,
  rejectReimbursement,
  resolveNeedsCheck,
  retryReimbursement,
} from "@/lib/actions/finance";
import type { FinanceDetail } from "@/lib/finance/queries";

const btn = "min-h-11 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 sm:min-h-0";
const primary = `${btn} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`;
const secondary = `${btn} border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800`;
const danger = `${btn} border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-300 dark:hover:bg-red-950`;

/** Approve / reject / retry / cancel, as the viewer is allowed (the server checks again). */
export function ReimbursementActions({ data, onChanged }: { data: FinanceDetail; onChanged: () => void }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");
  const { can } = data;

  const run = (fn: () => Promise<{ ok: true } | { error: string }>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if ("error" in res) setError(res.error);
      else {
        setRejecting(false);
        onChanged();
      }
    });

  if (!can.approve && !can.reject && !can.retry && !can.cancel && !can.resolve) return null;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-2">
        {can.approve && (
          <button className={primary} disabled={pending} onClick={() => run(() => approveReimbursement(data.id))}>
            Approve and queue for CalLink
          </button>
        )}
        {can.reject && !rejecting && (
          <button className={danger} disabled={pending} onClick={() => setRejecting(true)}>
            Reject…
          </button>
        )}
        {can.retry && (
          <button className={primary} disabled={pending} onClick={() => run(() => retryReimbursement(data.id))}>
            Retry filing
          </button>
        )}
        {can.resolve && (
          <>
            <button className={secondary} disabled={pending} onClick={() => run(() => resolveNeedsCheck(data.id, true))}>
              It&apos;s on CalLink
            </button>
            <button className={secondary} disabled={pending} onClick={() => run(() => resolveNeedsCheck(data.id, false))}>
              Not on CalLink: queue again
            </button>
          </>
        )}
        {can.cancel && (
          <button
            className={secondary}
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Cancel R-${data.number}? It won't be filed.`)) run(() => cancelReimbursement(data.id));
            }}
          >
            Cancel request
          </button>
        )}
      </div>
      {rejecting && (
        <div className="mt-3 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400">
            Why? The member sees this.
            <textarea
              className="mt-1 block w-full rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              autoFocus
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button className={danger} disabled={pending || !note.trim()} onClick={() => run(() => rejectReimbursement(data.id, note))}>
              Reject
            </button>
            <button className={secondary} disabled={pending} onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
      {data.status === "pending_approval" && can.approve && (
        <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
          Approving queues it; the worker then files it on CalLink under STAR&apos;s MISC-STAR account.
        </p>
      )}
    </div>
  );
}
