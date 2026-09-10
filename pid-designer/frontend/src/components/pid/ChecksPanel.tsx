import { useMemo, useState } from 'react';
import type { Edge, Node } from '@xyflow/react';
import { countProblems, runChecks } from './checks';
import type { Finding, Severity } from './checks';

/**
 * The checks panel: what is wrong with this feed system, in one place.
 *
 * A badge rather than a wall of inline markers. Marking every finding on the
 * canvas would put the loudest decoration on the most crowded drawings, which
 * is backwards -- and a drawing mid-edit is *supposed* to be incomplete. So the
 * count is quiet until something is genuinely wrong, and the panel is where the
 * detail lives.
 *
 * Clicking a finding selects what it is about, because "PT-4 has no range" is
 * only useful if you can then find PT-4.
 */

const TONE: Record<Severity, { dot: string; text: string; label: string }> = {
  error:   { dot: 'bg-red-500',   text: 'text-red-400',   label: 'Error' },
  warning: { dot: 'bg-amber-500', text: 'text-amber-400', label: 'Check' },
  info:    { dot: 'bg-slate-500', text: 'text-slate-400', label: 'Note' },
};

export function ChecksPanel({ nodes, edges, onSelect }: {
  nodes: Node[];
  edges: Edge[];
  onSelect: (nodeIds: string[], edgeIds: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const findings = useMemo(() => runChecks(nodes, edges), [nodes, edges]);
  const problems = countProblems(findings);
  const worst: Severity | null =
    findings.some(f => f.severity === 'error') ? 'error'
    : findings.some(f => f.severity === 'warning') ? 'warning'
    : findings.length ? 'info' : null;

  return (
    <div className="absolute right-3 top-3 z-20 flex flex-col items-end gap-2">
      <button
        onClick={() => setOpen(o => !o)}
        title={problems ? `${problems} thing${problems === 1 ? '' : 's'} to look at` : 'Feed system checks'}
        className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs shadow-lg backdrop-blur transition-colors ${
          worst === 'error'
            ? 'border-red-500/50 bg-red-500/10 text-red-300 hover:bg-red-500/20'
            : worst === 'warning'
            ? 'border-amber-500/50 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20'
            : 'border-[var(--color-border)] bg-[var(--color-bg-secondary)]/90 text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"
            strokeLinecap="round" strokeLinejoin="round" />
          <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" />
          <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
        </svg>
        {problems > 0 && <span className="font-semibold tabular-nums">{problems}</span>}
      </button>

      {open && (
        <div className="max-h-[60vh] w-[340px] overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 shadow-2xl">
          <div className="flex items-baseline justify-between px-1 pb-1.5">
            <p className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Feed system checks</p>
            <button onClick={() => setOpen(false)} className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              Close
            </button>
          </div>

          {findings.length === 0 ? (
            <p className="px-1 py-3 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              Nothing to flag. Disconnects are paired, no two fluids meet anywhere they
              should not, and every tank has a pressure and a temperature.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {findings.map(f => <Row key={f.id} finding={f} onSelect={onSelect} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ finding, onSelect }: {
  finding: Finding;
  onSelect: (nodeIds: string[], edgeIds: string[]) => void;
}) {
  const tone = TONE[finding.severity];
  const canSelect = !!(finding.nodeIds?.length || finding.edgeIds?.length);
  return (
    <li>
      <button
        disabled={!canSelect}
        onClick={() => onSelect(finding.nodeIds ?? [], finding.edgeIds ?? [])}
        className={`w-full rounded px-2 py-1.5 text-left ${canSelect ? 'hover:bg-[var(--color-bg-primary)]' : 'cursor-default'}`}
      >
        <span className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tone.dot}`} />
          <span className={`text-[10px] uppercase tracking-wider ${tone.text}`}>{tone.label}</span>
        </span>
        <p className="mt-0.5 text-[11px] font-medium text-[var(--color-text-primary)]">{finding.title}</p>
        <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{finding.detail}</p>
      </button>
    </li>
  );
}
