"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { BomImportDialog } from "@/components/bom/BomImportDialog";
import { BomSheet } from "@/components/bom/BomSheet";
import { RequestPurchaseDialog } from "@/components/bom/RequestPurchaseDialog";
import type { Option } from "@/components/bom/shared";
import { BOM_STATUSES, BOM_STATUS_LABEL, type BomSection, type BomStatus, summarize } from "@/lib/bom";
import { formatCents } from "@/lib/finance/money";

type Line = BomSection["lines"][number];

const control =
  "min-h-11 rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0";
const btn =
  "inline-flex min-h-11 items-center rounded border border-neutral-300 px-3 py-1 text-sm text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800 sm:min-h-0";

/**
 * A project's bill of materials: totals, filters, and the sheet -- its own
 * lines and one section per subproject (everything under it rolled in), like
 * LE3 BOM.xlsx with a sheet per subsystem, edited in place.
 */
export function BomTab({
  projectId,
  projectName,
  sections,
  projectOptions,
  people,
  canApprove,
  showOwnHeader,
  pendingRequests,
}: {
  projectId: string;
  projectName: string;
  /** Every section, empty ones included, so each subproject has a row to type into. */
  sections: BomSection[];
  /** This project and everything under it, as "LE4 › LE4 Avionics". */
  projectOptions: Option[];
  people: Option[];
  canApprove: boolean;
  /** A top-level project heads its own lines with a "(general)" row; a project with a parent doesn't. */
  showOwnHeader: boolean;
  /** BOM line id -> the PR number it is waiting on. */
  pendingRequests: Record<string, number>;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | BomStatus>("");
  const [spares, setSpares] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [requested, setRequested] = useState<number | null>(null);

  const all = useMemo(() => sections.flatMap((s) => s.lines), [sections]);
  const filtered = !!(q || status || !spares);
  const keep = (l: Line) =>
    (spares || !l.spare) &&
    (!status || l.status === status) &&
    (!q ||
      [l.name, l.manufacturer, l.partNumber, l.supplier, l.notes, l.subpath, l.location]
        .filter(Boolean)
        .some((v) => v!.toLowerCase().includes(q.toLowerCase())));
  // While filtering, a section with nothing matching is hidden; otherwise every
  // section shows, so there is always a row to add to.
  const shown = sections
    .map((s) => ({ ...s, lines: s.lines.filter(keep) }))
    .filter((s) => !filtered || s.lines.length > 0);
  const totals = summarize(shown.flatMap((s) => s.lines));

  const picked = all.filter((l) => selected.has(l.id));
  // A purchase request takes lines still Planned and not already waiting on one.
  // A purchase request is exactly the lines ticked in the sheet. Each must still
  // be Planned and not already waiting on a request. The button is always
  // there, greyed out (with the reason) until the ticked lines can be requested.
  const notRequestable = picked.filter((l) => l.status !== "planned" || pendingRequests[l.id]);
  const canRequest = picked.length > 0 && notRequestable.length === 0;
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    // min-w-0 lets the sheet scroll inside its own box instead of widening the page.
    <div className="flex min-w-0 flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Kpi label="Predicted (incl. shipping)" value={formatCents(totals.predictedCents)} />
        <Kpi label="Approved" value={formatCents(totals.approvedCents)} />
        <Kpi label="Parts ordered" value={`${totals.orderedParts} / ${totals.parts}`} />
      </div>
      {filtered && (
        <p className="-mt-2 text-xs text-neutral-500 dark:text-neutral-400">Totals are for the lines the filters show.</p>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search parts…" className={`${control} w-full sm:w-56`} />
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as BomStatus | "")} className={control}>
          <option value="">All statuses</option>
          {BOM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {BOM_STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <label className="flex min-h-11 items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300 sm:min-h-0">
          <input type="checkbox" checked={spares} onChange={(e) => setSpares(e.target.checked)} />
          Include spares
        </label>
        <div className="flex flex-wrap gap-2 sm:ml-auto">
          <button
            type="button"
            onClick={() => setRequesting(true)}
            disabled={!canRequest}
            title={
              all.length === 0
                ? "Add parts to this BOM first"
                : picked.length === 0
                  ? "Tick the parts to request in the first column"
                  : !canRequest
                    ? `Untick ${notRequestable.map((l) => l.name).join(", ")}: only Planned lines not already on a request can be requested`
                    : "Ask a PVP to approve buying the ticked parts"
            }
            className={`${btn} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Request purchase{picked.length > 0 ? ` (${picked.length})` : ""}
          </button>
          <button type="button" onClick={() => setImporting(true)} className={btn}>
            Import .xlsx
          </button>
          <a href={`/api/bom/export?project=${projectId}`} className={btn}>
            Export .xlsx
          </a>
        </div>
      </div>

      {requested !== null && (
        <p className="flex items-start gap-2 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-900 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          <span className="flex-1">
            Requested as{" "}
            <Link href={`/purchase-requests?pr=${requested}`} className="font-semibold underline">
              PR-{requested}
            </Link>
            . A PVP approves it on the Purchase Requests page; its lines turn Approved then.
          </span>
          <button type="button" onClick={() => setRequested(null)} aria-label="Dismiss" className="text-green-700 hover:text-green-900">
            ×
          </button>
        </p>
      )}

      {notice && (
        <p role="alert" className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-amber-700 hover:text-amber-900">
            ×
          </button>
        </p>
      )}

      {shown.length === 0 ? (
        <p className="text-sm text-neutral-500">No lines match the filters.</p>
      ) : (
        <BomSheet
          rootProjectId={projectId}
          showOwnHeader={showOwnHeader}
          sections={shown}
          projectOptions={projectOptions}
          people={people}
          canApprove={canApprove}
          pendingRequests={pendingRequests}
          selected={selected}
          onToggle={toggle}
          onChanged={() => router.refresh()}
          onError={setNotice}
        />
      )}
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Click a cell to edit; it saves when you leave it. Enter moves down, Tab moves right, Esc undoes. Type in a
        section&apos;s last row to add a part to {all.length ? "that project" : projectName}, or paste rows copied from
        Excel or Google Sheets there.
      </p>

      {requesting && (
        <RequestPurchaseDialog
          projectId={projectId}
          lines={picked}
          onClose={() => setRequesting(false)}
          onRequested={(n) => {
            setRequesting(false);
            setSelected(new Set());
            setRequested(n);
            router.refresh();
          }}
        />
      )}

      {importing && (
        <BomImportDialog
          projectId={projectId}
          projectOptions={projectOptions}
          canApprove={canApprove}
          onClose={() => setImporting(false)}
          onImported={() => router.refresh()}
        />
      )}
    </div>
  );
}

function Kpi({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900">
      <div className={`text-lg font-semibold tabular-nums ${warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</div>
      <div className="text-xs text-neutral-500 dark:text-neutral-400">{label}</div>
    </div>
  );
}
