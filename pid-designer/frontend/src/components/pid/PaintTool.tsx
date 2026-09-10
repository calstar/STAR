import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';

/**
 * The paint bucket.
 *
 * Colour used to be a right-click menu, which nobody found. It is a mode now:
 * pick a colour, and every symbol and line you click takes it until you turn
 * the tool off. That is how anybody who has used a drawing tool expects to
 * colour twenty things in a row, and it is the only way the "draw boxes round
 * the GSE sections and colour them" job is not twenty right-clicks.
 */

export const SWATCHES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#a855f7', '#ec4899',
  '#f43f5e', '#94a3b8', '#e2e8f0', '#0f172a',
];

export function PaintTool({ colour, onColour, active, onToggle }: {
  colour: string | null;
  onColour: (hex: string | null) => void;
  active: boolean;
  onToggle: (on: boolean) => void;
}) {
  const readOnly = useReadOnly();
  const [open, setOpen] = useState(false);
  const [hex, setHex] = useState('');

  const commit = (v: string) => {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
    if (m) { onColour(`#${m[1]}`); onToggle(true); setOpen(false); }
  };

  return (
    <div className="relative">
      <button
        disabled={readOnly}
        onClick={() => { if (active) { onToggle(false); setOpen(false); } else setOpen(o => !o); }}
        title={active ? 'Paint on — click symbols and lines, or press Escape' : 'Paint: pick a colour, then click things'}
        className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs transition-colors ${
          active
            ? 'bg-[var(--color-accent)] text-white'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]'
        }`}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 11 9 1 2 8l10 10z" />
          <path d="M2 15h20" opacity="0.5" />
          <circle cx="20" cy="18" r="2.5" />
        </svg>
        Paint
        <span
          className="h-3 w-3 rounded-sm border border-black/40"
          style={{ background: colour ?? 'transparent' }}
        />
      </button>

      {open && !active && (
        <div
          className="absolute left-0 top-full z-30 mt-1 w-[188px] rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          <div className="grid grid-cols-8 gap-1">
            {SWATCHES.map(c => (
              <button
                key={c}
                title={c}
                disabled={readOnly}
                onClick={() => { onColour(c); onToggle(true); setOpen(false); }}
                className="h-4 w-4 rounded-sm border border-black/30 transition-transform hover:scale-110"
                style={{ background: c }}
              />
            ))}
          </div>

          <div className="mt-2 flex gap-1">
            <input
              value={hex}
              placeholder="#rrggbb"
              readOnly={readOnly}
              onChange={e => setHex(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') commit(hex); }}
              className="min-w-0 flex-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-1 font-mono text-[11px] outline-none focus:border-[var(--color-accent)]"
            />
            <button
              disabled={readOnly}
              onClick={() => commit(hex)}
              className="shrink-0 rounded border border-[var(--color-border)] px-1.5 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]"
            >
              Set
            </button>
          </div>

          <button
            disabled={readOnly}
            onClick={() => { onColour(null); onToggle(true); setOpen(false); }}
            className="mt-1.5 w-full rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-primary)]"
          >
            Erase — back to fluid colour
          </button>
        </div>
      )}
    </div>
  );
}
