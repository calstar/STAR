import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { RunView } from '../../api/layerx';
import { byPinThenNewest, runContext, runFigures, runWhen } from '../layerx/runs';
import { PlayIcon } from './Rail';
import { Button, Kbd, Menu, MenuItem, MenuLabel, MenuSeparator, Segmented } from './ui';
import { PRESETS, useUnits, type UnitSystem } from './units';
import type { LayerXJob, Tool } from './useLayerXJob';
import { downloadExport, EXPORTS } from './pages/exports';
import type { Theme } from './pages/kit';

/**
 * The top bar (docs/layerx/GUI-SPEC.md, Layout), 48 px:
 *
 *   [Burn | Injector | Optimize]   run ▾  ☆  vs ▾  ·  units ▾  ◐  ?   Export ▾  [Run ▶]
 *
 * The run picker, pin and compare are the Burn tool's; Injector and Optimize show their own past
 * jobs instead. A job the backend is busy with (any tool's) shows in the middle with its cancel.
 */

const TOOLS: { value: Tool; label: string }[] = [
  { value: 'burn', label: 'Burn' }, { value: 'injector', label: 'Injector' }, { value: 'optimize', label: 'Optimize' },
];

const PAST_LABEL: Record<string, string> = { optimize: 'Past searches', reconcile: 'Past injector solves' };

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const h = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(h); }, []);
  const s = Math.max(0, Math.round(now - since));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

function RunRow({ r, checked, onClick }: { r: RunView; checked: boolean; onClick: () => void }) {
  return (
    <MenuItem checked={checked} onClick={onClick} right={<span className="lx-num">{runFigures(r)}</span>}
              note={`${r.meta?.name ? `${runWhen(r)} · ` : ''}${runContext(r)}`}>
      {r.meta?.pinned ? <span className="text-[var(--lx-accent)]" aria-label="pinned">★ </span> : null}{r.meta?.name || runWhen(r)}
    </MenuItem>
  );
}

function RunPicker({ job }: { job: LayerXJob }) {
  const run = job.run;
  const sorted = [...job.burns].sort(byPinThenNewest);
  const pinned = sorted.filter((r) => r.meta?.pinned);
  const rest = sorted.filter((r) => !r.meta?.pinned);
  return (
    <Menu minWidth={380} title="The burn on screen" panelClassName="w-[min(28rem,90vw)]"
          label={
            <span className="flex min-w-0 max-w-[24rem] items-baseline gap-2">
              <span className="max-w-[14rem] shrink-0 truncate">{run ? run.meta?.name || runWhen(run) : job.burns.length ? 'Open a burn' : 'No burns yet'}</span>
              {run && <span className="hidden min-w-0 truncate text-[12px] font-normal text-[var(--lx-text-3)] 2xl:inline">{runContext(run)}</span>}
            </span>
          } disabled={!job.burns.length}>
      {pinned.length > 0 && <MenuLabel>Pinned</MenuLabel>}
      {pinned.map((r) => <RunRow key={r.id} r={r} checked={r.id === run?.id} onClick={() => job.openRun(r.id)} />)}
      {pinned.length > 0 && <MenuSeparator />}
      <MenuLabel>{job.burns.length} burn{job.burns.length === 1 ? '' : 's'}</MenuLabel>
      {rest.map((r) => <RunRow key={r.id} r={r} checked={r.id === run?.id} onClick={() => job.openRun(r.id)} />)}
    </Menu>
  );
}

function ComparePicker({ job }: { job: LayerXJob }) {
  const others = [...job.burns].sort(byPinThenNewest).filter((r) => r.id !== job.run?.id && r.status === 'done');
  const compare = job.reference?.run ?? null;
  return (
    <Menu minWidth={360} panelClassName="w-[min(28rem,90vw)]" disabled={!others.length || !job.run}
          title="Draw another burn in grey on every chart, and show the figures as changes against it ( C )"
          label={
            <span className="flex min-w-0 max-w-[12rem] items-baseline gap-1.5">
              <span className="text-[var(--lx-text-3)]">vs</span>
              {compare && <span className="truncate">{compare.meta?.name || runWhen(compare)}</span>}
            </span>
          }>
      {compare && <MenuItem onClick={() => job.setCompare('')}>No comparison</MenuItem>}
      {compare && <MenuSeparator />}
      {others.map((r) => <RunRow key={r.id} r={r} checked={r.id === job.compareId} onClick={() => job.setCompare(r.id)} />)}
    </Menu>
  );
}

function PastJobs({ job }: { job: LayerXJob }) {
  const kind = job.tool === 'optimize' ? 'optimize' : 'reconcile';
  const past = job.runs.filter((r) => r.kind === kind).sort(byPinThenNewest);
  if (!past.length) return null;
  return (
    <Menu label={<span>{PAST_LABEL[kind]} <span className="lx-num text-[var(--lx-text-3)]">{past.length}</span></span>} minWidth={340}>
      {past.map((r) => (
        <MenuItem key={r.id} onClick={() => job.openJob(r.id, kind)} note={runContext(r)}
                  right={<span style={{ color: r.status === 'failed' ? 'var(--lx-bad)' : undefined }}>{r.status}</span>}>
          {r.meta?.pinned ? '★ ' : ''}{r.meta?.name || runWhen(r)}
        </MenuItem>
      ))}
    </Menu>
  );
}

