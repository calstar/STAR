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
import { groupChecks, type CheckGroup, type CheckKind } from '../lib/checks';

const SECTION: Record<CheckKind, { title: string; hint: string; tone: string }> = {
  fix: {
    title: 'Worth fixing on the drawing',
    hint: 'Each of these changes an answer, or leaves part of the stand out. Fix it in pid-designer (or Library for the engine).',
    tone: 'var(--warn)',
  },
  assumed: {
    title: 'Filled in by the twin',
    hint: 'The drawing does not say, so the twin assumed it. The answer stands, but it rests on these.',
    tone: 'var(--muted)',
  },
  read: {
    title: 'How the drawing was read',
    hint: 'Nothing wrong: how the twin joined pages, oriented valves and read hand valves and vents.',
    tone: 'var(--dim)',
  },
};

/** The assembly's warnings, one line per kind (lib/checks.ts). How the
 *  drawing was read is folded away; the rest is open. */
function Checks({ warnings, labels = {} }: { warnings: readonly string[]; labels?: Record<string, string> }) {
  // Ids the backend names a line by, swapped for the drawing's labels.
  const named = (item: string) => item.replace(/\b(?:node|junc)_[\w]+/g, (id) => labels[id] ?? id);
  const groups = groupChecks(warnings).map((g) => ({ ...g, items: g.items.map(named) }));
  const of = (kind: CheckKind) => groups.filter((g) => g.kind === kind);
  const line = (g: CheckGroup) => (
    <li key={g.title} className="py-0.5 text-[12.5px] leading-relaxed" title={g.detail}>
      <span className="text-[var(--text)]">{g.title}</span>
      {g.items.length > 0 && (
        <span className="text-[var(--muted)]">
          {' '}
          — {g.items.length > 1 && <span className="num">{g.items.length}: </span>}
          {g.items.join(', ')}
        </span>
      )}
    </li>
  );
  return (
    <div className="flex flex-col gap-3 py-1">
      {(['fix', 'assumed'] as const).map((kind) =>
        of(kind).length ? (
          <section key={kind}>
            <h3 className="caps mb-1 text-[11px]" style={{ color: SECTION[kind].tone }} title={SECTION[kind].hint}>
              {SECTION[kind].title}
            </h3>
            <ul className="m-0 list-none p-0">{of(kind).map(line)}</ul>
          </section>
        ) : null,
      )}
      {of('read').length > 0 && (
        <details>
          <summary className="caps cursor-pointer text-[11px]" style={{ color: SECTION.read.tone }} title={SECTION.read.hint}>
            {SECTION.read.title} · {of('read').length}
          </summary>
          <ul className="m-0 mt-1 list-none p-0">{of('read').map(line)}</ul>
        </details>
      )}
    </div>
  );
}

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

export function ReportPanel({ report, labels }: { report: Report; labels?: Record<string, string> }) {
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

      <Checks warnings={report.warnings} labels={labels} />

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-baseline gap-2 py-1 text-left"
      >
        <span className="num text-[14px]" style={{ color: 'var(--warn)' }}>
          {sorted.length}
        </span>
        <span className="text-[12.5px] text-[var(--muted)]" title="Every number a part needs that the drawing did not state: what the library filled in, and whether anyone has looked at it since.">
          numbers the drawing did not give{report.unchecked > 0 && ` · ${report.unchecked} never checked`}
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
