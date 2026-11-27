"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { STATUS_PILL } from "@/components/bom/shared";
import {
  approvePurchaseRequest,
  bulkDecidePurchaseRequests,
  cancelPurchaseRequest,
  rejectPurchaseRequest,
  type PrBulkAction,
} from "@/lib/actions/purchase-requests";
import { BOM_STATUS_LABEL, linkHost } from "@/lib/bom";
import { formatWhen } from "@/lib/finance/dates";
import { formatCents } from "@/lib/finance/money";
import type { PurchaseRequestView } from "@/lib/purchase-request-data";
import { PR_STATUS_LABEL, type PrStatus, canCancel, canDecide } from "@/lib/purchase-requests";

const FILTERS: { key: PrStatus | "all"; label: string }[] = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "cancelled", label: "Cancelled" },
  { key: "all", label: "All" },
];

const PILL: Record<PrStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  approved: "bg-green-100 text-green-800 dark:bg-green-400/15 dark:text-green-300",
  rejected: "bg-red-100 text-red-700 dark:bg-red-400/15 dark:text-red-300",
  cancelled: "bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
};

// The list's columns, shared by the header row and every request's summary row
// so they line up. Below `sm` each request stacks instead. The select checkbox
// sits in its own column outside this grid (a checkbox can't go inside the
// row's button).
const ROW =
  "sm:grid sm:grid-cols-[1rem_4.5rem_6.5rem_minmax(0,1fr)_minmax(0,10rem)_9rem_9rem_3rem_7rem] sm:items-center sm:gap-3";
const SELECT_COL = "flex w-10 shrink-0 items-start justify-center pt-[1.15rem] sm:items-center sm:pt-0";

const btn =
  "inline-flex min-h-11 items-center rounded px-3 py-1 text-sm font-medium disabled:opacity-50 sm:min-h-0";

/** The Purchase Requests list: filter tabs, search, one card per request. */
export function PurchaseRequestsWorkspace({
  requests,
  viewerId,
  pvp,
  openNumber,
}: {
  requests: PurchaseRequestView[];
  viewerId: string;
  pvp: boolean;
  openNumber: number | null;
}) {
  const linked = openNumber !== null ? requests.find((r) => r.number === openNumber) : undefined;
  const [filter, setFilter] = useState<PrStatus | "all">(linked ? "all" : "pending");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const who = { userId: viewerId, pvp };
  const actionable = (r: PurchaseRequestView) => {
    const d = { status: r.status, createdById: r.createdBy.id };
    return canDecide(d, who) || canCancel(d, who);
  };
  const counts = Object.fromEntries(FILTERS.map((f) => [f.key, f.key === "all" ? requests.length : requests.filter((r) => r.status === f.key).length]));
  const needle = q.trim().toLowerCase();
  const shown = requests.filter(
    (r) =>
      (filter === "all" || r.status === filter) &&
      (!needle ||
        [`pr-${r.number}`, r.project.name, r.subteam?.name ?? "", r.budgetLine?.name ?? "", r.createdBy.name, r.note ?? "", ...r.items.map((i) => i.name)].some((v) =>
          v.toLowerCase().includes(needle),
        )),
  );
  // Only what is still shown and still open to a decision counts.
  const selectable = shown.filter(actionable);
  const picked = selectable.filter((r) => selected.has(r.id));
  const allPicked = selectable.length > 0 && picked.length === selectable.length;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <select
          aria-label="Filter by status"
          value={filter}
          onChange={(e) => setFilter(e.target.value as PrStatus | "all")}
          className="min-h-11 rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0"
        >
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.key === "all" ? "All statuses" : f.label} ({counts[f.key]})
            </option>
          ))}
        </select>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search PR number, project, person, part…"
          className="min-h-11 w-full rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:ml-auto sm:min-h-0 sm:w-72"
        />
      </div>

      {picked.length > 0 && (
        <BulkBar
          requests={picked}
          viewerId={viewerId}
          pvp={pvp}
          onDone={() => setSelected(new Set())}
          onClear={() => setSelected(new Set())}
        />
      )}

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          {requests.length === 0
            ? "No purchase requests yet. Tick lines on a project's BOM tab and press Request purchase."
            : "Nothing here."}
        </p>
      ) : (
        <>
          <div className="hidden items-center text-xs font-medium text-neutral-500 dark:text-neutral-400 sm:flex">
            <span className={SELECT_COL}>
              {selectable.length > 0 && (
                <input
                  type="checkbox"
                  aria-label="Select every request shown that you can decide or cancel"
                  checked={allPicked}
                  ref={(el) => {
                    if (el) el.indeterminate = picked.length > 0 && !allPicked;
                  }}
                  onChange={() => setSelected(allPicked ? new Set() : new Set(selectable.map((r) => r.id)))}
                  className="h-4 w-4"
                />
              )}
            </span>
            <div className={`flex-1 pr-4 ${ROW}`}>
              <span />
              <span>PR</span>
              <span>Status</span>
              <span>Project</span>
              <span>Subteam</span>
              <span>Requested by</span>
              <span>Created</span>
              <span className="text-right">Lines</span>
              <span className="text-right">Total</span>
            </div>
          </div>
          {shown.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              viewerId={viewerId}
              pvp={pvp}
              startOpen={r.number === openNumber || shown.length === 1}
              selection={actionable(r) ? { checked: selected.has(r.id), onToggle: () => toggle(r.id) } : null}
            />
          ))}
        </>
      )}
    </div>
  );
}