function UnitsMenu() {
  const u = useUnits();
  const s = u.system;
  const same = (a: UnitSystem, b: UnitSystem) => a.pressure === b.pressure && a.force === b.force && a.mass === b.mass && a.length === b.length;
  const radio = <K extends keyof UnitSystem>(k: K, options: { value: UnitSystem[K]; label: string }[]) => options.map((o) => (
    <MenuItem key={`${k}-${o.value}`} keepOpen checked={s[k] === o.value} onClick={() => u.setSystem({ [k]: o.value } as Partial<UnitSystem>)}>
      {o.label}
    </MenuItem>
  ));
  return (
    <Menu label={<span className="lx-num text-[12px]">{s.pressure} · {s.force} · {s.mass}</span>} title="Units" ariaLabel="Units" align="end" minWidth={220}>
      <MenuLabel>Systems</MenuLabel>
      <MenuItem keepOpen checked={same(s, PRESETS.stand)} onClick={() => u.setSystem(PRESETS.stand)} note="psi, N, kg, mm">Stand</MenuItem>
      <MenuItem keepOpen checked={same(s, PRESETS.si)} onClick={() => u.setSystem(PRESETS.si)} note="bar, N, kg, mm">SI</MenuItem>
      <MenuItem keepOpen checked={same(s, PRESETS.imperial)} onClick={() => u.setSystem(PRESETS.imperial)} note="psi, lbf, lb, in, ft">Imperial</MenuItem>
      <MenuSeparator />
      <MenuLabel>Pressure</MenuLabel>
      {radio('pressure', [{ value: 'psi', label: 'psi' }, { value: 'bar', label: 'bar' }])}
      <MenuLabel>Force</MenuLabel>
      {radio('force', [{ value: 'N', label: 'N' }, { value: 'lbf', label: 'lbf' }])}
      <MenuLabel>Mass</MenuLabel>
      {radio('mass', [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }])}
      <MenuLabel>Length</MenuLabel>
      {radio('length', [{ value: 'mm', label: 'mm, m' }, { value: 'in', label: 'in, ft' }])}
    </Menu>
  );
}

function ExportMenu({ job, onCopyLink, onNotice }: { job: LayerXJob; onCopyLink: () => void; onNotice?: (text: string) => void }) {
  const result = job.result;
  const id = job.run?.id;
  return (
    <Menu label="Export" align="end" minWidth={280} disabled={!job.run}>
      <MenuItem disabled={!result} onClick={job.exportCsv} note="Every step: pressures, flows, inventory, the eroding engine, the flight’s acceleration">CSV</MenuItem>
      {EXPORTS.filter((e) => e.fmt !== 'csv').map((e) => (
        <MenuItem key={e.fmt} disabled={!id} note={e.note}
                  onClick={() => { if (id) void downloadExport(id, e.fmt).then((err) => { if (err) onNotice?.(err); }); }}>{e.label}</MenuItem>
      ))}
      <MenuItem disabled={!result?.timeseries} onClick={() => { void job.exportEng(); }} note="For OpenRocket: propellant, dry mass and size from the design">Thrust curve (.eng)</MenuItem>
      <MenuItem disabled={!job.canSend} onClick={job.sendToForward} note={job.sendNote}>
        {job.sent ? 'Sent to Forward & Flight ✓' : 'Send to Forward & Flight'}
      </MenuItem>
      <MenuItem disabled={!result} onClick={() => { void job.printTestCard(); }} note="What to dial, what each channel should read, the lines not to cross">Print test card</MenuItem>
      <MenuItem onClick={onCopyLink} note="This run, page, cursor and comparison">Copy link</MenuItem>
      <MenuSeparator />
      <MenuItem disabled onClick={() => {}} note="Not built yet">Report (PDF)</MenuItem>
      <MenuItem disabled onClick={() => {}} note="Not built yet">Test card vs DAQ export</MenuItem>
    </Menu>
  );
}

