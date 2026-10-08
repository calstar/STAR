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
  /** False for a diagram we may only look at -- a STAR one we have not been
   *  given edit access to. The checkout chip then gives way to Request edit
   *  and a copy button. */
  editable: boolean;
  onCopyActive: () => Promise<void> | void;
  /** Whether we have asked to edit the open diagram. */
  requested: boolean;
  /** Ask to edit the open diagram, or withdraw the request. */
  onRequestActive: (on: boolean) => Promise<void> | void;
  /** Pending requests we can answer, shown as a badge on Change. */
  requestCount: number;
  theme: Theme;
  onToggleTheme: () => void;
}

/** A thin strip above the toolbar: pick a diagram, or open the Change dialog to
 *  create, rename, share, answer requests, or take a copy.
 *
 *  The list is the STAR diagrams (the main one among them -- it is only what
 *  a new tab opens on) and your own.
 *  Shared diagrams (and, for an admin, everyone's) live in the Change dialog's
 *  Mine and Other tabs. Diagrams are never deleted -- see
 *  backend/routers/pid.py. */
export function DiagramBar({
  diagrams, activeKey, onSelect, onOpenChange, checkout, editable, onCopyActive,
  requested, onRequestActive, requestCount, theme, onToggleTheme,
}: DiagramBarProps) {
  const [copying, setCopying] = useState(false);
  const [asking, setAsking] = useState(false);
  const option = (d: DiagramMeta) => (
    <option key={keyOf(refOf(d))} value={keyOf(refOf(d))}>
      {d.mine ? d.name : `${d.name} - ${d.ownerName || d.owner}`}
    </option>
  );
  const star = diagrams.filter((d) => d.featured || d.star);
  const mine = diagrams.filter((d) => !d.featured && !d.star && d.mine);
  // Anything else opened from Change still has to be in the list, or the
  // select would show a diagram that is not the one on the canvas.
  const open = diagrams.filter(
    (d) => !d.featured && !d.star && !d.mine && keyOf(refOf(d)) === activeKey,
  );
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
        {star.length > 0 && <optgroup label="STAR">{star.map(option)}</optgroup>}
        {mine.length > 0 && <optgroup label="Mine">{mine.map(option)}</optgroup>}
        {open.length > 0 && <optgroup label="Open">{open.map(option)}</optgroup>}
      </select>
      <button
        onClick={onOpenChange}
        className={btn}
        title={requestCount > 0
          ? `${requestCount} ${requestCount === 1 ? 'person is' : 'people are'} asking to edit your diagrams`
          : "Create, rename, share, or take a copy of someone else's diagram"}
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
        </svg>
        Change
        {requestCount > 0 && (
          <span className="ml-0.5 rounded-full bg-[var(--color-accent)] px-1.5 text-[10px] font-semibold leading-4 text-[var(--color-bg-primary)]">
            {requestCount}
          </span>
        )}
      </button>

      {editable ? (
        <CheckoutControl checkout={checkout} noun="diagram" disabled={!activeKey} />
      ) : (
        <>
          <span
            className="shrink-0 text-[11px] text-[var(--color-text-muted)]"
            title="Its creator or an admin decides who edits it. Ask them, or copy it to work on your own version."
          >
            Read-only
          </span>
          <button
            className={btn}
            disabled={asking}
            onClick={async () => {
              setAsking(true);
              try { await onRequestActive(!requested); } finally { setAsking(false); }
            }}
            title={requested
              ? 'Waiting for its creator or an admin. Click to withdraw the request.'
              : 'Ask its creator or an admin to let you edit this diagram'}
          >
            {requested ? 'Edit requested' : 'Request edit'}
          </button>
          <button
            className={btn}
            disabled={copying}
            onClick={async () => {
              setCopying(true);
              try { await onCopyActive(); } finally { setCopying(false); }
            }}
            title="Take your own copy of this diagram and open it"
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
