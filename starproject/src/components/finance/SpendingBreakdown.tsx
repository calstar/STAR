import { SpendingPie } from "@/components/finance/SpendingPie";
import { pieSlices } from "@/lib/finance/charts";
import type { SpendingRow } from "@/lib/finance/ledger";
import { formatCents } from "@/lib/finance/money";

const PAID = "bg-neutral-800 dark:bg-neutral-200";
const PENDING = "bg-neutral-400 dark:bg-neutral-500";

/** One breakdown as a pie of its top level, then a table, each row with a bar scaled to the
 * biggest: paid solid, pending lighter. `order` fixes each entity's colour. */
export function SpendingBreakdown({ title, rows, order }: { title: string; rows: SpendingRow[]; order: string[] }) {
  const max = Math.max(1, ...rows.filter((r) => r.depth === 0).map((r) => r.bucket.paidCents + r.bucket.pendingCents));
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{title}</h3>
        <p className="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${PAID}`} /> Approved
          </span>
          <span className="flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${PENDING}`} /> Pending
          </span>
        </p>
      </div>
      <SpendingPie label={title} slices={pieSlices(rows, order)} />
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">No reimbursements this year.</p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th>Name</th>
              <th>Spent</th>
              <th>Requests</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const total = r.bucket.paidCents + r.bucket.pendingCents;
              return (
                <tr key={r.id ?? "untagged"} className="border-t border-neutral-100 dark:border-neutral-800">
                  <td className="py-1.5 pr-3" style={{ paddingLeft: `${r.depth * 1}rem` }}>
                    <span className={r.id ? (r.depth ? "text-neutral-600 dark:text-neutral-300" : "font-medium") : "italic text-neutral-500"}>
                      {r.name}
                    </span>
                    <span
                      className="mt-1 flex h-1.5 gap-0.5"
                      style={{ width: `${(total / max) * 100}%` }}
                      title={`${formatCents(r.bucket.paidCents)} approved, ${formatCents(r.bucket.pendingCents)} pending`}
                    >
                      {r.bucket.paidCents > 0 && <span className={`h-full rounded-sm ${PAID}`} style={{ flexGrow: r.bucket.paidCents }} />}
                      {r.bucket.pendingCents > 0 && <span className={`h-full rounded-sm ${PENDING}`} style={{ flexGrow: r.bucket.pendingCents }} />}
                    </span>
                  </td>
                  <td className="whitespace-nowrap py-1.5 text-right align-top tabular-nums">
                    {formatCents(total)}
                    {r.bucket.pendingCents > 0 && (
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400">{formatCents(r.bucket.pendingCents)} pending</span>
                    )}
                  </td>
                  <td className="w-12 whitespace-nowrap py-1.5 pl-3 text-right align-top text-xs text-neutral-500 tabular-nums dark:text-neutral-400">
                    {r.bucket.count}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
