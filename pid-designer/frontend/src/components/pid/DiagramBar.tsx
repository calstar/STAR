import type { DiagramMeta, DocRef } from '../../api/diagrams';
import { keyOf, refOf } from '../../api/diagrams';
import { btn } from '../../lib/ui';
import { CheckoutControl, CheckoutLostDialog } from '@stardesign-ui';
import type { Checkout } from '@stardesign-ui';
import type { Theme } from '../../lib/theme';

interface DiagramBarProps {
  diagrams: DiagramMeta[];
  activeKey: string | null;
  onSelect: (ref: DocRef) => void;
  onOpenChange: () => void;
  checkout: Checkout;
  theme: Theme;
  onToggleTheme: () => void;
}

/** Sun for "switch to light," moon for "switch to dark" -- the icon shown is
 *  always the theme a click would go *to*, matching how this pairs of icons
 *  is read everywhere else. */
function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]"
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {theme === 'dark' ? (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" strokeWidth={2} />
          <path strokeLinecap="round" strokeWidth={2} d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
        </svg>
      )}
    </button>
  );
}

/** A thin strip above the toolbar: pick a diagram, or open the Change dialog to
 *  create, rename, share, or take a copy of someone else's.
 *
 *  The list is the caller's own diagrams plus any shared with them; the Change
 *  dialog's second tab is everyone else's. Diagrams are never deleted -- see
 *  backend/routers/pid.py. */
export function DiagramBar({ diagrams, activeKey, onSelect, onOpenChange, checkout, theme, onToggleTheme }: DiagramBarProps) {
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
      {/* Renders nothing until the hold is lost without the user releasing it.
          Lives here, beside the control, so every app that shows the chip also
          tells the user when it goes. */}
      <CheckoutLostDialog checkout={checkout} noun="diagram" />

      <span className="ml-auto" />
      <ThemeToggle theme={theme} onToggle={onToggleTheme} />
    </div>
  );
}
