"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createAccount, deleteAccount, updateAccount } from "@/lib/actions/finance-admin";
import { formatWhen } from "@/lib/finance/dates";
import { centsToPlain, formatCents } from "@/lib/finance/money";
import type { AccountRow } from "@/lib/finance/overview";

const control =
  "min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm sm:min-h-0";
const button = "min-h-11 rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800 sm:min-h-0";
const primary =
  "min-h-11 rounded bg-neutral-900 px-3 py-1 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0";
const muted = "text-xs text-neutral-500 dark:text-neutral-400";

const plain = (cents: number) => (cents < 0 ? `-${centsToPlain(-cents)}` : centsToPlain(cents));

/** CalLink's balances (read-only, from the worker) and the accounts admins keep by hand. */
export function AccountsPanel({ summary, callink, manual }: { summary: AccountRow | null; callink: AccountRow[]; manual: AccountRow[] }) {
  const [adding, setAdding] = useState(false);
  const [showSub, setShowSub] = useState(false);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Accounts</h2>
        {!adding && (
          <button className={button} onClick={() => setAdding(true)}>
            Add account
          </button>
        )}
      </div>

      <ul className="mt-3 divide-y divide-neutral-100 dark:divide-neutral-800">
        <li className="py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium">STAR on CalLink</p>
              <p className={muted}>
                {summary
                  ? `${summary.name} · read from CalLink ${formatWhen(summary.balanceAsOf)}`
                  : "The CalLink worker reports this hourly; nothing has arrived yet."}
              </p>
            </div>
            <p className="text-lg font-semibold tabular-nums">{summary ? formatCents(summary.balanceCents) : "—"}</p>
          </div>
          {callink.length > 0 && (
            <>
              <button className="mt-1 text-xs text-neutral-500 underline hover:no-underline dark:text-neutral-400" onClick={() => setShowSub((v) => !v)}>
                {showSub ? "Hide" : "Show"} CalLink&apos;s {callink.length} sub-account{callink.length === 1 ? "" : "s"}
              </button>
              {showSub && (
                <ul className="mt-2 space-y-1 border-l border-neutral-200 pl-3 dark:border-neutral-800">
                  {callink.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <span className="min-w-0 break-words">
                        {a.name}
                        <span className={`ml-2 ${muted}`}>{formatWhen(a.balanceAsOf)}</span>
                      </span>
                      <span className="tabular-nums">
                        {formatCents(a.balanceCents)}
                        {a.availableCents != null && a.availableCents !== a.balanceCents && (
                          <span className={`ml-2 ${muted}`}>{formatCents(a.availableCents)} available</span>
                        )}
                      </span>
                    </li>
                  ))}
                  <li className={muted}>Already included in the STAR total above.</li>
                </ul>
              )}
            </>
          )}
        </li>
        {manual.map((a) => (
          <ManualAccount key={a.id} account={a} />
        ))}
      </ul>

      {adding && <AccountForm onDone={() => setAdding(false)} />}
    </div>
  );
}

function ManualAccount({ account: a }: { account: AccountRow }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li className="py-2">
        <AccountForm account={a} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-2">
      <div className="min-w-0">
        <p className="font-medium">{a.name}</p>
        <p className={muted}>
          Entered by hand {formatWhen(a.balanceAsOf)}
          {a.updatedBy && ` by ${a.updatedBy}`}
        </p>
        {a.note && <p className="text-xs text-neutral-600 dark:text-neutral-300">{a.note}</p>}
      </div>
      <div className="flex items-baseline gap-3">
        <p className="text-lg font-semibold tabular-nums">{formatCents(a.balanceCents)}</p>
        <button className="text-sm text-neutral-600 underline hover:no-underline dark:text-neutral-300" onClick={() => setEditing(true)}>
          Update
        </button>
      </div>
    </li>
  );
}

function AccountForm({ account, onDone }: { account?: AccountRow; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(account?.name ?? "");
  const [balance, setBalance] = useState(account ? plain(account.balanceCents) : "");
  const [note, setNote] = useState(account?.note ?? "");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<{ ok: true } | { error: string; fieldErrors?: Record<string, string> }>) {
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

  const input = { name, balance, note };
  return (
    <form
      className="mt-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => (account ? updateAccount(account.id, input) : createAccount(input)));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-6">
        <label className="block sm:col-span-3">
          <span className={muted}>Account</span>
          <input className={`${control} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Sponsor fund, Venmo, …" autoFocus />
          {errors.name && <span className="mt-1 block text-xs text-red-600">{errors.name}</span>}
        </label>
        <label className="block sm:col-span-3">
          <span className={muted}>Balance today</span>
          <input
            className={`${control} mt-1 tabular-nums`}
            inputMode="decimal"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="0.00"
          />
          {errors.balance && <span className="mt-1 block text-xs text-red-600">{errors.balance}</span>}
        </label>
        <label className="block sm:col-span-6">
          <span className={muted}>Note (optional)</span>
          <input className={`${control} mt-1`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Where it is, who can spend it" />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className={primary} disabled={busy}>
          {account ? "Save" : "Add account"}
        </button>
        <button type="button" className={button} onClick={onDone}>
          Cancel
        </button>
        {account && (
          <button
            type="button"
            className="ml-auto text-sm text-red-600 hover:underline"
            disabled={busy}
            onClick={() => {
              if (confirm(`Delete “${account.name}”? Its balance stops counting toward the total.`)) run(() => deleteAccount(account.id));
            }}
          >
            Delete
          </button>
        )}
      </div>
    </form>
  );
}