function RequestCard({
  request: r,
  viewerId,
  pvp,
  startOpen,
  selection,
}: {
  request: PurchaseRequestView;
  viewerId: string;
  pvp: boolean;
  startOpen: boolean;
  /** Null when this viewer can't decide or cancel it, so it can't be picked. */
  selection: { checked: boolean; onToggle: () => void } | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const who = { userId: viewerId, pvp };
  const decidable = canDecide({ status: r.status, createdById: r.createdBy.id }, who);
  const cancellable = canCancel({ status: r.status, createdById: r.createdBy.id }, who);
  const changed = r.items.filter((i) => i.changed).length;
  // Which lines the PVP is approving: all to start with, untick to leave some out.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(r.items.map((i) => i.id)));
  const pickedItems = r.items.filter((i) => picked.has(i.id));
  const pickedCents = pickedItems.reduce((n, i) => n + i.predictedCents, 0);
  const allPicked = pickedItems.length === r.items.length;
  const togglePick = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const partial = r.status === "approved" && r.approvedCount < r.items.length;

  async function run(fn: () => Promise<{ error?: string }>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      if (res.error) setError(res.error);
      else {
        setRejecting(false);
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      id={`pr-${r.number}`}
      className={`rounded-lg border bg-white dark:bg-neutral-900 ${
        selection?.checked ? "border-blue-400 dark:border-blue-700" : "border-neutral-200 dark:border-neutral-800"
      }`}
    >
      <div className="flex">
        <span className={SELECT_COL}>
          {selection && (
            <input type="checkbox" aria-label={`Select PR-${r.number}`} checked={selection.checked} onChange={selection.onToggle} className="h-4 w-4" />
          )}
        </span>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-4 pr-4 text-left text-sm ${ROW}`}
        >
          <span className="text-neutral-400">{open ? "▾" : "▸"}</span>
          <span className="text-base font-semibold">PR-{r.number}</span>
          {/* Pending needs no badge: the Pending tab says it, and the buttons do. */}
          <span>
            {r.status !== "pending" && (
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PILL[r.status]}`}>{PR_STATUS_LABEL[r.status]}</span>
            )}
          </span>
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: r.project.color ?? "#a3a3a3" }} />
              <span className="truncate">{r.project.name}</span>
            </span>
          </span>
          {/* Whose budget it spends; requests from before budgets have none. */}
          <span className="min-w-0" title={r.subteam ? "Subteam · budget line" : undefined}>
            {r.subteam ? (
              <>
                <span className="block truncate">{r.subteam.name}</span>
                {r.budgetLine && <span className="block truncate text-xs text-neutral-500 dark:text-neutral-400">{r.budgetLine.name}</span>}
              </>
            ) : (
              <span className="text-neutral-400 dark:text-neutral-500">No subteam</span>
            )}
          </span>
          <span className="truncate font-medium">{r.createdBy.name}</span>
          <span className="text-neutral-500 dark:text-neutral-400">{formatWhen(r.createdAt)}</span>
          <span className="text-neutral-500 sm:text-right">
            {r.items.length}
            <span className="sm:hidden"> line{r.items.length === 1 ? "" : "s"}</span>
          </span>
          {partial ? (
            <span className="font-semibold tabular-nums sm:text-right" title={`${formatCents(r.totalCents)} was requested`}>
              {formatCents(r.approvedCents)}
              <span className="block text-xs font-normal text-neutral-500">of {formatCents(r.totalCents)}</span>
            </span>
          ) : (
            <span className="font-semibold tabular-nums sm:text-right">{formatCents(r.totalCents)}</span>
          )}
        </button>
      </div>

      {open && (
        <div className="border-t border-neutral-200 p-4 dark:border-neutral-800">
          {r.note && (
            <p className="mb-3 whitespace-pre-wrap rounded bg-neutral-50 px-3 py-2 text-sm dark:bg-neutral-800/50">
              <span className="font-medium">Note: </span>
              {r.note}
            </p>
          )}
          {r.decidedBy && r.decidedAt && (
            <p className="mb-3 text-sm text-neutral-600 dark:text-neutral-300">
              {PR_STATUS_LABEL[r.status]}
              {partial && ` (${r.approvedCount} of ${r.items.length} lines)`} by{" "}
              <span className="font-medium">{r.decidedBy.name}</span> · {formatWhen(r.decidedAt)}
              {r.decisionNote && <span className="block whitespace-pre-wrap text-neutral-500">“{r.decisionNote}”</span>}
            </p>
          )}
          {changed > 0 && (
            <p className="mb-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {changed} line{changed === 1 ? " has" : "s have"} changed on the BOM since this was requested (marked below).
              The amounts shown are what was requested.
            </p>
          )}

          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-neutral-500 dark:text-neutral-400">
                <tr>
                  {decidable && (
                    <th className="w-8 py-1.5 pr-2">
                      <input
                        type="checkbox"
                        aria-label="Approve every line"
                        checked={allPicked}
                        ref={(el) => {
                          if (el) el.indeterminate = pickedItems.length > 0 && !allPicked;
                        }}
                        onChange={() => setPicked(allPicked ? new Set() : new Set(r.items.map((i) => i.id)))}
                      />
                    </th>
                  )}
                  <th className="py-1.5 pr-3 font-medium">Item</th>
                  <th className="py-1.5 pr-3 font-medium">Manufacturer</th>
                  <th className="py-1.5 pr-3 font-medium">Project</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Unit cost</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Qty</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Ship &amp; tax</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Predicted</th>
                  <th className="py-1.5 pr-3 font-medium">Link</th>
                  <th className="py-1.5 font-medium">On the BOM now</th>
                </tr>
              </thead>
              <tbody>
                {r.items.map((i) => {
                  const allowance = i.kind === "allowance";
                  return (
                    <tr
                      key={i.id}
                      className={`border-t border-neutral-100 dark:border-neutral-800 ${
                        (decidable && !picked.has(i.id)) || i.approved === false ? "text-neutral-400 dark:text-neutral-500" : ""
                      }`}
                    >
                      {decidable && (
                        <td className="py-1.5 pr-2">
                          <input
                            type="checkbox"
                            aria-label={`Approve ${i.name}`}
                            checked={picked.has(i.id)}
                            onChange={() => togglePick(i.id)}
                          />
                        </td>
                      )}
                      <td className="py-1.5 pr-3">
                        <span className="font-medium">{i.name}</span>
                        {r.status === "approved" && i.approved === false && (
                          <span className="ml-2 rounded-full bg-neutral-100 px-1.5 text-[11px] font-semibold text-neutral-500 dark:bg-neutral-800">
                            not approved
                          </span>
                        )}
                        {i.partNumber && <span className="ml-2 text-xs text-neutral-500">{i.partNumber}</span>}
                      </td>
                      <td className="py-1.5 pr-3">{i.manufacturer ?? "—"}</td>
                      <td className="py-1.5 pr-3">
                        <Link href={`/projects/${i.live?.projectId ?? r.project.id}?view=bom`} className="hover:underline">
                          {i.projectName}
                        </Link>
                      </td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{i.unitCostCents === null ? "—" : formatCents(i.unitCostCents)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{allowance ? "—" : (i.quantity ?? 1)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{allowance || i.shippingCents === null ? "—" : formatCents(i.shippingCents)}</td>
                      <td className="py-1.5 pr-3 text-right font-medium tabular-nums">{formatCents(i.predictedCents)}</td>
                      <td className="py-1.5 pr-3">
                        {i.url ? (
                          <a href={i.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline dark:text-blue-400" title={i.url}>
                            {linkHost(i.url)} ↗
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="py-1.5">
                        {i.live ? (
                          <span className="flex items-center gap-1.5">
                            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_PILL[i.live.status]}`}>
                              {BOM_STATUS_LABEL[i.live.status]}
                            </span>
                            {i.changed && <span className="text-xs font-medium text-amber-700 dark:text-amber-400">changed</span>}
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-500">removed from the BOM</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t border-neutral-200 font-semibold dark:border-neutral-700">
                  <td className="py-1.5 pr-3" colSpan={decidable ? 7 : 6}>
                    {decidable && !allPicked ? `Approving ${pickedItems.length} of ${r.items.length}` : partial ? `Approved ${r.approvedCount} of ${r.items.length}` : "Total"}
                  </td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">
                    {formatCents(decidable ? pickedCents : partial ? r.approvedCents : r.totalCents)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>

          {(decidable || cancellable) && (
            <div className="mt-4 flex flex-col gap-2">
              {rejecting ? (
                <div className="flex flex-col gap-2">
                  <textarea
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why it's rejected, so they know what to change"
                    aria-label="Reason for rejecting"
                    className="w-full rounded border border-neutral-300 bg-white px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
                  />
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={busy || !reason.trim()}
                      onClick={() => run(() => rejectPurchaseRequest(r.id, reason))}
                      className={`${btn} bg-red-600 text-white hover:bg-red-700`}
                    >
                      Reject PR-{r.number}
                    </button>
                    <button type="button" onClick={() => setRejecting(false)} className={`${btn} text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800`}>
                      Back
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {decidable && (
                    <>
                      <button
                        type="button"
                        disabled={busy || pickedItems.length === 0}
                        title={pickedItems.length === 0 ? "Tick at least one line, or reject the request" : undefined}
                        onClick={() =>
                          run(() =>
                            approvePurchaseRequest(r.id, undefined, allPicked ? undefined : pickedItems.map((i) => i.id)),
                          )
                        }
                        className={`${btn} bg-green-600 text-white hover:bg-green-700`}
                      >
                        {allPicked
                          ? `Approve all · ${formatCents(pickedCents)}`
                          : `Approve ${pickedItems.length} of ${r.items.length} · ${formatCents(pickedCents)}`}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setRejecting(true)}
                        className={`${btn} border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950/40`}
                      >
                        Reject…
                      </button>
                    </>
                  )}
                  {cancellable && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => run(() => cancelPurchaseRequest(r.id))}
                      className={`${btn} ml-auto text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800`}
                    >
                      Cancel request
                    </button>
                  )}
                </div>
              )}
              {error && (
                <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

const BULK: Record<PrBulkAction, string> = { approve: "Approve all lines", reject: "Reject", cancel: "Cancel" };
const bulkField =
  "min-h-11 rounded border border-blue-300 bg-white px-2 py-1.5 text-sm text-neutral-900 dark:border-blue-800 dark:bg-neutral-900 dark:text-neutral-100 sm:min-h-0";

/**
 * Decide or cancel every selected request at once. Approving takes every line
 * of each (open one request to approve only some lines); only the changes this
 * viewer may make are offered, and the server checks each request again.
 */
function BulkBar({
  requests,
  viewerId,
  pvp,
  onDone,
  onClear,
}: {
  requests: PurchaseRequestView[];
  viewerId: string;
  pvp: boolean;
  onDone: () => void;
  onClear: () => void;
}) {
  const router = useRouter();
  const [action, setAction] = useState<PrBulkAction | "">("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const who = { userId: viewerId, pvp };
  const applies = (a: PrBulkAction, r: PurchaseRequestView) => {
    const d = { status: r.status, createdById: r.createdBy.id };
    return a === "cancel" ? canCancel(d, who) : canDecide(d, who);
  };
  const options = (["approve", "reject", "cancel"] as PrBulkAction[])
    .map((a) => ({ a, n: requests.filter((r) => applies(a, r)).length }))
    .filter((o) => o.n > 0);
  const chosen = options.find((o) => o.a === action);
  const targets = chosen ? requests.filter((r) => applies(chosen.a, r)) : [];
  const total = targets.reduce((n, r) => n + r.totalCents, 0);

  async function apply() {
    if (!chosen) return;
    const money = chosen.a === "approve" ? ` (${formatCents(total)})` : "";
    if (!window.confirm(`${BULK[chosen.a]}: ${targets.map((r) => `PR-${r.number}`).join(", ")}${money}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await bulkDecidePurchaseRequests(
        targets.map((r) => r.id),
        chosen.a,
        chosen.a === "reject" ? reason : undefined,
      );
      if ("error" in res) setMessage(res.error);
      else {
        if (res.failed.length) setMessage(`${res.done} done; ${res.failed.map((f) => `PR-${f.number}: ${f.error}`).join("; ")}`);
        else onDone();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sticky top-2 z-10 flex flex-col gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950 shadow-sm dark:border-blue-900 dark:bg-blue-950 dark:text-blue-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{requests.length} selected</span>
        <select
          aria-label="Set status"
          value={action}
          onChange={(e) => setAction(e.target.value as PrBulkAction | "")}
          className={bulkField}
        >
          <option value="">Set status…</option>
          {options.map((o) => (
            <option key={o.a} value={o.a}>
              {BULK[o.a]} ({o.n === requests.length ? "all" : `${o.n} of ${requests.length}`})
            </option>
          ))}
        </select>
        {chosen?.a === "reject" && (
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why? Everyone who asked sees this."
            aria-label="Reason for rejecting"
            className={`${bulkField} min-w-48 flex-1 px-3`}
          />
        )}
        <button
          type="button"
          disabled={busy || !chosen || (chosen.a === "reject" && !reason.trim())}
          onClick={apply}
          className={`${btn} bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300`}
        >
          {busy ? "Working…" : chosen ? `${BULK[chosen.a]} · ${targets.length}${chosen.a === "approve" ? ` · ${formatCents(total)}` : ""}` : "Apply"}
        </button>
        <button type="button" onClick={onClear} className={`${btn} ml-auto hover:bg-blue-100 dark:hover:bg-blue-900`}>
          Clear
        </button>
      </div>
      {message && <p role="alert">{message}</p>}
    </div>
  );
}
