import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';

/**
 * Colour override, on right-click.
 *
 * The menu this replaces set a line's "fluid type" by hand -- four colours
 * standing in for four fluids. Fluid is now inherited from whatever tank feeds
 * a line (`fluids.ts`), so setting it per edge would only let a drawing
 * disagree with itself. What is left is what colour is genuinely for here:
 * marking things up. Grouping a GSE panel, flagging a line for a review, doing
 * the highlighting a drawing needs and a solver ignores.
 *
 * So an override is exactly that -- an override. Clearing it hands the symbol
 * back to its fluid colour rather than leaving it grey, because the automatic
 * colour is the one that stays right when somebody re-plumbs the drawing.
 */

const SWATCHES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899',
  '#f43f5e', '#94a3b8', '#e2e8f0', '#0f172a',
];

export function ColorMenu({ x, y, current, onPick, onClear, onClose }: {
  x: number; y: number;
  current?: string;
  onPick: (hex: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [hex, setHex] = useState(current ?? '');
  // Read from context rather than taken as a prop: this menu is reached from
  // the canvas's own handlers, which already refuse to open it without the
  // checkout, and consulting the context makes that true of the controls too
  // rather than only of the thing that opens them.
  const readOnly = useReadOnly();

  const commit = (v: string) => {
    const t = v.trim();
    // Accept #abc and #aabbcc, with or without the hash.
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t);
    if (m) onPick(`#${m[1]}`);
  };

  return (
    <div
      style={{ position: 'fixed', left: x, top: y, zIndex: 9999 }}
      className="w-[188px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 shadow-xl"
      onClick={e => e.stopPropagation()}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); }}
    >
      <p className="px-1 pb-1.5 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">Colour</p>

      <div className="grid grid-cols-8 gap-1">
        {SWATCHES.map(c => (
          <button
            key={c}
            title={c}
            disabled={readOnly}
            onClick={() => { onPick(c); onClose(); }}
            className="h-4 w-4 rounded-sm border border-black/30 transition-transform hover:scale-110"
            style={{ background: c, outline: current === c ? '2px solid #3b82f6' : undefined }}
          />
        ))}
      </div>

      <div className="mt-2 flex gap-1">
        <input
          value={hex}
          placeholder="#rrggbb"
          readOnly={readOnly}
          onChange={e => setHex(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { commit(hex); onClose(); } }}
          className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          disabled={readOnly}
          onClick={() => { commit(hex); onClose(); }}
          className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]"
        >
          Set
        </button>
      </div>

      <button
        disabled={readOnly}
        onClick={() => { onClear(); onClose(); }}
        className="mt-1.5 w-full rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]"
      >
        Back to fluid colour
      </button>
    </div>
  );
}
