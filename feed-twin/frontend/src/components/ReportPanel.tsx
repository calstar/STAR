/**
 * What the assembly read, and what it had to invent.
 *
 * A drawing that omits a bore still solves, and the answer is still worth
 * having — but it is a different kind of claim from one where every number was
 * measured, and the difference must never be invisible. Unchecked first:
 * the top of that list is the next thing worth measuring.
 */

import { useState } from 'react';
import type { Report } from '../api';

const RANK: Record<string, number> = { default: 0, estimated: 1 };

/** Assumed values span a leak rate of 1e-6 Cv and a 9.5 mm bore, so neither a
 *  fixed decimal count nor exponential alone reads well across the list. */
const amount = (v: number) => {
  if (v === 0) return '0';
  const magnitude = Math.abs(v);
  if (magnitude < 0.001 || magnitude >= 1e6) return v.toExponential(1);
  return String(Number(v.toPrecision(4)));
};
const LABEL: Record<string, string> = {
  default: 'Unchecked',
  estimated: 'Estimated',
};

export function ReportPanel({ report }: { report: Report }) {
  const [open, setOpen] = useState(false);
  const sorted = [...report.assumptions].sort(
    (a, b) =>
      (RANK[a.source] ?? 9) - (RANK[b.source] ?? 9) ||
      a.component.localeCompare(b.component),
  );

  return (
    <div className="flex flex-col gap-2 px-3 py-2">
      <dl className="m-0 grid grid-cols-2 gap-x-5 gap-y-0.5 sm:grid-cols-3">
        {[
          ['Symbols', report.symbols],
          ['Lines', report.lines],
          ['Nodes', report.nodes],
          ['Branches', report.branches],
          ['Transducers', report.instruments],
          ['Actuators', report.actuators],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex items-baseline gap-2">
            <dt className="text-[12px] text-[var(--dim)]">{label}</dt>
            <dd className="num ml-auto text-[13px]">{value}</dd>
          </div>
        ))}
      </dl>

      <p className="text-[12px] text-[var(--muted)]">
        {report.coupled
          ? 'Engine coupled — chamber pressure solved from the flows.'
          : 'No engine — the injector face is a fixed pressure boundary.'}
      </p>

      {report.warnings.map((w) => (
        <p key={w} className="text-[11.5px]" style={{ color: 'var(--warn)' }}>
          {w}
        </p>
      ))}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-baseline gap-2 py-1 text-left"
      >
        <span className="num text-[14px]" style={{ color: 'var(--warn)' }}>
          {sorted.length}
        </span>
        <span className="text-[12.5px] text-[var(--muted)]">
          unmeasured{report.unchecked > 0 && `, ${report.unchecked} unchecked`}
        </span>
        <span className="ml-auto text-[12px] text-[var(--accent)]">
          {open ? 'Hide' : 'Show'}
        </span>
      </button>

      {open && (
        <ul className="m-0 grid max-h-[280px] list-none grid-cols-[max-content_1fr_max-content_max-content_max-content] gap-x-3 overflow-y-auto p-0">
          {sorted.map((a) => (
            <li
              key={`${a.component}.${a.parameter}`}
              className="col-span-full grid grid-cols-subgrid items-baseline border-b border-[var(--edge)] px-1 py-1 last:border-b-0"
            >
              <span className="num text-[11.5px] text-[var(--muted)]">
                {a.component}
              </span>
              <span className="truncate text-[12.5px]">{a.parameter}</span>
              <span className="num text-right text-[12.5px]">
                {amount(a.value)}
              </span>
              <span className="num text-[11.5px] text-[var(--dim)]">
                {a.unit}
              </span>
              <span
                className="text-right text-[11px]"
                style={{
                  color: a.source === 'default' ? 'var(--warn)' : 'var(--dim)',
                }}
              >
                {LABEL[a.source] ?? a.source}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
