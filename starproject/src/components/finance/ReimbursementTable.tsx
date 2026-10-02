"use client";

import {
  type SortingState,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useState } from "react";

import { StatusPill } from "@/components/finance/StatusPill";
import { formatDay } from "@/lib/finance/dates";
import { formatCents } from "@/lib/finance/money";
import type { FinanceRow } from "@/lib/finance/queries";

const col = createColumnHelper<FinanceRow>();

// Mobile shows #/subject/amount/status; md adds date and payee; lg the rest.
const columnClasses: Record<string, string> = {
  date: "hidden md:table-cell",
  payeeName: "hidden md:table-cell",
  callinkRequestNumber: "hidden lg:table-cell",
  category: "hidden lg:table-cell",
};


const columns = [
  col.accessor("number", {
    header: "#",
    cell: (info) => <span className="whitespace-nowrap text-neutral-400 dark:text-neutral-500">R-{info.getValue()}</span>,
  }),
  col.accessor("date", { header: "Date", cell: (info) => <span className="whitespace-nowrap">{formatDay(info.getValue())}</span> }),
  col.accessor("subject", {
    header: "Subject",
    cell: (info) => <span className="font-medium">{info.getValue()}</span>,
  }),
  col.accessor("payeeName", { header: "Payee" }),
  col.accessor("amountCents", {
    header: "Amount",
    cell: (info) => <span className="whitespace-nowrap tabular-nums">{formatCents(info.getValue())}</span>,
  }),
  col.accessor((r) => r.status.label, {
    id: "status",
    header: "Status",
    cell: (info) => <StatusPill label={info.row.original.status.label} tone={info.row.original.status.tone} />,
  }),
  col.accessor("callinkRequestNumber", { header: "CalLink #", cell: (info) => info.getValue() ?? "—" }),
  col.accessor("category", { header: "Category", cell: (info) => info.getValue() ?? "—" }),
];

/** All reimbursements, newest first; a row click opens the detail card. */
export function ReimbursementTable({ rows, onOpen }: { rows: FinanceRow[]; onOpen: (number: number) => void }) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div className="overflow-x-auto rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr
              key={hg.id}
              className="border-b border-neutral-200 dark:border-neutral-800 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
            >
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  onClick={h.column.getToggleSortingHandler()}
                  className={`cursor-pointer select-none px-3 py-3 font-medium md:py-2 ${columnClasses[h.column.id] ?? ""}`}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-3 py-4 text-neutral-500 dark:text-neutral-400">
                No reimbursements match.
              </td>
            </tr>
          )}
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              onClick={() => onOpen(row.original.number)}
              className="cursor-pointer border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className={`px-3 py-2.5 align-middle md:py-1.5 ${columnClasses[cell.column.id] ?? ""}`}>
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
