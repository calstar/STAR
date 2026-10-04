import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  layerx, DEFAULT_SETTINGS,
  type Check, type Drawing, type LayerXResult, type LayerXSettings, type LayerXStatus, type PidDocument, type Preflight,
  type RunMeta, type RunView, type SweepResult,
} from '../../api/layerx';
import type { EngineConfig } from '../../api/client';
import { useConfigChanged } from '../../lib/configBus';
import { useViewState } from '../../lib/viewState';
import { configFingerprint } from '../../lib/engineIdentity';
import { saveTimeSeriesResults } from '../../utils/timeseriesSession';
import { Hint } from '../Hint';
import { FeedSchematic } from './FeedSchematic';
import { LayerXResultView } from './LayerXResult';
import { pollJob } from './jobs';
import { Optimise } from './Optimise';
import { Reconcile } from './Reconcile';
import { ParametersPanel } from './ParametersPanel';
import { UncertaintyView } from './Uncertainty';
import { EMPTY_SERIES, fmt, LB, LOX, FUEL } from './format';
import { burnCsv } from './csv';
import { testCardHtml } from './testcard';
import { Menu } from './Menu';
import { RunBar } from './RunBar';
import { byPinThenNewest, KIND_WORD, runContext, runLabel, runWhen } from './runs';

/**
 * Layer X: the feed system and the engine, burned together.
 *
 * Left: the hardware (a drawing), how it is set up before firing, what to simulate, and anything
 * that blocks the run. Right: the burn. The engine is always EngineDesign's own. Settings are
 * this browser's; a run records everything it used.
 */

const SANS = { fontFamily: 'Inter, system-ui, sans-serif' };
const STATUS_COLOR: Record<Check['status'], string> = {
  ok: 'var(--color-success)', info: 'var(--color-text-muted)', warn: 'var(--color-warning)', fail: 'var(--color-danger)',
};

type Stored = Omit<LayerXSettings, 'drawing_id'> & { drawing_id: string };

/** The stages a burn goes through, as the backend names them (engine/layerx/analysis.py). */
// A burn is settled, then burned in passes (each feeding the last pass's eroded throat and, when
// flown, the flight's acceleration back in) until nothing moves, then checked.
const PASS_STAGES = [
  { key: 'burn', label: 'Burn', match: /^Burning/ },
  { key: 'erosion', label: 'Erosion', match: /^Nozzle erosion/ },
  { key: 'flight', label: 'Flight', match: /^Flight/ },
] as const;

const field = 'w-full rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 py-1.5 text-[13px] text-[var(--color-text-primary)] tabular-nums placeholder:text-[var(--color-text-muted)] focus:outline-none focus:border-[var(--color-accent)]';

function Group({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-t border-[var(--color-border)] pt-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-[var(--color-text-primary)]">{title}</h3>
        {aside}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function NumberField({ label, unit, value, placeholder, onChange, hint, step }: {
  label: string; unit: string; value: number | null | undefined; placeholder?: string; hint?: ReactNode; step?: number;
  onChange: (v: number | null) => void;
}) {
  // A draft only while editing; otherwise the field shows the value it was given, so a value
  // changed elsewhere (a reset, another run reopened) is never shadowed by stale text.
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (value === null || value === undefined ? '' : String(value));
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between text-[12px] text-[var(--color-text-secondary)]">
        {hint ? <Hint text={hint}><span>{label}</span></Hint> : <span>{label}</span>}
        <span className="text-[var(--color-text-muted)]">{unit}</span>
      </span>
      <input className={field} inputMode="decimal" value={text} placeholder={placeholder} step={step}
             onChange={(e) => setDraft(e.target.value.replace(/[^0-9.eE-]/g, ''))}
             onBlur={() => {
               if (draft === null) return;
               const v = draft.trim() === '' ? null : Number(draft);
               setDraft(null);
               onChange(v === null || Number.isFinite(v) ? v : null);
             }}
             onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-0.5"
         style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} title={o.hint}
                onClick={() => onChange(o.value)}
                className={`rounded px-2 py-1 text-[12px] transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] ${value === o.value
                  ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <Hint text={hint}><span className="text-[13px] text-[var(--color-text-secondary)]">{label}</span></Hint>
      <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--color-accent)] ${checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'}`}>
        <span className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}

function DrawingFacts({ d }: { d: Drawing }) {
  const s = d.summary;
  if (!s.readable) return <div className="text-[12px] text-[var(--color-danger)]">{s.error}</div>;
  const dome = s.regulators?.find((r) => r.dome_loaded);
  return (
    <div className="space-y-0.5 text-[12px] text-[var(--color-text-muted)] tabular-nums">
      {s.tanks?.map((t) => (
        <div key={t.id} className="flex justify-between gap-3">
          <span style={{ color: t.fluid === 'oxygen' ? LOX : t.fluid === 'ethanol' ? FUEL : undefined }}>{t.fluid === 'oxygen' ? 'LOX' : t.fluid === 'ethanol' ? 'Fuel' : t.label} tank</span>
          <span>{fmt(t.volume_L, 2)} L</span>
        </div>
      ))}
      {s.bottles?.map((b) => (
        <div key={b.id} className="flex justify-between gap-3">
          <span>Bottle, {b.fluid === 'nitrogen' ? 'GN2' : b.fluid === 'helium' ? 'helium' : b.fluid}</span>
          <span>{fmt(b.volume_L, 2)} L</span>
        </div>
      ))}
      {dome && (
        <Hint text={<>Dome-loaded regulator. Supply effect {fmt(dome.supply_coefficient, 0)} psi per 1000 psi of bottle drop, droop {fmt(dome.flow_droop_psi, 1)} psi at full flow (from the drawing).</>}>
          <span>Dome regulator</span>
        </Hint>
      )}
    </div>
  );
}

function PidPicker({ onImported, onClose }: { onImported: (d: Drawing) => void; onClose: () => void }) {
  const [docs, setDocs] = useState<PidDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    layerx.pidDocuments().then((r) => {
      if (r.error) setError(r.error);
      else if (!r.data?.reachable) setError(`pid-designer is not answering at ${r.data?.url}.`);
      else setDocs(r.data.documents);
    });
  }, []);
  const take = async (doc: PidDocument) => {
    setBusy(doc.id);
    const r = await layerx.pidImport({ id: doc.id, owner: doc.mine ? '' : doc.owner, name: doc.name });
    setBusy(null);
    if (r.error) setError(r.error);
    else if (r.data) onImported(r.data);
  };
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-2">
      <div className="mb-1 flex items-center justify-between px-1">
        <span className="text-[12px] text-[var(--color-text-secondary)]">pid-designer drawings</span>
        <button type="button" onClick={onClose} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">Close</button>
      </div>
      {error && <div className="px-1 py-1 text-[12px] text-[var(--color-warning)]">{error}</div>}
      {!docs && !error && <div className="px-1 py-1 text-[12px] text-[var(--color-text-muted)]">Asking pid-designer…</div>}
      <ul className="max-h-56 overflow-auto">
        {docs?.map((d) => (
          <li key={`${d.owner}/${d.id}`}>
            <button type="button" disabled={!!busy} onClick={() => take(d)}
                    className="flex w-full items-baseline justify-between gap-3 rounded px-1.5 py-1 text-left text-[12px] hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">
              <span className="truncate text-[var(--color-text-primary)]">{d.name}</span>
              <span className="shrink-0 text-[var(--color-text-muted)]">{busy === d.id ? 'Importing' : d.mine ? 'yours' : d.owner}</span>
            </button>
          </li>
        ))}
        {docs && docs.length === 0 && <li className="px-1 py-1 text-[12px] text-[var(--color-text-muted)]">No drawings shared with you.</li>}
      </ul>
    </div>
  );
}

