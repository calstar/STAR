"use client";

import { useState } from "react";

import type { Option } from "@/components/bom/shared";
import { Modal } from "@/components/Modal";
import { type ImportPreviewSheet, commitBomImport, previewBomImport } from "@/lib/actions/bom";
import { predictedCents } from "@/lib/bom";
import { formatCents } from "@/lib/finance/money";

const control =
  "min-h-11 rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900 sm:min-h-0";

type Row = ImportPreviewSheet & { include: boolean; projectId: string };

/**
 * Import an LE3-style workbook: read it, show each sheet with where it will go
 * (guessed from the sheet's name, changeable), then save the sheets kept.
 * Nothing is saved until Import.
 */
export function BomImportDialog({
  projectId,
  projectOptions,
  canApprove,
  onClose,
  onImported,
}: {
  projectId: string;
  projectOptions: Option[];
  canApprove: boolean;
  onClose: () => void;
  onImported: () => void;
}) {
  const [fileName, setFileName] = useState("");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function read(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await previewBomImport(projectId, fd);
      if (res.error || !res.sheets) {
        setError(res.error ?? "Couldn't read that file.");
        setRows(null);
        return;
      }
      setFileName(file.name);
      setRows(res.sheets.map((s) => ({ ...s, include: s.lines.length > 0, projectId: s.suggestedProjectId })));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!rows) return;
    setBusy(true);
    try {
      const kept = rows.filter((r) => r.include && r.lines.length);
      const res = await commitBomImport(projectId, {
        fileName,
        sheets: kept.map((r) => ({ sheet: r.sheet, projectId: r.projectId, lines: r.lines })),
      });
      if (res.error) return setError(res.error);
      setDone(
        `Imported ${res.added} line${res.added === 1 ? "" : "s"}.` +
          (res.demoted ? ` ${res.demoted} marked approved or ordered in the sheet came in as Planned; a PVP approves them.` : ""),
      );
      setRows(null);
      onImported();
    } finally {
      setBusy(false);
    }
  }

  const keptLines = rows?.filter((r) => r.include).reduce((n, r) => n + r.lines.length, 0) ?? 0;
  const pastPlanned = rows?.filter((r) => r.include).flatMap((r) => r.lines).filter((l) => l.status !== "planned").length ?? 0;

  return (
    <Modal onClose={onClose}>
      <div className="overflow-y-auto p-5 sm:p-6">
        <h2 className="pr-12 text-lg font-semibold">Import a BOM spreadsheet</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          An .xlsx laid out like LE3 BOM.xlsx: one sheet per subsystem, part names in column A, and a header row
          (Unit Cost, Qty, Shipping &amp; Tax, Supplier, Link, Approved?, Ordered?, …). Columns are found by their
          header, in any order. The sheet&apos;s Predicted column isn&apos;t kept; the BOM computes it.
        </p>

        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void read(e.target.files?.[0])}
          disabled={busy}
          className="mt-4 block text-sm"
        />
        {busy && <p className="mt-2 text-sm text-neutral-500">Working…</p>}
        {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {done && <p className="mt-3 rounded bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950 dark:text-green-200">{done}</p>}

        {rows && (
          <>
            <div className="mt-4 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
              {rows.map((r, i) => (
                <div key={r.sheet} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
                  <label className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={r.include}
                      disabled={r.lines.length === 0}
                      onChange={(e) => setRows((rs) => rs!.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))}
                    />
                    <span className="min-w-0">
                      <span className="font-medium">{r.sheet}</span>
                      <span className="ml-2 text-sm text-neutral-500">
                        {r.lines.length} line{r.lines.length === 1 ? "" : "s"}
                        {r.lines.length > 0 && ` · ${formatCents(r.lines.reduce((n, l) => n + predictedCents(l), 0))}`}
                      </span>
                      {r.warnings.map((w) => (
                        <span key={w} className="block text-xs text-amber-700 dark:text-amber-400">{w}</span>
                      ))}
                    </span>
                  </label>
                  {r.lines.length > 0 && (
                    <select
                      aria-label={`Project for ${r.sheet}`}
                      value={r.projectId}
                      disabled={!r.include}
                      onChange={(e) => setRows((rs) => rs!.map((x, j) => (j === i ? { ...x, projectId: e.target.value } : x)))}
                      className={`${control} sm:w-72`}
                    >
                      {projectOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
            {!canApprove && pastPlanned > 0 && (
              <p className="mt-3 text-sm text-amber-800 dark:text-amber-300">
                {pastPlanned} line{pastPlanned === 1 ? " is" : "s are"} marked approved or ordered in the sheet. They come in as
                Planned, since approving is a PVP&apos;s call.
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={onClose} className="min-h-11 rounded px-3 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800 sm:min-h-0">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void commit()}
                disabled={busy || keptLines === 0}
                className="min-h-11 rounded bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 sm:min-h-0"
              >
                Import {keptLines} line{keptLines === 1 ? "" : "s"}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
