import type { DiagramMeta, DocRef } from '../../api/diagrams';
import { keyOf, refOf } from '../../api/diagrams';
import { btn } from '../../lib/ui';
import { CheckoutControl } from '@stardesign-ui';
import type { Checkout } from '@stardesign-ui';

interface DiagramBarProps {
  diagrams: DiagramMeta[];
  activeKey: string | null;
  onSelect: (ref: DocRef) => void;
  onOpenChange: () => void;
  checkout: Checkout;
}

/** A thin strip above the toolbar: pick a diagram, or open the Change dialog to
 *  create, rename, share, or take a copy of someone else's.
 *
 *  The list is the caller's own diagrams plus any shared with them; the Change
 *  dialog's second tab is everyone else's. Diagrams are never deleted -- see
 *  backend/routers/pid.py. */
export function DiagramBar({ diagrams, activeKey, onSelect, onOpenChange, checkout }: DiagramBarProps) {
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-1.5">
      <span className="shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Diagram</span>
      <select
        value={activeKey ?? ''}
        onChange={(e) => {
          const picked = diagrams.find((d) => keyOf(refOf(d)) === e.target.value);
          if (picked) onSelect(refOf(picked));
        }}
        className="min-w-[180px] max-w-[320px] rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
      >
        {diagrams.length === 0 && <option value="">No diagrams</option>}
        {diagrams.map((d) => (
          <option key={keyOf(refOf(d))} value={keyOf(refOf(d))}>
            {d.mine ? d.name : `${d.name} - ${d.ownerName || d.owner}`}
          </option>
        ))}
      </select>
      <button
        onClick={onOpenChange}
        className={btn}
        title="Create, rename, share, or take a copy of someone else's diagram"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
        </svg>
        Change
      </button>

      <CheckoutControl checkout={checkout} noun="diagram" disabled={!activeKey} />
    </div>
  );
}
