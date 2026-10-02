"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ReimbursementActions } from "@/components/finance/ReimbursementActions";
import { ReimbursementDetail } from "@/components/finance/ReimbursementDetail";
import { ReimbursementTable } from "@/components/finance/ReimbursementTable";
import { Modal } from "@/components/Modal";
import { loadReimbursement } from "@/lib/actions/finance";
import { formatCents } from "@/lib/finance/money";
import type { FinanceDetail, FinanceRow } from "@/lib/finance/queries";

const chip = (active: boolean) =>
  `min-h-11 shrink-0 whitespace-nowrap rounded-full border px-3 py-0.5 text-sm sm:min-h-0 sm:shrink sm:px-2.5 ${
    active
      ? "border-neutral-900 bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
      : "border-neutral-300 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800"
  }`;

/** The Finance tab: filters, the reimbursement table, and the detail card
 * (opened in place, or from a `?r=<number>` share link). */
export function FinanceWorkspace({ rows, admin }: { rows: FinanceRow[]; admin: boolean }) {
  const router = useRouter();
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
  const total = useMemo(() => filtered.reduce((s, r) => s + r.amountCents, 0), [filtered]);

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
          {filtered.length} of {rows.length} · {formatCents(total)}
        </p>
      </div>

      <div className="mt-4">
        <ReimbursementTable rows={filtered} onOpen={openRow} />
      </div>

      {open != null && (
        <Modal onClose={close}>
          {data ? (
            <ReimbursementDetail
              data={data}
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

export function NewReimbursementButton() {
  return (
    <Link
      href="/finance/new"
      className="inline-flex min-h-11 items-center rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 sm:min-h-0"
    >
      New reimbursement
    </Link>
  );
}
