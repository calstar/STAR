import type { ReactNode } from 'react';
import type { RunView } from '../../api/layerx';
import { Menu, MenuItem } from './Menu';
import { byPinThenNewest, runContext, runFigures, runWhen } from './runs';

/**
 * The burn on screen, and what to do with it: pick another, compare against one, pin it, export it.
 * One row above every page of the result, so the run is always named where it is read.
 */

export interface RunAction { label: string; note?: ReactNode; onClick: () => void; disabled?: boolean }

function RunRow({ r, active, onClick }: { r: RunView; active: boolean; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
            className={`flex w-full items-baseline justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--color-bg-secondary)] ${active ? 'bg-[var(--color-bg-secondary)]' : ''}`}>
      <span className="min-w-0">
        <span className="block truncate text-[var(--color-text-primary)]">
          {r.meta?.pinned ? <span className="text-[var(--color-accent)]">★ </span> : null}{r.meta?.name || runWhen(r)}
        </span>
        <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{r.meta?.name ? `${runWhen(r)} · ` : ''}{runContext(r)}</span>
      </span>
      <span className="shrink-0 tabular-nums text-[var(--color-text-muted)]">{runFigures(r)}</span>
    </button>
  );
}

export function RunBar({ run, burns, onOpen, compareId, onCompare, onPin, actions, error }: {
  run: RunView;
  /** Every finished-or-going burn, this one included. */
  burns: RunView[];
  onOpen: (id: string) => void;
  compareId: string;
  onCompare: (id: string) => void;
  onPin: () => void;
  actions: RunAction[];
  error?: string | null;
}) {
  const sorted = [...burns].sort(byPinThenNewest);
  const others = sorted.filter((r) => r.id !== run.id && r.status === 'done');
  const compare = burns.find((r) => r.id === compareId) ?? null;
  const pinned = !!run.meta?.pinned;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Menu panelClass="w-[min(28rem,90vw)]"
            buttonClass="max-w-full !px-3 !py-2 !text-[13px]"
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate font-medium text-[var(--color-text-primary)]">{run.meta?.name || runWhen(run)}</span>
                <span className="hidden truncate text-[12px] text-[var(--color-text-muted)] sm:inline">{runContext(run)}</span>
              </span>
            }>
        {(close) => (
          <div className="max-h-[26rem] overflow-y-auto">
            <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-[var(--color-text-muted)]">{burns.length} burn{burns.length === 1 ? '' : 's'} · pinned first</div>
            {sorted.map((r) => <RunRow key={r.id} r={r} active={r.id === run.id} onClick={() => { close(); onOpen(r.id); }} />)}
          </div>
        )}
      </Menu>

      <button type="button" onClick={onPin} aria-pressed={pinned}
              title={pinned ? 'Pinned: never pruned. Click to unpin.' : 'Pin: keep this run however many follow it.'}
              className={`rounded-md border px-2.5 py-2 text-[12px] leading-none ${pinned ? 'border-[var(--color-accent)]/60 text-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}`}>
        {pinned ? '★ Pinned' : '☆ Pin'}
      </button>

      {others.length > 0 && (
        <Menu panelClass="w-[min(28rem,90vw)]" title="Draw another burn in grey on every chart, and show the figures as changes against it."
              buttonClass="!py-2"
              label={compare
                ? <span className="flex min-w-0 items-baseline gap-1.5"><span className="text-[var(--color-text-muted)]">vs</span><span className="max-w-[12rem] truncate text-[var(--color-text-primary)]">{compare.meta?.name || runWhen(compare)}</span></span>
                : <span>Compare</span>}>
          {(close) => (
            <div className="max-h-[26rem] overflow-y-auto">
              {compare && <MenuItem onClick={() => { close(); onCompare(''); }}>No comparison</MenuItem>}
              {others.map((r) => <RunRow key={r.id} r={r} active={r.id === compareId} onClick={() => { close(); onCompare(r.id); }} />)}
            </div>
          )}
        </Menu>
      )}

      <div className="ml-auto flex items-center gap-2">
        {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
        <Menu align="right" panelClass="w-72" buttonClass="!py-2" label="Export">
          {(close) => actions.map((a) => (
            <MenuItem key={a.label} disabled={a.disabled} note={a.note} onClick={() => { close(); a.onClick(); }}>{a.label}</MenuItem>
          ))}
        </Menu>
      </div>
    </div>
  );
}
