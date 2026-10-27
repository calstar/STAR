"use client";

import { useRouter } from "next/navigation";
import { startTransition, useState } from "react";

import { createIncome, deleteIncome, setIncomeReceived, updateIncome } from "@/lib/actions/finance-admin";
import { formatDay } from "@/lib/finance/dates";
import { schoolYearLabel } from "@/lib/finance/ledger";
import { centsToPlain, formatCents } from "@/lib/finance/money";
import type { IncomeRow } from "@/lib/finance/overview";

const control =
  "min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm sm:min-h-0";
const button = "min-h-11 rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 sm:min-h-0";
const primary =
  "min-h-11 rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0";
const muted = "text-xs text-neutral-500 dark:text-neutral-400";

type Res = { ok: true } | { error: string; fieldErrors?: Record<string, string> };

/** Income the team plans on for the year, and what has come in. */
export function IncomePanel({ year, rows }: { year: number; rows: IncomeRow[] }) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ticked at once; the server's answer (or a rollback on error) follows.
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const isReceived = (r: IncomeRow) => pending[r.id] ?? r.received;
  const total = rows.reduce((s, r) => s + r.amountCents, 0);
  const received = rows.filter(isReceived).reduce((s, r) => s + r.amountCents, 0);

  async function toggle(r: IncomeRow) {
    setError(null);
    const next = !isReceived(r);
    setPending((p) => ({ ...p, [r.id]: next }));
    const res = await setIncomeReceived(r.id, next);
    if ("error" in res) setError(res.error);
    // In one transition, so the tick isn't dropped before the refreshed rows arrive.
    startTransition(() => {
      router.refresh();
      setPending((p) => {
        const rest = { ...p };
        delete rest[r.id];
        return rest;
      });
    });
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Planned income {schoolYearLabel(year)}</h2>
        {!adding && (
          <button className={button} onClick={() => setAdding(true)}>
            Add income
          </button>
        )}
      </div>

      {rows.length === 0 && !adding && <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">Nothing planned for this year yet.</p>}

      {rows.length > 0 && (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className={`text-left ${muted}`}>
              <th className="py-1 pr-2 font-medium">Received</th>
              <th className="py-1 pr-2 font-medium">Source</th>
              <th className="hidden py-1 pr-2 font-medium sm:table-cell">Expected</th>
              <th className="py-1 text-right font-medium">Amount</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) =>
              editing === r.id ? (
                <tr key={r.id}>
                  <td colSpan={5}>
                    <IncomeForm year={year} row={r} onDone={() => setEditing(null)} />
                  </td>
                </tr>
              ) : (
                <tr key={r.id} className="border-t border-neutral-100 align-top dark:border-neutral-800">
                  <td className="py-2 pr-2">
                    <input type="checkbox" aria-label={`${r.source} received`} checked={isReceived(r)} onChange={() => toggle(r)} className="h-4 w-4" />
                  </td>
                  <td className="py-2 pr-2">
                    <span className={isReceived(r) ? "" : "font-medium"}>{r.source}</span>
                    {r.note && <span className={`block ${muted}`}>{r.note}</span>}
                    {r.expectedOn && <span className={`block sm:hidden ${muted}`}>{formatDay(`${r.expectedOn}T12:00:00-08:00`)}</span>}
                  </td>
                  <td className="hidden whitespace-nowrap py-2 pr-2 sm:table-cell">
                    {r.expectedOn ? formatDay(`${r.expectedOn}T12:00:00-08:00`) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-2 text-right tabular-nums">{formatCents(r.amountCents)}</td>
                  <td className="py-2 pl-3 text-right">
                    <button className="text-sm text-neutral-600 underline hover:no-underline dark:text-neutral-300" onClick={() => setEditing(r.id)}>
                      Edit
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
          <tfoot>
            <tr className="border-t border-neutral-300 dark:border-neutral-700">
              <td />
              <td className="py-2 font-semibold" colSpan={1}>
                Total
                <span className={`block font-normal ${muted}`}>{formatCents(received)} received so far</span>
              </td>
              <td className="hidden sm:table-cell" />
              <td className="py-2 text-right font-semibold tabular-nums">{formatCents(total)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}

      {adding && <IncomeForm year={year} onDone={() => setAdding(false)} />}
    </div>
  );
}

function IncomeForm({ year, row, onDone }: { year: number; row?: IncomeRow; onDone: () => void }) {
  const router = useRouter();
  const [source, setSource] = useState(row?.source ?? "");
  const [amount, setAmount] = useState(row ? centsToPlain(row.amountCents) : "");
  const [expectedOn, setExpectedOn] = useState(row?.expectedOn ?? "");
  const [note, setNote] = useState(row?.note ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<Res>) {
    setBusy(true);
    setError(null);
    const res = await action();
    setBusy(false);
    if ("error" in res) {
      setError(res.error);
      setErrors(res.fieldErrors ?? {});
      return;
    }
    onDone();
    router.refresh();
  }

  const input = { schoolYear: year, source, amount, expectedOn, note, received: row?.received ?? false };
  return (
    <form
      className="my-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => (row ? updateIncome(row.id, input) : createIncome(input)));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-6">
        <label className="block sm:col-span-3">
          <span className={muted}>Source</span>
          <input className={`${control} mt-1`} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Dues, sponsor, ASUC grant, …" autoFocus />
          {errors.source && <span className="mt-1 block text-xs text-red-600">{errors.source}</span>}
        </label>
        <label className="block sm:col-span-1">
          <span className={muted}>Amount</span>
          <input className={`${control} mt-1 tabular-nums`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          {errors.amount && <span className="mt-1 block text-xs text-red-600">{errors.amount}</span>}
        </label>
        <label className="block sm:col-span-2">
          <span className={muted}>Expected (optional)</span>
          <input type="date" className={`${control} mt-1`} value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
          {errors.expectedOn && <span className="mt-1 block text-xs text-red-600">{errors.expectedOn}</span>}
        </label>
        <label className="block sm:col-span-6">
          <span className={muted}>Note (optional)</span>
          <input className={`${control} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className={primary} disabled={busy}>
          {row ? "Save" : "Add income"}
        </button>
        <button type="button" className={button} onClick={onDone}>
          Cancel
        </button>
        {row && (
          <button
            type="button"
            className="ml-auto text-sm text-red-600 hover:underline"
            disabled={busy}
            onClick={() => {
              if (confirm(`Delete “${row.source}”?`)) run(() => deleteIncome(row.id));
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
