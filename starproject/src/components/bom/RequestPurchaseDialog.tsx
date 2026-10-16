"use client";

import { useState } from "react";

import { Modal } from "@/components/Modal";
import { createPurchaseRequest } from "@/lib/actions/purchase-requests";
import { type BomLine, predictedCents } from "@/lib/bom";
import { formatCents } from "@/lib/finance/money";
import { MAX_NOTE } from "@/lib/purchase-requests";

/** Ask a PVP to approve buying the lines ticked in the sheet, with an optional note. */
export function RequestPurchaseDialog({
  projectId,
  lines,
  onClose,
  onRequested,
}: {
  projectId: string;
  lines: BomLine[];
  onClose: () => void;
  onRequested: (number: number) => void;
}) {
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((n, l) => n + predictedCents(l), 0);

  async function submit() {
    setBusy(true);
    try {
      const res = await createPurchaseRequest(
        projectId,
        lines.map((l) => l.id),
        note,
      );
      if (res.error || !res.number) setError(res.error ?? "Couldn't make the request.");
      else onRequested(res.number);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <div className="overflow-y-auto p-5 sm:p-6">
        <h2 className="pr-12 text-lg font-semibold">Request purchase</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          A PVP reviews it on the Purchase Requests page. Approving it marks these lines Approved.
        </p>
        <ul className="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 text-sm dark:divide-neutral-800 dark:border-neutral-800">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-3 px-3 py-2">
              <span className="min-w-0 truncate">{l.name}</span>
              <span className="tabular-nums">{formatCents(predictedCents(l))}</span>
            </li>
          ))}
          <li className="flex justify-between px-3 py-2 font-semibold">
            <span>Total (predicted)</span>
            <span className="tabular-nums">{formatCents(total)}</span>
          </li>
        </ul>
        <label className="mt-4 block">
          <span className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
            Note for the PVP (optional)
          </span>
          <textarea
            rows={3}
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What it's for, when it's needed, any alternatives"
            className="mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="min-h-11 rounded px-3 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 sm:min-h-0"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || lines.length === 0}
            className="min-h-11 rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 sm:min-h-0"
          >
            {busy ? "Sending…" : `Request ${lines.length} line${lines.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