export function TopBar({ job, theme, onTheme, onShortcuts, onRun, onCopyLink, notice, onNotice, inline = false }: {
  job: LayerXJob;
  /** Drawn beside the page's question under the tabs rather than as a bar of its own: a burn's
   *  pages then start a whole row higher. */
  inline?: boolean;
  theme: Theme;
  onTheme: () => void;
  onShortcuts: () => void;
  onRun: () => void;
  onCopyLink: () => void;
  /** A short-lived word after an action ("Link copied"). */
  notice?: ReactNode;
  /** Say something briefly in the bar (an export the server does not have yet). */
  onNotice?: (text: string) => void;
}) {
  const busy = job.activeJob && !(job.live && job.run?.id === job.activeJob.id) ? job.activeJob : null;
  const burn = job.tool === 'burn';
  return (
    <header className={inline
      ? 'ml-auto flex items-center gap-2'
      : 'sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-[var(--lx-line)] bg-[var(--lx-surface)] px-3'}>
      <Segmented ariaLabel="Layer X tool" value={job.tool} onChange={job.setTool} options={TOOLS} />
      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--lx-line)]" />
      {burn ? (
        <>
          <RunPicker job={job} />
          {job.run && (
            <Button variant="bare" iconOnly aria-pressed={!!job.run.meta?.pinned} onClick={job.pin}
                    aria-label={job.run.meta?.pinned ? 'Unpin this run' : 'Pin this run'}
                    title={job.run.meta?.pinned ? 'Pinned: never pruned. Click to unpin.' : 'Pin: keep this run however many follow it.'}>
              <span className={job.run.meta?.pinned ? 'text-[var(--lx-accent)]' : ''} aria-hidden>{job.run.meta?.pinned ? '★' : '☆'}</span>
            </Button>
          )}
          <ComparePicker job={job} />
        </>
      ) : <PastJobs job={job} />}

      <div className={inline ? 'flex min-w-0 items-center gap-3' : 'flex min-w-0 flex-1 items-center justify-center gap-3 px-2'}>
        {busy && (
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-[var(--lx-text-2)]" role="status">
            <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--lx-accent)]" />
            <span className="truncate text-[var(--lx-text)]">{job.activeWord[0]?.toUpperCase() + job.activeWord.slice(1)}</span>
            <span className="lx-num whitespace-nowrap text-[var(--lx-text-3)]">{Math.round(busy.progress * 100)}{'\u00a0'}% · <Elapsed since={busy.started} /></span>
            <Button size="sm" onClick={() => job.cancelJob(busy.id)}>Cancel</Button>
          </span>
        )}
        {notice && <span role="status" className="text-[12px] text-[var(--lx-text-2)]">{notice}</span>}
        {job.exportError && <span role="alert" className="truncate text-[12px] text-[var(--lx-bad)]">{job.exportError}</span>}
      </div>

      <UnitsMenu />
      <Button variant="bare" iconOnly onClick={onTheme} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'} title="Theme">
        <ThemeIcon />
      </Button>
      <Button variant="bare" iconOnly onClick={onShortcuts} aria-label="Keyboard shortcuts" aria-keyshortcuts="?" title="Shortcuts ( ? )">
        <span aria-hidden className="text-[13px]">?</span>
      </Button>
      <span aria-hidden className="mx-1 h-5 w-px bg-[var(--lx-line)]" />
      {burn && <ExportMenu job={job} onCopyLink={onCopyLink} onNotice={onNotice} />}
      <Button variant="primary" icon={<PlayIcon />} disabled={!job.canRun} onClick={onRun} aria-keyshortcuts="R"
              title={job.canRun ? 'Run the burn ( R )' : job.live ? 'Burning' : job.activeJob ? `A ${job.activeWord} is running` : 'The run is blocked: see the rail'}>
        Run
      </Button>
    </header>
  );
}

function ThemeIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M7 1.5a5.5 5.5 0 0 1 0 11z" fill="currentColor" />
    </svg>
  );
}

const SHEET: { keys: string[]; what: string }[] = [
  { keys: ['Space'], what: 'Play or pause the burn' },
  { keys: ['←', '→'], what: 'Step one sample (Shift: ten)' },
  { keys: ['[', ']'], what: 'Previous or next event' },
  { keys: ['Home', 'End'], what: 'T−0, burnout' },
  { keys: ['1', '8'], what: 'Overview … Record' },
  { keys: ['C'], what: 'Compare on or off' },
  { keys: ['R'], what: 'Run the burn' },
  { keys: ['\\'], what: 'Collapse or expand the rail' },
  { keys: ['?'], what: 'This sheet' },
];

/** The shortcut sheet: a small dialog, Escape or a click outside closes it, focus returns. */
export function ShortcutSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const back = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('keydown', esc); back?.focus?.(); };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 pt-[12vh]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId}
           className="w-[min(380px,calc(100vw-32px))] rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-surface)] p-4"
           style={{ boxShadow: 'var(--lx-shadow-pop)' }}
           onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); closeRef.current?.focus(); } }}>
        <div className="mb-3 flex items-center justify-between">
          <h2 id={titleId} className="text-[13px] font-medium">Keyboard</h2>
          <Button ref={closeRef} variant="bare" size="sm" onClick={onClose}>Close</Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-[12px]">
          {SHEET.map((s) => (
            <div key={s.what} className="contents">
              <dt className="flex items-center gap-1">{s.keys.map((k, i) => <span key={k} className="contents">{i > 0 && <span className="text-[var(--lx-text-3)]">{s.keys[0] === '1' ? '–' : ''}</span>}<Kbd>{k}</Kbd></span>)}</dt>
              <dd className="text-[var(--lx-text-2)]">{s.what}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
