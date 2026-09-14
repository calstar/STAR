import { useState } from 'react';
import { useReadOnly } from '@stardesign-ui';

/**
 * The page tabs.
 *
 * Deliberately along the bottom, where a spreadsheet puts them: these are
 * sheets of one document, and putting them next to the diagram picker at the
 * top would read as "which diagram", which is the thing they are not.
 */
export function PageBar({
  pages, current, onSelect, onAdd, onRename, count, selectedCount, onMoveSelection,
}: {
  pages: string[];
  current: string;
  onSelect: (page: string) => void;
  onAdd: (name: string) => void;
  onRename: (from: string, to: string) => void;
  /** How many components sit on each page. */
  count: (page: string) => number;
  /** Selected on the current page, for the move affordance. */
  selectedCount: number;
  onMoveSelection: (page: string) => void;
}) {
  const readOnly = useReadOnly();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commit = () => {
    if (editing && draft.trim() && draft.trim() !== editing) onRename(editing, draft.trim());
    setEditing(null);
  };

  return (
    <div className="flex items-center gap-1 border-t border-[var(--color-border)] bg-[var(--color-bg-primary)] px-3 py-1">
      <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
        Pages
      </span>

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {pages.map(p => (
          editing === p ? (
            <input
              key={p}
              autoFocus
              value={draft}
              readOnly={readOnly}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') setEditing(null);
              }}
              className="w-28 rounded border border-[var(--color-accent)] bg-[var(--color-bg-secondary)] px-2 py-0.5 text-xs outline-none"
            />
          ) : (
            <button
              key={p}
              onClick={() => onSelect(p)}
              onDoubleClick={() => { if (!readOnly) { setEditing(p); setDraft(p); } }}
              title={`${count(p)} component${count(p) === 1 ? '' : 's'} — double-click to rename`}
              className={`shrink-0 rounded px-2 py-0.5 text-xs transition-colors ${
                p === current
                  ? 'bg-[var(--color-bg-secondary)] font-medium text-[var(--color-text-primary)] ring-1 ring-[var(--color-border)]'
                  : 'text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)]'
              }`}
            >
              {p}
              <span className="ml-1.5 text-[10px] tabular-nums text-[var(--color-text-muted)]">{count(p)}</span>
            </button>
          )
        ))}
      </div>

      {selectedCount > 0 && (
        <span className="ml-2 flex shrink-0 items-center gap-1 border-l border-[var(--color-border)] pl-2">
          <span className="text-[10px] text-[var(--color-text-muted)]">
            Move {selectedCount} to
          </span>
          {pages.filter(p => p !== current).map(p => (
            <button
              key={p}
              disabled={readOnly}
              onClick={() => onMoveSelection(p)}
              title={`Move the selection to ${p}`}
              className="rounded border border-[var(--color-border)] px-1.5 py-0.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
            >
              {p}
            </button>
          ))}
        </span>
      )}

      <button
        disabled={readOnly}
        onClick={() => {
          const base = 'Page';
          let n = pages.length + 1;
          while (pages.includes(`${base} ${n}`)) n++;
          onAdd(`${base} ${n}`);
        }}
        title="Add a page — the rocket side and the GSE side belong in one diagram"
        className="shrink-0 rounded px-2 py-0.5 text-xs text-[var(--color-text-muted)] hover:bg-[var(--color-bg-secondary)] hover:text-[var(--color-text-primary)]"
      >
        + Page
      </button>
    </div>
  );
}
