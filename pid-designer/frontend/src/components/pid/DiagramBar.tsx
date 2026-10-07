import { useState } from 'react';
import type { DiagramMeta, DocRef } from '../../api/diagrams';
import { keyOf, refOf } from '../../api/diagrams';
import { btn } from '../../lib/ui';
import { CheckoutControl, CheckoutLostDialog, ThemeToggle } from '@stardesign-ui';
import type { Checkout, Theme } from '@stardesign-ui';

interface DiagramBarProps {
  diagrams: DiagramMeta[];
  activeKey: string | null;
  onSelect: (ref: DocRef) => void;
  onOpenChange: () => void;
  checkout: Checkout;
  /** False for a diagram we may only look at -- the main one, for a non-admin.
   *  The checkout chip then gives way to a copy button. */
  editable: boolean;
  onCopyActive: () => Promise<void> | void;
  theme: Theme;
  onToggleTheme: () => void;
}

/** A thin strip above the toolbar: pick a diagram, or open the Change dialog to
 *  create, rename, share, or take a copy of someone else's.
 *
 *  The list is the team's main diagram, your own, and everyone else's from the
 *  last few days; the Change dialog's Older tab has the rest. Diagrams are never
 *  deleted -- see backend/routers/pid.py. */
export function DiagramBar({
  diagrams, activeKey, onSelect, onOpenChange, checkout, editable, onCopyActive, theme, onToggleTheme,
}: DiagramBarProps) {
  const [copying, setCopying] = useState(false);
  const option = (d: DiagramMeta) => (
    <option key={keyOf(refOf(d))} value={keyOf(refOf(d))}>
      {d.mine ? d.name : `${d.name} - ${d.ownerName || d.owner}`}
    </option>
  );
  const main = diagrams.filter((d) => d.featured);
  const mine = diagrams.filter((d) => !d.featured && d.mine);
  const team = diagrams.filter((d) => !d.featured && !d.mine);
  // Groups only once there is a main diagram to set apart; until then the
  // list reads exactly as it always has.
  const grouped = main.length > 0;
  return (
    <div className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-primary)] px-4 py-1.5">
      <span className="mr-2 shrink-0 text-sm font-semibold text-[var(--color-text-primary)]">P&amp;ID Designer</span>
      <span className="h-4 w-px shrink-0 bg-[var(--color-border)]" />
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
        {grouped ? (
          <>
            <optgroup label="Main">{main.map(option)}</optgroup>
            {mine.length > 0 && <optgroup label="Mine">{mine.map(option)}</optgroup>}
            {team.length > 0 && <optgroup label="Team">{team.map(option)}</optgroup>}
          </>
        ) : (
          diagrams.map(option)
        )}
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

      {editable ? (
        <CheckoutControl checkout={checkout} noun="diagram" disabled={!activeKey} />
      ) : (
        <>
          <span
            className="shrink-0 text-[11px] text-[var(--color-text-muted)]"
            title="Only an admin can change the main diagram. Copy it to work on your own version."
          >
            Main diagram · read-only
          </span>
          <button
            className={btn}
            disabled={copying}
            onClick={async () => {
              setCopying(true);
              try { await onCopyActive(); } finally { setCopying(false); }
            }}
            title="Take your own copy of the main diagram and open it"
          >
            {copying ? 'Copying…' : 'Make a copy'}
          </button>
        </>
      )}
      {/* Renders nothing until the hold is lost without the user releasing it.
          Lives here, beside the control, so every app that shows the chip also
          tells the user when it goes. */}
      <CheckoutLostDialog checkout={checkout} noun="diagram" />

      <span className="ml-auto" />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
    </div>
  );
}