function PreflightList({ pf, loading, error }: { pf: Preflight | null; loading: boolean; error: string | null }) {
  const [showNotes, setShowNotes] = useState(false);
  if (error) return <div className="text-[12px] text-[var(--color-danger)]">{error}</div>;
  if (!pf) return <div className="text-[12px] text-[var(--color-text-muted)]">{loading ? 'Checking…' : 'Choose a drawing.'}</div>;
  const fails = pf.checks.filter((c) => c.status === 'fail');
  const notes = pf.checks.filter((c) => c.status === 'warn');
  const row = (c: Check, k: number) => (
    <li key={`${c.key}-${k}`} className="flex gap-2">
      <span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[c.status] }} />
      {c.status === 'fail'
        ? <span className="min-w-0 text-[12px] text-[var(--color-text-secondary)]">{c.label}<span className="block text-[11px] leading-snug text-[var(--color-text-muted)]">{c.detail}</span></span>
        : <Hint text={c.detail}><span className="text-[12px] text-[var(--color-text-secondary)]">{c.label}</span></Hint>}
    </li>
  );
  return (
    <div className={`space-y-2 transition-opacity ${loading ? 'opacity-50' : ''}`}>
      {fails.length > 0 && <ul className="space-y-1.5">{fails.map(row)}</ul>}
      {notes.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowNotes((v) => !v)} aria-expanded={showNotes}
                  className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
            {notes.length} note{notes.length > 1 ? 's' : ''} {showNotes ? '▾' : '▸'}
          </button>
          {showNotes && <ul className="mt-1.5 space-y-1">{notes.map(row)}</ul>}
        </div>
      )}
    </div>
  );
}

function Fold({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className="border-t border-[var(--color-border)] pt-3">
      <button type="button" onClick={onToggle} aria-expanded={open}
              className="flex w-full items-center justify-between text-[13px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
        {title}<span className="text-[11px] text-[var(--color-text-muted)]">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </section>
  );
}

/** The rail's own words for each setting, so the banner reads like the rail. */
const SETTING_LABEL: Partial<Record<keyof LayerXSettings, string>> = {
  drawing_id: 'Drawing', tank_pressure_psia: 'Tank pressure', copv_pressure_psig: 'Bottle fill', load: 'Propellant load',
  fill_fraction: 'Fill fraction', dry_kg: 'Unusable propellant', engine_model: 'Engine', ullage_collapse: 'Ullage collapse',
  ullage_vapour: 'Propellant vapour', chilldown: 'Tank wall heat transfer', line_walls: 'Line-wall heat',
  hold_s: 'Loaded before T-0', dt: 'Time step', horizon_s: 'Max burn', settle: 'Settle', replay: 'Nozzle erosion',
  flight: 'Flight', pressurant: 'Pressurant', liftoff_mass_kg: 'Liftoff mass',
};

/** Each setting's value as the rail shows it, with its unit; "not set" says where it comes from. */
const SETTING_SHOW: Partial<Record<keyof LayerXSettings, (v: number) => string>> = {
  tank_pressure_psia: (v) => `${fmt(v, 1)} psia`, copv_pressure_psig: (v) => `${fmt(v, 0)} psig`,
  fill_fraction: (v) => `${fmt(v * 100, 0)} %`, dry_kg: (v) => `${fmt(v, 3)} kg`, chilldown: (v) => `${fmt(v, 0)} W/m²·K`,
  hold_s: (v) => `${fmt(v, 0)} s`, dt: (v) => `${fmt(v * 1000, 0)} ms`, horizon_s: (v) => `${fmt(v, 0)} s`,
  liftoff_mass_kg: (v) => `${fmt(v / LB, 1)} lb`,
};
const UNSET: Partial<Record<keyof LayerXSettings, string>> = {
  tank_pressure_psia: 'the design', copv_pressure_psig: 'the drawing', liftoff_mass_kg: 'the design', pressurant: 'as drawn',
};

