"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ReimbursementActions } from "@/components/finance/ReimbursementActions";
import { ReimbursementDetail } from "@/components/finance/ReimbursementDetail";
import { ReimbursementTable } from "@/components/finance/ReimbursementTable";
import type { TagOptions } from "@/components/finance/ReimbursementTags";
import { Modal } from "@/components/Modal";
import { bulkSetReimbursementStatus, loadReimbursement } from "@/lib/actions/finance";
import { BULK_ACTIONS, BULK_LABEL, bulkApplies, type BulkAction } from "@/lib/finance/bulk";
import type { FinanceDetail, FinanceRow } from "@/lib/finance/queries";

const chip = (active: boolean) =>
  `min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 py-0.5 text-sm sm:min-h-0 sm:shrink sm:px-2.5 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
  }`;

/** The Reimbursements tab: filters, the reimbursement table, and the detail card
 * (opened in place, or from a `?r=<number>` share link). */
export function FinanceWorkspace({
  rows,
  viewer,
  tagOptions,
}: {
  rows: FinanceRow[];
  viewer: { isAdmin: boolean; isPvp: boolean };
  tagOptions: TagOptions;
}) {
  const admin = viewer.isAdmin || viewer.isPvp;
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [mine, setMine] = useState(false);
  const [review, setReview] = useState(false);

  const [open, setOpen] = useState<number | null>(null);
  const [data, setData] = useState<FinanceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumps to re-fetch the open reimbursement after an action in the card.
  const [nonce, setNonce] = useState(0);
  const reqId = useRef(0);

  const statuses = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) seen.set(r.status.key, r.status.label);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);
  const reviewCount = useMemo(() => rows.filter((r) => r.needsAdmin).length, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (status && r.status.key !== status) return false;
      if (mine && !r.mine) return false;
      if (review && !r.needsAdmin) return false;
      if (q) {
        const hay = `R-${r.number} ${r.subject} ${r.payeeName} ${r.submitterName ?? ""} ${r.vendors} ${r.callinkRequestNumber ?? ""}`;
        if (!hay.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, status, mine, review]);

  // Only rows still shown count, so a filter change never acts on hidden ones.
  const picked = useMemo(() => filtered.filter((r) => selected.has(r.id)), [filtered, selected]);

  const openRow = useCallback((n: number) => {
    setData(null);
    setOpen(n);
  }, []);

  const close = useCallback(() => {
    setOpen(null);
    setData(null);
    const url = new URL(window.location.href);
    if (url.searchParams.has("r")) {
      url.searchParams.delete("r");
      router.replace(url.pathname + url.search + url.hash);
    }
  }, [router]);

  // A `?r=<number>` share link opens that reimbursement.
  useEffect(() => {
    const n = Number(new URLSearchParams(window.location.search).get("r"));
    if (Number.isInteger(n) && n > 0) setOpen(n);
  }, []);

  useEffect(() => {
    if (open == null) return;
    const id = ++reqId.current;
    setLoading(true);
    loadReimbursement(open).then((d) => {
      if (id !== reqId.current) return;
      setData(d);
      setLoading(false);
    });
  }, [open, nonce]);

  // Keep the table current after anything done in the card.
  useEffect(() => {
    if (open == null) router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div>
      <div className="flex flex-col gap-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subject, payee, vendor, CalLink #…"
            className="min-h-11 w-full rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1.5 text-sm sm:min-h-0 sm:w-auto sm:min-w-48 sm:flex-1"
          />
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Status"
            className="min-h-11 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-1.5 text-sm sm:min-h-0"
          >
            <option value="">All statuses</option>
            {statuses.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setMine((v) => !v)} className={chip(mine)}>
              Mine
            </button>
            {admin && (
              <button onClick={() => setReview((v) => !v)} className={chip(review)}>
                Needs review{reviewCount ? ` (${reviewCount})` : ""}
              </button>
            )}
          </div>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {filtered.length} of {rows.length}
        </p>
      </div>

      {admin && picked.length > 0 && (
        <BulkBar
          rows={picked}
          viewer={viewer}
          onDone={() => {
            setSelected(new Set());
            router.refresh();
          }}
          onClear={() => setSelected(new Set())}
        />
      )}

      <div className="mt-4">
        <ReimbursementTable rows={filtered} onOpen={openRow} selection={admin ? { selected, onChange: setSelected } : undefined} />
      </div>

      {open != null && (
        <Modal onClose={close}>
          {data ? (
            <ReimbursementDetail
              key={data.id}
              data={data}
              tagOptions={tagOptions}
              actions={
                <ReimbursementActions
                  data={data}
                  onChanged={() => {
                    setNonce((n) => n + 1);
                    router.refresh();
                  }}
                />
              }
            />
          ) : (
            <div className="py-16 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {loading ? "Loading…" : "Reimbursement not found."}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

const bulkBtn = "min-h-11 rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 sm:min-h-0";
const bulkField =
  "min-h-11 rounded border border-blue-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-blue-800 dark:bg-neutral-900 dark:text-neutral-100 sm:min-h-0";

/**
 * Set one status on every selected reimbursement. Only the changes that apply
 * to at least one of them are offered, with how many each would move; rows it
 * doesn't apply to are left alone, and the server checks each one again.
 */
function BulkBar({
  rows,
  viewer,
  onDone,
  onClear,
}: {
  rows: FinanceRow[];
  viewer: { isAdmin: boolean; isPvp: boolean };
  onDone: () => void;
  onClear: () => void;
}) {
  const [action, setAction] = useState<BulkAction | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const options = BULK_ACTIONS.map((a) => ({ a, n: rows.filter((r) => bulkApplies(a, r.rawStatus, viewer)).length })).filter(
    (o) => o.n > 0,
  );
  const chosen = options.find((o) => o.a === action);
  const targets = chosen ? rows.filter((r) => bulkApplies(chosen.a, r.rawStatus, viewer)) : [];

  async function apply() {
    if (!chosen) return;
    const extra = chosen.a === "send" ? " The worker files them on CalLink under MISC-STAR." : "";
    if (!window.confirm(`${BULK_LABEL[chosen.a]}: ${targets.map((r) => `R-${r.number}`).join(", ")}?${extra}`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await bulkSetReimbursementStatus(
        targets.map((r) => r.id),
        chosen.a,
        chosen.a === "reject" ? note : undefined,
      );
      if ("error" in res) setMessage(res.error);
      else if (res.failed.length) {
        setMessage(`${res.done} done; ${res.failed.map((f) => `R-${f.number}: ${f.error}`).join("; ")}`);
        if (res.done) onDone();
      } else onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticky top-2 z-10 mt-4 flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-sm dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{rows.length} selected</span>
        {options.length === 0 ? (
          <span className="text-blue-800 dark:text-blue-300">No status change applies to these.</span>
        ) : (
          <>
            <select
              aria-label="Set status"
              value={action}
              onChange={(e) => setAction(e.target.value as BulkAction | "")}
              className={bulkField}
            >
              <option value="">Set status…</option>
              {options.map((o) => (
                <option key={o.a} value={o.a}>
                  {BULK_LABEL[o.a]} ({o.n === rows.length ? "all" : `${o.n} of ${rows.length}`})
                </option>
              ))}
            </select>
            {chosen?.a === "reject" && (
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why? Each member sees this."
                aria-label="Reason for rejecting"
                className={`${bulkField} min-w-48 flex-1 px-3`}
              />
            )}
            <button
              type="button"
              disabled={busy || !chosen || (chosen.a === "reject" && !note.trim())}
              onClick={apply}
              className={`${bulkBtn} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`}
            >
              {busy ? "Working…" : chosen ? `${BULK_LABEL[chosen.a]} ${targets.length}` : "Apply"}
            </button>
          </>
        )}
        <button type="button" onClick={onClear} className={`${bulkBtn} ml-auto hover:bg-blue-100 dark:hover:bg-blue-900`}>
          Clear
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}

export function NewReimbursementButton() {
  return (
    <Link
      href="/reimbursements/new"
      className="inline-flex min-h-11 items-center rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0"
    >
      New reimbursement
    </Link>
  );
}
