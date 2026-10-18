"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Modal } from "@/components/Modal";
import { budgetOptions } from "@/lib/actions/budget";
import { createPurchaseRequest } from "@/lib/actions/purchase-requests";
import { type BomLine, predictedCents } from "@/lib/bom";
import type { getBudgetOptions } from "@/lib/finance/budget-data";
import { schoolYearLabel } from "@/lib/finance/ledger";
import { formatCents } from "@/lib/finance/money";
import { MAX_NOTE } from "@/lib/purchase-requests";

type Options = Awaited<ReturnType<typeof getBudgetOptions>>;

const fieldLabel = "text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400";
const control = "mt-1 w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900";

/** Ask a PVP to approve buying the lines ticked in the sheet: whose budget line it
 * spends, and an optional note. */
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
  const [options, setOptions] = useState<Options | null>(null);
  const [subteamId, setSubteamId] = useState("");
  const [budgetLineId, setBudgetLineId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const total = lines.reduce((n, l) => n + predictedCents(l), 0);

  useEffect(() => {
    budgetOptions().then(setOptions, () => setError("Couldn't load the budgets; close this and try again."));
  }, []);

  const subteam = options?.subteams.find((s) => s.id === subteamId);
  const budgetLine = subteam?.lines.find((l) => l.id === budgetLineId);
  const over = budgetLine ? total - budgetLine.remainingCents : 0;

  async function submit() {
    setBusy(true);
    try {
      const res = await createPurchaseRequest(
        projectId,
        lines.map((l) => l.id),
        note,
        { subteamId, budgetLineId },
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
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={fieldLabel}>Subteam</span>
            <select
              className={control}
              value={subteamId}
              disabled={!options}
              onChange={(e) => {
                setSubteamId(e.target.value);
                setBudgetLineId("");
              }}
            >
              <option value="">{options ? "Pick a subteam" : "Loading…"}</option>
              {options?.subteams.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={fieldLabel}>Budget line{options ? ` (${schoolYearLabel(options.year)})` : ""}</span>
            <select
              className={control}
              value={budgetLineId}
              disabled={!subteam || subteam.lines.length === 0}
              onChange={(e) => setBudgetLineId(e.target.value)}
            >
              <option value="">{!subteam ? "Pick a subteam first" : subteam.lines.length ? "Pick a line" : "No lines yet"}</option>
              {subteam?.lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                  {l.projectLabel ? ` · ${l.projectLabel}` : ""} · {formatCents(l.remainingCents)} left
                </option>
              ))}
            </select>
          </label>
        </div>
        {subteam && subteam.lines.length === 0 && (
          <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-300">
            {subteam.name} has no budget for {schoolYearLabel(options!.year)} yet.{" "}
            <Link href={`/subteams/${subteam.id}/budget`} className="text-blue-600 hover:underline dark:text-blue-400">
              Add its budget lines
            </Link>{" "}
            first.
          </p>
        )}
        {budgetLine && (
          <p className={`mt-2 text-sm ${over > 0 ? "text-amber-700 dark:text-amber-400" : "text-neutral-500 dark:text-neutral-400"}`}>
            {formatCents(budgetLine.remainingCents)} of {formatCents(budgetLine.plannedCents)} left on this line
            {budgetLine.pendingCents ? `, ${formatCents(budgetLine.pendingCents)} more waiting on a PVP` : ""}.
            {over > 0 && ` This request would take it ${formatCents(over)} over.`}
          </p>
        )}
        <label className="mt-4 block">
          <span className={fieldLabel}>Note for the PVP (optional)</span>
          <textarea
            rows={3}
            value={note}
            maxLength={MAX_NOTE}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What it's for, when it's needed, any alternatives"
            className={control}
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
            disabled={busy || lines.length === 0 || !budgetLine}
            className="min-h-11 rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 sm:min-h-0"
          >
            {busy ? "Sending…" : `Request ${lines.length} line${lines.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