/** What differs between the settings a burn ran with and the rail's now, as "Label a → b". */
function settingsDiff(ran: LayerXSettings, now: LayerXSettings, drawingName: (id: string) => string): string[] {
  const show = (k: keyof LayerXSettings, v: unknown) =>
    v === null || v === undefined ? (UNSET[k] ?? 'not set') : typeof v === 'boolean' ? (v ? 'on' : 'off')
      : k === 'drawing_id' ? drawingName(String(v)) : SETTING_SHOW[k] && typeof v === 'number' ? SETTING_SHOW[k]!(v) : String(v);
  const out: string[] = [];
  for (const k of Object.keys(SETTING_LABEL) as (keyof LayerXSettings)[]) {
    const a = ran[k] ?? null;
    const b = now[k] ?? null;
    if (k === 'liftoff_mass_kg' && !ran.flight && !now.flight) continue;
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${SETTING_LABEL[k]} ${show(k, a)} → ${show(k, b)}`);
  }
  return out;
}

/**
 * What the person says about the open run: a name and a note, or delete it. Saved on the server
 * with the run, not in this browser. The pin is on the run bar.
 */
function RunPanel({ run, onChanged, onDeleted }: { run: RunView; onChanged: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(run.meta?.name ?? '');
  const [note, setNote] = useState(run.meta?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (meta: RunMeta) => {
    const r = await layerx.annotate(run.id, meta);
    if (r.error) setError(r.error); else { setError(null); onChanged(); }
  };
  return (
    <section className="grid max-w-3xl grid-cols-1 gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-secondary)]">Name</span>
        <input className={field} placeholder={runWhen(run)} value={name} maxLength={80}
               onChange={(e) => setName(e.target.value)} onBlur={() => name !== (run.meta?.name ?? '') && save({ name })}
               onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
      </label>
      <label className="block">
        <span className="mb-1 block text-[12px] text-[var(--color-text-secondary)]">Note</span>
        <textarea className={field} rows={2} maxLength={2000} placeholder="What this run was for, what it showed, what was decided"
                  value={note} onChange={(e) => setNote(e.target.value)}
                  onBlur={() => note !== (run.meta?.note ?? '') && save({ note })} />
      </label>
      <div className="flex items-center gap-3 text-[12px] sm:col-start-2">
        <span className="text-[var(--color-text-muted)]">Saved with the run on the server.</span>
        {error && <span className="text-[var(--color-danger)]">{error}</span>}
        <button type="button" className="ml-auto text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                onClick={async () => {
                  if (!window.confirm('Delete this run for good?')) return;
                  const r = await layerx.deleteRun(run.id);
                  if (r.error) setError(r.error); else onDeleted();
                }}>Delete this run</button>
      </div>
    </section>
  );
}

const PAST_LABEL: Record<string, string> = { optimize: 'Past searches', reconcile: 'Past injector solves' };

/** The study tabs. The trade study was removed (docs/layerx/AUDIT.md D6); its saved jobs stay listed as legacy. */
const MAIN_VIEWS = ['burn', 'optimise', 'reconcile'] as const;
type MainView = (typeof MAIN_VIEWS)[number];

/** A study's earlier jobs, to reopen. */
function PastRuns({ kind, runs, onOpen }: { kind: string; runs: RunView[]; onOpen: (id: string) => void }) {
  const past = runs.filter((r) => r.kind === kind).sort(byPinThenNewest);
  if (!past.length) return null;
  return (
    <Menu align="right" panelClass="w-[min(24rem,90vw)]" buttonClass="!py-2" label={`${PAST_LABEL[kind] ?? 'Past runs'} · ${past.length}`}>
      {(close) => (
        <div className="max-h-80 overflow-y-auto">
          {past.map((r) => (
            <button key={r.id} type="button" role="menuitem" onClick={() => { close(); onOpen(r.id); }}
                    className="flex w-full items-baseline justify-between gap-4 rounded-md px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--color-bg-secondary)]">
              <span className="min-w-0">
                <span className="block truncate text-[var(--color-text-primary)]">{r.meta?.pinned ? '★ ' : ''}{r.meta?.name || runWhen(r)}</span>
                <span className="block truncate text-[11px] text-[var(--color-text-muted)]">{runContext(r)}</span>
              </span>
              <span className="shrink-0" style={{ color: r.status === 'failed' ? STATUS_COLOR.fail : 'var(--color-text-muted)' }}>{r.status}</span>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

function StudyCard({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-7">{children}</div>;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const h = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(h); }, []);
  const s = Math.max(0, Math.round(now - since));
  return <>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</>;
}

function RunProgress({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  const stage = run.stage || '';
  const phase = /^Settling/.test(stage) ? 0 : /^(Checking|Done)/.test(stage) ? 2 : 1;
  const pass = Number(/pass (\d+)/.exec(stage)?.[1] ?? (phase === 1 ? 1 : 0));
  const subs = PASS_STAGES.filter((st) => (st.key !== 'erosion' || run.settings.replay !== false) && (st.key !== 'flight' || run.settings.flight));
  const sub = subs.findIndex((st) => st.match.test(stage));
  const fed = [run.settings.replay !== false && 'the eroded throat', run.settings.flight && pass >= 3 && "the flight's acceleration"].filter(Boolean);
  const caption = pass <= 1 ? 'As built' : fed.length ? `Re-burning with ${fed.join(' and ')} from the last pass` : 'Re-burning';
  const typical = run.settings.flight ? 4 : run.settings.replay !== false ? 2 : 1;
  const top = ['Settle', 'Passes', 'Checks'];
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-5" style={SANS}>
      <ol className="flex items-center gap-2">
        {top.map((label, k) => {
          const state = k < phase ? 'done' : k === phase ? 'now' : 'next';
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <span className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 text-[11px] tabular-nums ${state === 'now' ? 'bg-[var(--color-accent)] text-white' : state === 'done' ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]' : 'border border-[var(--color-border)] text-[var(--color-text-muted)]'}`}>
                {state === 'done' ? '✓' : k + 1}
              </span>
              <span className={`text-[12px] ${state === 'now' ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
                {k === 1 && pass > 0 ? `Pass ${pass}` : label}
              </span>
              {k < top.length - 1 && <span className="h-px flex-1 bg-[var(--color-border)]" />}
            </li>
          );
        })}
      </ol>
      {phase === 1 && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
          <span className="text-[var(--color-text-secondary)]">{caption}</span>
          <span className="flex items-center gap-1.5">
            {subs.map((st, k) => (
              <span key={st.key} className={`rounded px-2 py-0.5 ${k === sub ? 'bg-[var(--color-accent)]/15 text-[var(--color-text-primary)]' : k < sub ? 'text-[var(--color-text-secondary)]' : 'text-[var(--color-text-muted)]'}`}>
                {k < sub ? '✓ ' : ''}{st.label}
              </span>
            ))}
          </span>
          <Hint text="Each pass feeds what the last one found (the eroded throat, the flight's acceleration) back into the burn. The run stops when a pass changes nothing; the last pass is that check.">
            <span className="text-[var(--color-text-muted)]">usually {typical} pass{typical > 1 ? 'es' : ''}</span>
          </Hint>
        </div>
      )}
      <div className="mt-4 h-1 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
        <div className="h-full bg-[var(--color-accent)] transition-[width] duration-300" style={{ width: `${Math.max(run.progress, 0.02) * 100}%` }} />
      </div>
      <div className="mt-3 flex items-center justify-between text-[12px] text-[var(--color-text-muted)]">
        <span className="tabular-nums"><Elapsed since={run.started} /> · runs on the server, safe to leave</span>
        <button type="button" onClick={onCancel} className="rounded-md border border-[var(--color-border)] px-3 py-1 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

export function LayerX({ config, isVisible, onConfigUpdated }: {
  config: EngineConfig | null; isVisible: boolean; onConfigUpdated?: (config: EngineConfig) => void;
}) {
  const [storedSettings, setSettings] = useViewState<Stored>('layerx.settings.v2', { ...DEFAULT_SETTINGS, drawing_id: '' });
  // Stored before a setting existed means stored without it: lay the defaults underneath.
  const settings = useMemo<Stored>(() => ({ ...DEFAULT_SETTINGS, ...storedSettings }), [storedSettings]);
  const [openRunId, setOpenRunId] = useViewState<string>('layerx.openRun', '');
  const openRunRef = useRef(openRunId);
  openRunRef.current = openRunId;
  const [status, setStatus] = useState<LayerXStatus | null>(null);
  const [drawings, setDrawings] = useState<Drawing[]>([]);
  const [pf, setPf] = useState<Preflight | null>(null);
  const [pfError, setPfError] = useState<string | null>(null);
  const [pfLoading, setPfLoading] = useState(false);
  const [run, setRun] = useState<RunView | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sent, setSent] = useState('');
  const [compareId, setCompareId] = useViewState<string>('layerx.compare', '');
  const [compareRun, setCompareRun] = useState<RunView | null>(null);
  const [paramsOpen, setParamsOpen] = useState(false);
  const [restated, setRestated] = useState(0);
  const [storedView, setMainView] = useViewState<MainView>('layerx.view', 'burn');
  // useViewState does not validate what it reads back: a browser that last showed the trade study
  // (removed) or anything else this page no longer has would render an empty pane. Open Burn.
  const mainView: MainView = (MAIN_VIEWS as readonly string[]).includes(storedView) ? storedView : 'burn';
  // A job picked from Recent, for the Optimise / Reconcile tab to open.
  const [focusJob, setFocusJob] = useState<{ id: string; kind: string; nonce: number } | null>(null);
  const focus = (id: string, kind: string) => setFocusJob({ id, kind, nonce: Date.now() });
  const [advanced, setAdvanced] = useViewState<boolean>('layerx.advanced', false);
  // A sweep belongs to the burn it was started from: run id -> sweep id.
  const [sweepByRun, setSweepByRun] = useViewState<Record<string, string>>('layerx.sweepByRun', {});
  const [sweep, setSweep] = useState<RunView | null>(null);
  const [sweepError, setSweepError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pfSeq = useRef(0);
  const [configTick, setConfigTick] = useState(0);

  const set = <K extends keyof Stored>(key: K, value: Stored[K]) => setSettings((s) => ({ ...s, [key]: value }));

  const loadDrawings = useCallback(async () => {
    const r = await layerx.drawings();
    if (r.data) {
      setDrawings(r.data);
      setSettings((s) => (s.drawing_id && r.data!.some((d) => d.id === s.drawing_id))
        ? s
        : { ...s, drawing_id: (r.data!.find((d) => d.name === 'copv_study_gn2') ?? r.data![0])?.id ?? '' });
    }
  }, [setSettings]);
  const loadRuns = useCallback(async () => { const r = await layerx.runs(); if (r.data) setRuns(r.data); }, []);

  useEffect(() => {
    if (!isVisible) return;
    layerx.status().then((r) => r.data && setStatus(r.data));
    loadDrawings();
    loadRuns();
  }, [isVisible, loadDrawings, loadRuns]);

  // How many of this drawing's parameters this person has restated.
  useEffect(() => {
    if (!isVisible || !settings.drawing_id) return;
    layerx.parameters(settings.drawing_id).then((r) => setRestated(r.data?.overrides.length ?? 0));
  }, [isVisible, settings.drawing_id]);

  // The sweep of the burn that is open, and polling one that is going.
  const openSweepId = run ? sweepByRun[run.id] ?? '' : '';
  useEffect(() => {
    if (!isVisible) return;
    if (!openSweepId) { setSweep(null); return; }
    if (sweep?.id === openSweepId) return;
    setSweep(null);
    layerx.run(openSweepId).then((r) => { if (r.data && r.data.id === openSweepId) setSweep(r.data); });
  }, [isVisible, openSweepId, sweep?.id]);
  const sweepLive = !!sweep && (sweep.status === 'queued' || sweep.status === 'running');
  const sweepLiveId = sweepLive && sweep ? sweep.id : null;
  useEffect(() => {
    if (!sweepLiveId) return;
    return pollJob(sweepLiveId, 1000, setSweep, loadRuns);
  }, [sweepLiveId, loadRuns]);

  // Reopen the run this browser last looked at.
  useEffect(() => {
    if (!isVisible || !openRunId || run?.id === openRunId) return;
    const wanted = openRunId;
    // Only the run still wanted when its answer lands: two quick clicks must not show the first.
    layerx.run(wanted).then((r) => { if (r.data && r.data.id === wanted && openRunRef.current === wanted) setRun(r.data); });
  }, [isVisible, openRunId, run?.id]);
  // The sweep-to-burn links, kept to runs that still exist (it grew for ever in local storage).
  useEffect(() => {
    if (!runs.length) return;
    const ids = new Set(runs.map((r) => r.id));
    const kept = Object.fromEntries(Object.entries(sweepByRun).filter(([burn, sw]) => ids.has(burn) && ids.has(sw)));
    if (Object.keys(kept).length !== Object.keys(sweepByRun).length) setSweepByRun(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs]);

  useConfigChanged(useCallback(() => setConfigTick((n) => n + 1), []));

  // Preflight follows the settings, debounced. Each request is numbered so a slow answer to an
  // older question never overwrites a newer one.
  // One engine: EngineDesign's, through its card. The other modes stay in the backend for its tests.
  const payload: LayerXSettings | null = settings.drawing_id ? { ...settings, engine_model: 'card' } : null;
  const key = JSON.stringify(payload);
  useEffect(() => {
    if (!isVisible || !payload || !config) return;
    const seq = ++pfSeq.current;
    setPfLoading(true);
    const handle = setTimeout(async () => {
      const r = await layerx.preflight(payload);
      if (seq !== pfSeq.current) return;
      setPfLoading(false);
      if (r.error) { setPfError(r.error); setPf(null); } else { setPfError(null); setPf(r.data ?? null); }
    }, 650);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isVisible, configTick, config]);

  // Poll a live run, by id: a response for a run no longer open never replaces the one that is.
  const live = !!run && (run.status === 'queued' || run.status === 'running');
  const liveId = live && run ? run.id : null;
  useEffect(() => {
    if (!liveId) return;
    return pollJob(liveId, 500, setRun, loadRuns);
  }, [liveId, loadRuns]);

  // Any job of this user's still going, whatever view started it: the backend runs one at a time.
  const activeJob = runs.find((r) => r.status === 'queued' || r.status === 'running') ?? null;
  // Its progress in the tab's title, so a two-minute study can be left in another tab.
  const titlePct = activeJob ? Math.round((activeJob.progress ?? 0) * 100) : null;
  useEffect(() => {
    if (titlePct === null) return;
    const before = document.title;
    document.title = `${titlePct} % · Layer X`;
    return () => { document.title = before; };
  }, [titlePct]);
  useEffect(() => {
    if (!activeJob || !isVisible) return;
    const handle = setInterval(loadRuns, 2000);
    return () => clearInterval(handle);
  }, [activeJob, isVisible, loadRuns]);

  // The request preflights before it answers (~3 s): one click is one run.
  const [starting, setStarting] = useState(false);
  const start = async () => {
    if (!payload || starting) return;
    setRunError(null);
    setStarting(true);
    const r = await layerx.start(payload).finally(() => setStarting(false));
    if (r.error || !r.data) {
      setRunError(r.error ?? 'Could not start the run.');
      // The backend refused what the rail showed as ready: its design changed underneath (a
      // reload, another tab). Re-check so the rail says what the backend now holds.
      setConfigTick((n) => n + 1);
      return;
    }
    setOpenRunId(r.data.id);
    setMainView('burn');
    setRun({ id: r.data.id, status: r.data.status, stage: 'Starting', progress: 0, error: null, started: Date.now() / 1000,
             finished: null, design: '', settings: payload });
    loadRuns();
  };
  const cancel = async () => { if (run) await layerx.cancel(run.id); };
  const [exportError, setExportError] = useState<string | null>(null);
  const download = (text: string, filename: string, type = 'text/plain') => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportEng = async (id: string) => {
    setExportError(null);
    const r = await layerx.exportEng(id);
    if (r.error || !r.data) { setExportError(r.error ?? 'Export failed.'); return; }
    download(r.data.text, r.data.filename);
  };
  const startSweep = async () => {
    // From the burn that is open, not from whatever the rail says now.
    if (!run) return;
    const base = { ...DEFAULT_SETTINGS, ...run.settings } as LayerXSettings;
    const owner = run.id;
    setSweepError(null);
    const r = await layerx.startUncertainty(base);
    if (r.error || !r.data) { setSweepError(r.error ?? 'Could not start the sweep.'); return; }
    const id = r.data.id;
    setSweepByRun((m) => ({ ...m, [owner]: id }));
    setSweep({ id, kind: 'uncertainty', status: r.data.status, stage: 'Starting', progress: 0, error: null,
               started: Date.now() / 1000, finished: null, design: '', settings: base });
    loadRuns();
  };
  const upload = async (file: File) => {
    setUploadError(null);
    const r = await layerx.upload(file);
    if (r.error) { setUploadError(r.error); return; }
    await loadDrawings();
    if (r.data) set('drawing_id', r.data.id);
  };

  const drawing = drawings.find((d) => d.id === settings.drawing_id) ?? null;
  const derived = pf?.derived;
  const configTankPsia = useMemo(() => {
    const t = (config?.lox_tank as { initial_pressure_psi?: number } | undefined)?.initial_pressure_psi;
    return typeof t === 'number' ? t : null;
  }, [config]);
  // The burn to compare against: any other finished burn, fetched once when picked.
  useEffect(() => {
    if (!compareId || compareRun?.id === compareId) return;
    layerx.run(compareId).then((r) => {
      if (r.data && r.data.status === 'done' && (r.data.kind ?? 'run') === 'run') setCompareRun(r.data);
      else setCompareId('');
    });
  }, [compareId, compareRun?.id, setCompareId]);
  // One object per pick, not per render: the charts rebuild their merged data when it changes.
  const runId = run?.id;
  const reference = useMemo(() => (compareId && compareRun?.id === compareId && compareId !== runId && compareRun.result
    ? { label: runLabel(compareRun), result: compareRun.result as LayerXResult } : null), [compareId, compareRun, runId]);

  if (!config) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--color-border)] px-6 py-14 text-center text-sm text-[var(--color-text-secondary)]" style={SANS}>
        Load an engine design first. Layer X burns the live design through a feed-system drawing.
      </div>
    );
  }
  if (status && !status.feedtwin.available) {
    return (
      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-8 text-sm" style={SANS}>
        <div className="text-[var(--color-text-primary)]">The feed-system library is not installed in this backend.</div>
        <div className="mt-2 text-[var(--color-text-muted)]">Install it with <code className="text-[var(--color-text-secondary)]">pip install -e lib/feedtwin</code> and restart. ({status.feedtwin.error})</div>
      </div>
    );
  }

  const result = run?.status === 'done' && (run.kind ?? 'run') === 'run' ? (run.result as LayerXResult | null) ?? null : null;
  // The design's vehicle on the rail: the last flight's own total when it flew the design's
  // airframe, otherwise the config's empty vehicle plus the propellant (the gas is not known yet).
  const lastBudget = result?.flight?.ok ? result.flight.mass_budget : null;
  const designLiftoffExact = lastBudget && lastBudget.airframe_source === 'config' ? lastBudget.liftoff_kg : null;
  const dryKg = typeof derived?.vehicle_dry_kg === 'number' ? derived.vehicle_dry_kg : null;
  const propKg = derived?.loads_kg ? Object.values(derived.loads_kg as Record<string, number>).reduce((a, b) => a + b, 0) : null;
  const designLiftoffKg = designLiftoffExact ?? (dryKg !== null && propKg !== null ? dryKg + propKg : null);
  const designLiftoffApprox = designLiftoffExact === null;
  const sweepResult = sweep?.status === 'done' && sweep.id === openSweepId ? (sweep.result as SweepResult | null) ?? null : null;
  const uncertainty = {
    summary: sweepLive && sweep
      ? <>sweeping: {sweep.stage} ({fmt(sweep.progress * 100, 0)} %)</>
      : sweepResult
        ? <>impulse ± {fmt(sweepResult.band.total_impulse_Ns, 0)} N·s · largest: {sweepResult.factors[0]?.label ?? '—'}</>
        : sweep?.status === 'failed' ? <span style={{ color: STATUS_COLOR.fail }}>sweep failed</span> : 'not swept yet',
    node: (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={startSweep} disabled={!!sweepLive || !!activeJob || !run}
                  title={activeJob ? `A ${activeJob.kind ?? 'run'} is going; the backend runs one at a time.` : undefined}
                  className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] disabled:opacity-40">
            {sweepLive ? 'Sweeping…' : sweepResult ? 'Sweep again' : 'Sweep the unmeasured inputs'}
          </button>
          <Hint text="Each unmeasured input low and high, one at a time, in parallel. Sweeps this burn's settings on the pad and without the erosion replay, so its nominal is not this burn's headline: the band and the ranking are what to read.">
            <span className="text-[12px] text-[var(--color-text-muted)]">about a minute</span>
          </Hint>
          {sweepError && <span className="text-[12px] text-[var(--color-danger)]">{sweepError}</span>}
          {sweep?.status === 'failed' && <span className="text-[12px] text-[var(--color-danger)]">{sweep.error}</span>}
        </div>
        {sweepLive && sweep && (
          <div className="h-1 max-w-md overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
            <div className="h-full bg-[var(--color-accent)] transition-[width] duration-300" style={{ width: `${Math.max(sweep.progress, 0.02) * 100}%` }} />
          </div>
        )}
        {sweepResult ? <UncertaintyView sweep={sweepResult} /> : !sweepLive && (
          <p className="max-w-xl text-[13px] text-[var(--color-text-muted)]">
            Burns each input nobody has measured (valve Cv, line losses, nozzle efficiency, the thermal models…) at its low and
            high value, and ranks which ones move impulse, thrust, O/F and the margins most.
          </p>
        )}
      </div>
    ),
  };
  // The burn on screen against the rail and the design now.
  const drawingName = (id: string) => drawings.find((d) => d.id === id)?.name ?? id.slice(0, 8);
  const changedSettings = result && run && payload ? settingsDiff({ ...DEFAULT_SETTINGS, ...run.settings } as LayerXSettings, payload, drawingName) : [];
  const restatedKey = (list: unknown) => JSON.stringify(((list ?? []) as { origin?: string; key?: string; value?: number }[])
    .filter((o) => o.origin !== 'vehicle').map((o) => [o.key, o.value]).sort());
  const restatedMoved = !!(result && pf?.derived && restatedKey(result.provenance.derived?.overrides) !== restatedKey(pf.derived.overrides));
  const changed = restatedMoved ? [...changedSettings, 'measured values'] : changedSettings;
  // A what-if ran on a modified copy of the design on purpose: its hash differs, and that is not "moved".
  const whatIf = run?.settings?.design_patch ?? null;
  const designMoved = !whatIf && !!(result && pf?.derived?.config_sha256 && result.provenance.config_sha256 !== pf.derived.config_sha256);
  // Only a settled preflight vouches for the design: one still in flight (a design just loaded) or
  // one that failed says nothing, so nothing is handed on or written until it has spoken.
  const designUnknown = !pf?.derived?.config_sha256 || pfLoading;
  // A preflight still settling does not block the click: the server preflights the run itself.
  const canRun = !!pf?.ok && !live && !activeJob && !starting;

  const burns = runs.filter((r) => (r.kind ?? 'run') === 'run');
  // The open run as the list knows it too: the list carries its drawing, name and pin.
  const listed = run ? runs.find((x) => x.id === run.id) : undefined;
  const openMeta = listed?.meta ?? run?.meta;
  const openRun = run ? { ...run, drawing: run.drawing ?? listed?.drawing, meta: openMeta } : null;
  const whatIfHoles = whatIf ? ['oxidizer', 'fuel'].map((k) => {
    const d = (whatIf as Record<string, { d_jet?: number }>)[k]?.d_jet;
    return d ? `${k === 'oxidizer' ? 'LOX' : 'fuel'} ${fmt(d * 1000, 3)} mm` : null;
  }).filter(Boolean).join(', ') : '';
  const sendNote = whatIf ? 'A what-if: these holes are not the design’s. Write them into the design on the Injector tab first.'
    : designMoved ? 'Made on an older version of the design. Run it again first.'
    : designUnknown ? 'Checking the design…' : 'Forward mode and the Flight tab use this burn.';
  const MODES = [['burn', 'Burn'], ['optimise', 'Optimise'], ['reconcile', 'Injector holes']] as const;
  const activeWord = activeJob ? KIND_WORD[activeJob.kind ?? 'run'] ?? 'run' : '';

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[18rem_minmax(0,1fr)]" style={SANS}>
      {/* ---------------------------------------------------------------- setup rail */}
      <aside className="space-y-5 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto lg:pr-2">
        <Group title="Feed system">
          {settings.drawing_id && (
            <ParametersPanel drawingId={settings.drawing_id} open={paramsOpen} onClose={() => setParamsOpen(false)}
                             onSaved={(n) => { setRestated(n); setConfigTick((t) => t + 1); }} />
          )}
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden"
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
          <select className={field} value={settings.drawing_id} onChange={(e) => set('drawing_id', e.target.value)} aria-label="Feed system drawing">
            {drawings.length === 0 && <option value="">No drawings found</option>}
            {drawings.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
            <button type="button" onClick={() => setPicking((p) => !p)} className="text-[var(--color-accent)] hover:underline">From pid-designer</button>
            <button type="button" onClick={() => fileRef.current?.click()} className="text-[var(--color-accent)] hover:underline">Upload</button>
          </div>
          {picking && <PidPicker onClose={() => setPicking(false)} onImported={async (d) => { setPicking(false); await loadDrawings(); set('drawing_id', d.id); }} />}
          {uploadError && <div className="text-[12px] text-[var(--color-danger)]">{uploadError}</div>}
          {drawing && <DrawingFacts d={drawing} />}
          {drawing && (
            <button type="button" onClick={() => setParamsOpen(true)}
                    className="flex w-full items-center justify-between rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]">
              <span>Measured values</span>
              <span className={restated ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}>{restated ? `${restated} in use` : 'none'}</span>
            </button>
          )}
        </Group>

        <Group title="Before firing">
          <NumberField label="Tank pressure" unit="psia" value={settings.tank_pressure_psia}
                       placeholder={configTankPsia !== null ? `${fmt(configTankPsia, 0)} (design)` : 'design'}
                       onChange={(v) => set('tank_pressure_psia', v)}
                       hint={<>What the regulator holds the tanks at before Fire (its lockup). Once propellant flows the tanks sag below it.{derived?.dome_psig !== undefined ? <> Set the dome to {fmt(derived.dome_psig as number, 1)} psig for this.</> : null}</>} />
          <NumberField label="Bottle fill" unit="psig" value={settings.copv_pressure_psig}
                       placeholder={derived?.copv_drawn_psig !== undefined && derived?.copv_drawn_psig !== null ? `${fmt(derived.copv_drawn_psig as number, 0)} (drawing)` : 'drawing'}
                       onChange={(v) => set('copv_pressure_psig', v)}
                       hint="The pressurant bottle's gauge at T-0." />
          <div>
            <div className="mb-1 text-[12px] text-[var(--color-text-secondary)]">
              <Hint text="The gas in the bottle and everything it presses, swapped on the drawing for this burn. The regulator's droop and line data stay as measured with the drawing's own gas.">
                <span>Pressurant</span>
              </Hint>
            </div>
            <Segmented label="Pressurant" value={(settings.pressurant ?? 'drawn') as 'drawn' | 'nitrogen' | 'helium'}
                       onChange={(v) => set('pressurant', v === 'drawn' ? null : v)}
                       options={[{ value: 'drawn', label: 'As drawn' }, { value: 'nitrogen', label: 'GN2' }, { value: 'helium', label: 'Helium' }]} />
          </div>
          {derived?.loads_kg && derived.roles && settings.load === 'config' && (
            <div className="flex justify-between text-[12px] tabular-nums">
              <Hint text="The design's propellant load, fixed by the competition. Change it under Advanced."><span className="text-[var(--color-text-secondary)]">Propellant</span></Hint>
              <span><span style={{ color: LOX }}>{fmt(derived.loads_kg[derived.roles.oxidiser], 2)}</span> + <span style={{ color: FUEL }}>{fmt(derived.loads_kg[derived.roles.fuel], 2)}</span> <span className="text-[var(--color-text-muted)]">kg</span></span>
            </div>
          )}
        </Group>

        <Group title="Simulate">
          <Toggle label="Nozzle erosion" checked={settings.replay ?? true} onChange={(v) => set('replay', v)}
                  hint="The throat and liner wear away during the burn, as EngineDesign models them. Off: the nozzle as built." />
          <Toggle label="Flight" checked={settings.flight ?? false} onChange={(v) => set('flight', v)}
                  hint="Fly it. The vehicle's acceleration (8–9 g) presses on every column of liquid, which changes what the injector sees. Adds apogee. About 45 s." />
          {(settings.flight ?? false) && (
            <NumberField label="Liftoff mass" unit={settings.liftoff_mass_kg ? `lb · ${fmt(settings.liftoff_mass_kg, 1)} kg` : 'lb'}
                         value={settings.liftoff_mass_kg ? Math.round((settings.liftoff_mass_kg / LB) * 10) / 10 : null}
                         placeholder={designLiftoffKg !== null ? `${designLiftoffApprox ? '≈ ' : ''}${fmt(designLiftoffKg / LB, 0)} (design)` : 'design'}
                         onChange={(v) => set('liftoff_mass_kg', v !== null && v > 0 ? v * LB : null)}
                         hint="The vehicle on the rail, loaded and pressed. The airframe takes up whatever the engine, tanks, propellant and gas do not, so the flight and the acceleration it feeds back into the burn are at this mass. Blank: the design's airframe." />
          )}
        </Group>

        <Fold title="Advanced" open={advanced} onToggle={() => setAdvanced((v) => !v)}>
          <div>
            <div className="mb-1 text-[12px] text-[var(--color-text-secondary)]">Propellant load</div>
            <Segmented label="Propellant load" value={settings.load} onChange={(v) => set('load', v)} options={[
              { value: 'config', label: 'Design', hint: "The design's propellant masses" },
              { value: 'fill', label: 'Fill to level', hint: "A fraction of each tank's volume" },
            ]} />
            {settings.load === 'fill' && (
              <div className="mt-2"><NumberField label="Fill fraction" unit="of volume" value={settings.fill_fraction} onChange={(v) => set('fill_fraction', v ?? 0.95)} /></div>
            )}
          </div>
          <NumberField label="Unusable propellant" unit="kg per tank" value={settings.dry_kg} placeholder="0.001"
                       onChange={(v) => set('dry_kg', v === null || v < 0.0005 ? 0.001 : v)}
                       hint="What the sump and lines keep when a tank stops feeding. Default burns the tanks dry; enter what you weighed after a firing." />
          <Toggle label="Ullage collapse" checked={!!settings.ullage_collapse} onChange={(v) => set('ullage_collapse', v)}
                  hint="Warm pressurant losing heat into the propellant." />
          <Toggle label="Propellant vapour" checked={!!settings.ullage_vapour} onChange={(v) => set('ullage_vapour', v)}
                  hint="Boil-off into the ullage; matters for LOX on a long hold." />
          <Toggle label="Line-wall heat" checked={!!settings.line_walls} onChange={(v) => set('line_walls', v)}
                  hint="Tubes and fittings warming the pressurant. Needs wall data on the drawing." />
          <NumberField label="Tank wall heat transfer" unit="W/m²·K" value={settings.chilldown} onChange={(v) => set('chilldown', v ?? 0)}
                       hint="Liquid to tank wall (chilldown). Zero is the benchmarked setting." />
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-[var(--color-text-secondary)]">Time step</span>
              <select className={field} value={settings.dt} onChange={(e) => set('dt', Number(e.target.value))}>
                <option value={0.01}>10 ms</option><option value={0.02}>20 ms</option><option value={0.05}>50 ms</option><option value={0.1}>100 ms</option>
              </select>
            </label>
            <NumberField label="Max burn" unit="s" value={settings.horizon_s} onChange={(v) => set('horizon_s', v ?? 14)} />
          </div>
          <NumberField label="Loaded before T-0" unit="s" value={settings.hold_s} onChange={(v) => set('hold_s', v ?? 300)}
                       hint="How long the tanks sat loaded: sets the starting wall temperatures." />
        </Fold>

        {pf && !pf.ok && (
          <Group title="Blocking the run">
            <PreflightList pf={pf} loading={pfLoading} error={pfError} />
          </Group>
        )}

        <div className="sticky bottom-0 -mx-1 bg-[var(--color-bg-primary)] px-1 pb-1 pt-3">
          <button type="button" onClick={start} disabled={!canRun}
                  className="w-full rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40">
            {live ? 'Burning…' : activeJob ? `A ${activeWord} is running…` : 'Run burn'}
          </button>
          {runError && <div className="mt-2 text-[12px] text-[var(--color-danger)]">{runError}</div>}
          {(pfError || (pf && pf.ok)) && <div className="mt-2"><PreflightList pf={pf} loading={pfLoading} error={pfError} /></div>}
        </div>
      </aside>

      {/* ---------------------------------------------------------------- the work */}
      <main className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Layer X tool" className="inline-flex rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-0.5">
            {MODES.map(([k, label]) => (
              <button key={k} type="button" role="tab" aria-selected={mainView === k} onClick={() => setMainView(k)}
                      className={`whitespace-nowrap rounded-md px-3.5 py-1.5 text-[13px] transition-colors ${mainView === k
                        ? 'bg-[var(--color-accent)]/20 text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]'}`}>
                {label}
              </button>
            ))}
          </div>
          {activeJob && !(live && run?.id === activeJob.id) && (
            <div className="ml-auto flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)]">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" aria-hidden />
              <span className="text-[var(--color-text-primary)]">{activeWord[0].toUpperCase() + activeWord.slice(1)}</span>
              <span className="tabular-nums text-[var(--color-text-muted)]">{fmt(activeJob.progress * 100, 0)} % · <Elapsed since={activeJob.started} /></span>
              <button type="button" onClick={() => { layerx.cancel(activeJob.id).then(loadRuns); }}
                      className="rounded border border-[var(--color-border)] px-2 py-0.5 hover:text-[var(--color-text-primary)]">Cancel</button>
            </div>
          )}
          {mainView !== 'burn' && (
            <div className={activeJob && !(live && run?.id === activeJob.id) ? '' : 'ml-auto'}>
              <PastRuns kind={mainView === 'optimise' ? 'optimize' : mainView} runs={runs} onOpen={(id) => focus(id, mainView === 'optimise' ? 'optimize' : mainView)} />
            </div>
          )}
        </div>

        {mainView === 'optimise' && (
          <StudyCard>
            <Optimise payload={payload} ready={!!pf?.ok} isVisible={isVisible} busy={!!activeJob} onStarted={loadRuns} focus={focusJob?.kind === 'optimize' ? focusJob : null} onFocusUsed={() => setFocusJob(null)}
                      onApply={(patch) => { setSettings((s) => ({ ...s, ...patch })); setMainView('burn'); }} />
          </StudyCard>
        )}
        {mainView === 'reconcile' && (
          <StudyCard>
            <Reconcile payload={payload} ready={!!pf?.ok} isVisible={isVisible} busy={!!activeJob} onStarted={loadRuns}
                       onConfigUpdated={onConfigUpdated} focus={focusJob?.kind === 'reconcile' ? focusJob : null} onFocusUsed={() => setFocusJob(null)}
                       designHash={(pf?.derived?.config_sha256 as string | undefined) ?? null}
                       onOpenRun={(id) => { setMainView('burn'); setOpenRunId(id); layerx.run(id).then((x) => x.data && setRun(x.data)); }} />
          </StudyCard>
        )}

        {mainView === 'burn' && <>
          {openRun && (
            <RunBar run={openRun} burns={burns} onOpen={(id) => setOpenRunId(id)}
                    compareId={reference ? compareId : ''}
                    onCompare={(id) => { setCompareId(id); if (!id) setCompareRun(null); }}
                    onPin={() => { layerx.annotate(openRun.id, { pinned: !openMeta?.pinned }).then(loadRuns); }}
                    error={exportError}
                    actions={[
                      { label: 'CSV', note: 'Every step: pressures, flows, inventory, the eroding engine, the flight’s acceleration.', disabled: !result,
                        onClick: () => { if (result) download(burnCsv(result, openRun.id), `layerx_${openRun.id}.csv`, 'text/csv'); } },
                      { label: 'Thrust curve (.eng)', note: 'For OpenRocket: propellant, engine dry mass and size from the design at this run.', disabled: !result?.timeseries,
                        onClick: () => exportEng(openRun.id) },
                      { label: sent === openRun.id ? 'Sent to Forward & Flight ✓' : 'Send to Forward & Flight', note: sendNote,
                        disabled: !result?.timeseries || designMoved || designUnknown || !!whatIf,
                        onClick: () => { if (result?.timeseries) { saveTimeSeriesResults(result.timeseries, configFingerprint(config)); setSent(openRun.id); } } },
                    ]} />
          )}
          {whatIfHoles && result && (
            <div className="text-[12px] text-[var(--color-accent)]">What-if: holes {whatIfHoles}, not the design’s.</div>
          )}
          {result && (designMoved || changed.length > 0) && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/[0.05] px-4 py-2.5 text-[12px]">
              <span style={{ color: 'var(--color-warning)' }}>
                {designMoved ? 'The design changed since this burn' : 'This burn ran with different settings'}
                {changed.length > 0 && (
                  <Hint text={<>{changed.map((c) => <span key={c} className="block">{c}</span>)}</>}>
                    <span className="ml-1.5 text-[var(--color-text-secondary)] underline decoration-dotted underline-offset-2">{designMoved ? 'and settings: ' : ''}{changed.length} change{changed.length > 1 ? 's' : ''}</span>
                  </Hint>
                )}
              </span>
              <span className="ml-auto flex gap-2">
                {changed.length > 0 && run && (
                  <button type="button" onClick={() => setSettings({ ...DEFAULT_SETTINGS, ...run.settings, design_patch: null } as Stored)}
                          className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">Use this burn's settings</button>
                )}
                <button type="button" onClick={start} disabled={!canRun}
                        className="rounded-md border border-[var(--color-border)] px-2.5 py-1 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] disabled:opacity-40">Run again with current settings</button>
              </span>
            </div>
          )}
          {live && run && <RunProgress run={run} onCancel={cancel} />}
          {run?.status === 'failed' && (
            <div className="rounded-xl border border-[var(--color-danger)]/40 bg-[var(--color-bg-secondary)] px-6 py-5 text-sm">
              <div className="text-[var(--color-danger)]">The run failed.</div>
              <div className="mt-1 text-[12px] text-[var(--color-text-muted)]">{run.error}</div>
            </div>
          )}
          {run?.status === 'cancelled' && (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 py-5 text-sm text-[var(--color-text-secondary)]">Cancelled.</div>
          )}
          {result && openRun && (
            <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-6 pb-8 pt-3">
              <LayerXResultView key={run?.id} result={result} uncertainty={uncertainty} runId={run?.id ?? ''} onConfigUpdated={onConfigUpdated}
                                designMoved={designMoved || designUnknown} whatIf={!!whatIf} reference={reference}
                                runPanel={<RunPanel key={openRun.id} run={openRun} onChanged={loadRuns}
                                                    onDeleted={() => { setOpenRunId(''); setRun(null); loadRuns(); }} />}
                                standActions={
                                  <div className="flex flex-wrap items-center gap-4 rounded-lg border border-[var(--color-border)] px-4 py-3">
                                    <button type="button"
                                            onClick={async () => {
                                              // Opened on the click itself, so a popup blocker lets it through; filled once the channel map is in.
                                              const w = window.open('', '_blank');
                                              if (!w) { setExportError('The browser blocked the test card window.'); return; }
                                              const ch = await layerx.channels(result.provenance.drawing.id);
                                              w.document.write(testCardHtml(result, openRun, ch.data?.channels ?? {}, sweepResult));
                                              w.document.close();
                                            }}
                                            className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[13px] font-medium text-white hover:bg-[var(--color-accent-hover)]">
                                      Print test card
                                    </button>
                                    <span className="text-[12px] text-[var(--color-text-muted)]">What to dial, what each channel should read and when, and the lines not to cross. One page.</span>
                                  </div>
                                } />
            </div>
          )}
          {(!run || live) && (
            <div className={`rounded-xl border border-dashed border-[var(--color-border)] px-6 py-6 ${live ? 'opacity-60' : ''}`}>
              <FeedSchematic series={EMPTY_SERIES} cursor={0} setCursor={() => {}} empty />
              {!live && (
                <p className="mt-3 text-center text-[13px] text-[var(--color-text-muted)]">
                  Set up the burn on the left and press Run burn. {burns.length > 0 && <>Or open an earlier one:{' '}
                    <button type="button" className="text-[var(--color-accent)] hover:underline" onClick={() => setOpenRunId([...burns].sort(byPinThenNewest)[0].id)}>
                      {runLabel([...burns].sort(byPinThenNewest)[0])}
                    </button></>}
                </p>
              )}
            </div>
          )}
        </>}
      </main>
    </div>
  );
}
