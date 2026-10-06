import { useEffect, useRef, useState, type ReactNode } from 'react';
import { layerx, DEFAULT_SETTINGS, type Check, type Drawing, type PidDocument } from '../../api/layerx';
import { useViewState } from '../../lib/viewState';
import { ParametersPanel } from '../layerx/ParametersPanel';
import type { GlossaryKey } from './glossary';
import { Hint } from './pages/kit';
import { Button, Field, Menu, MenuItem, MenuLabel, Segmented, STATUS_GLYPH, STATUS_VAR, Term, Toggle } from './ui';
import { NBSP, STD_ATM_PSIA, useUnits } from './units';
import { heliumTwin, sectionsChanged, type LayerXJob, type RailSection } from './useLayerXJob';

/**
 * The left rail: setup only (docs/layerx/GUI-SPEC.md, Layout). The drawing, how the stand is set
 * before firing, what to simulate, and the advanced model switches; at its foot, what blocks the
 * run and the Run button. Collapses to a 48 px column of icons (button or `\`), each with a dot
 * when its section differs from the design.
 *
 * Every value here is view state (the run records what it used); nothing writes the design.
 */

/** The guided start points at these (data-lx-step), one per step. */
export type RailStep = 'drawing' | 'before' | 'run';

const SECTIONS: { key: RailSection; label: string; icon: ReactNode }[] = [
  { key: 'drawing', label: 'Drawing', icon: <DrawingIcon /> },
  { key: 'before', label: 'Before firing', icon: <GaugeIcon /> },
  { key: 'simulate', label: 'Simulate', icon: <SimIcon /> },
  { key: 'advanced', label: 'Advanced', icon: <SlidersIcon /> },
];

function Section({ id, title, children, aside, step, highlight }: {
  id: RailSection; title: string; children: ReactNode; aside?: ReactNode; step?: RailStep; highlight?: boolean;
}) {
  return (
    <section data-lx-section={id} data-lx-step={step} aria-labelledby={`lx-rail-${id}`}
             className={`border-b border-[var(--lx-line)] px-4 py-4 transition-[background-color] duration-300 ${highlight ? 'bg-[var(--lx-accent-soft)]' : ''}`}>
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 id={`lx-rail-${id}`} className="text-[13px] font-medium text-[var(--lx-text)]">{title}</h2>
        {aside}
      </div>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}

/** A switch with its label on the left (a glossary term when there is one), the switch on the right. */
function SwitchRow({ label, termKey, hint, checked, onChange }: {
  label: string; termKey?: GlossaryKey; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-3">
      <span className="min-w-0 truncate pl-5 text-[12px] text-[var(--lx-text-2)]">
        {termKey ? <Term k={termKey}>{label}</Term> : hint ? <Hint text={hint}>{label}</Hint> : label}
      </span>
      <Toggle label={label} hideLabel checked={checked} onChange={onChange} />
    </div>
  );
}

/**
 * The feed twin's thermal models: each on or off as the twin has it, the numbers always the twin's
 * (2026-10-03: the feed twin is the exact twin of the feed system; Layer X pulls from it). A toggle
 * left alone follows the twin; flipping it overrides the twin for this burn.
 */
function FeedTwinThermal({ twin, settings, set }: {
  twin: Record<string, number | boolean> | null; settings: LayerXJob['settings']; set: LayerXJob['set'];
}) {
  const twinOn = (k: string) => !!twin?.[k];
  const chill = typeof twin?.chilldown === 'number' && twin.chilldown > 0 ? twin.chilldown : null;
  const row = (label: string, termKey: GlossaryKey, key: 'ullage_collapse' | 'ullage_vapour' | 'line_walls', note?: string) => {
    const mine = settings[key];
    return (
      <SwitchRow key={key} label={label} termKey={termKey} checked={mine ?? twinOn(key)}
                 hint={note}
                 onChange={(v) => set(key, v === twinOn(key) ? null : v)} />
    );
  };
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[12px] text-[var(--lx-text-2)]">
        <span>Thermal models</span><span className="text-[11px] text-[var(--lx-text-3)]">as the feed twin has them</span>
      </div>
      {row('Ullage collapse', 'ullageCollapse', 'ullage_collapse')}
      {row('Propellant vapour', 'propellantVapour', 'ullage_vapour')}
      {row('Line and fitting heat', 'lineWallHeat', 'line_walls', 'Tubes and fittings warming the pressurant, from the walls on the drawing')}
      <SwitchRow label={`Tank wall heat${chill ? ` (${chill} W/m²K)` : ''}`} termKey="tankWallHeat"
                 checked={settings.chilldown === null || settings.chilldown === undefined ? !!chill : settings.chilldown > 0}
                 hint="Liquid to tank wall; the number is the feed twin's"
                 onChange={(v) => set('chilldown', v === !!chill ? null : v ? (chill ?? 100) : 0)} />
    </div>
  );
}

function RowLabel({ children }: { children: ReactNode }) {
  return <div className="pl-5 text-[12px] text-[var(--lx-text-2)]">{children}</div>;
}

function DrawingFacts({ d }: { d: Drawing }) {
  const u = useUnits();
  const s = d.summary;
  if (!s.readable) return <div className="pl-5 text-[12px] text-[var(--lx-bad)]">{s.error}</div>;
  const dome = s.regulators?.find((r) => r.dome_loaded);
  const litres = (v: number | null) => (v === null ? '—' : `${v.toFixed(2)}${NBSP}L`);
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 pl-5 text-[12px]">
      {s.tanks?.map((t) => (
        <div key={t.id} className="contents">
          <dt style={{ color: t.fluid === 'oxygen' ? 'var(--lx-lox)' : t.fluid === 'ethanol' ? 'var(--lx-fuel)' : 'var(--lx-text-2)' }}>
            {t.fluid === 'oxygen' ? 'LOX' : t.fluid === 'ethanol' ? 'Fuel' : t.label} tank
          </dt>
          <dd className="lx-num text-right text-[var(--lx-text-2)]">{litres(t.volume_L)}</dd>
        </div>
      ))}
      {s.bottles?.map((b) => (
        <div key={b.id} className="contents">
          <dt style={{ color: 'var(--lx-gas)' }}>Bottle, {b.fluid === 'nitrogen' ? 'GN2' : b.fluid === 'helium' ? 'helium' : b.fluid}</dt>
          <dd className="lx-num text-right text-[var(--lx-text-2)]">{litres(b.volume_L)}</dd>
        </div>
      ))}
      {dome && (
        <div className="contents">
          <dt className="text-[var(--lx-text-2)]">
            <Hint text={`Dome-loaded regulator. Supply effect ${dome.supply_coefficient ?? '—'} psi per 1000 psi of bottle drop, droop ${dome.flow_droop_psi ?? '—'} psi at full flow (from the drawing).`}>
              Dome regulator
            </Hint>
          </dt>
          <dd className="lx-num text-right text-[var(--lx-text-2)]">{dome.flow_droop_psi !== null ? `${u.fmt(u.dp(dome.flow_droop_psi))} droop` : ''}</dd>
        </div>
      )}
    </dl>
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
    <div className="rounded-[6px] border border-[var(--lx-line)] bg-[var(--lx-bg)] p-1.5">
      <div className="mb-1 flex items-center justify-between pl-1.5">
        <span className="text-[12px] text-[var(--lx-text-2)]">pid-designer drawings</span>
        <Button variant="bare" size="sm" onClick={onClose}>Close</Button>
      </div>
      {error && <div className="px-1.5 py-1 text-[12px] text-[var(--lx-warn)]">{error}</div>}
      {!docs && !error && <div className="px-1.5 py-1 text-[12px] text-[var(--lx-text-3)]">Asking pid-designer…</div>}
      <ul className="max-h-56 overflow-auto">
        {docs?.map((d) => (
          <li key={`${d.owner}/${d.id}`}>
            <button type="button" disabled={!!busy} onClick={() => take(d)}
                    className="flex w-full cursor-pointer items-baseline justify-between gap-3 rounded-[4px] px-1.5 py-1 text-left text-[12px] hover:bg-[var(--lx-surface-2)] disabled:opacity-45">
              <span className="truncate text-[var(--lx-text)]">{d.name}</span>
              <span className="shrink-0 text-[var(--lx-text-3)]">{busy === d.id ? 'Importing' : d.mine ? 'yours' : d.owner}</span>
            </button>
          </li>
        ))}
        {docs && docs.length === 0 && <li className="px-1.5 py-1 text-[12px] text-[var(--lx-text-3)]">No drawings shared with you.</li>}
      </ul>
    </div>
  );
}

function CheckLine({ c, open }: { c: Check; open?: boolean }) {
  const status = c.status === 'fail' ? 'bad' : c.status === 'warn' ? 'warn' : 'ok';
  return (
    <li className="flex gap-2 text-[12px]">
      <span aria-hidden className="w-3 shrink-0 text-center font-semibold" style={{ color: STATUS_VAR[status] }}>{STATUS_GLYPH[status]}</span>
      {open
        ? <span className="min-w-0 text-[var(--lx-text)]">{c.label}<span className="mt-0.5 block text-[11px] leading-snug text-[var(--lx-text-3)]">{c.detail}</span></span>
        : <span className="min-w-0 text-[var(--lx-text-2)]"><Hint text={c.detail}>{c.label}</Hint></span>}
    </li>
  );
}

/** The preflight's nitrogen-over-LOX check (DATA-CONTRACT 7, gn2_condensation). */
export const GN2_CHECK = 'gn2_condensation';

/**
 * Nitrogen over LOX in a hot fire: a blocking error, not a note (the user: helium for hot fire,
 * nitrogen for water flows). The physical criterion is the server's sentence; the way out is
 * helium, or the explicit acknowledgement under Advanced.
 */
function Gn2Block({ check, onHelium, onAcknowledge }: { check: Check; onHelium: () => void; onAcknowledge: () => void }) {
  // The criterion and this burn's numbers up front (the server's first two sentences); the rest on demand.
  const sentences = check.detail.split(/(?<=[.;])\s+(?=[A-Z])/);
  const lead = sentences.slice(0, 2).join(' ');
  const rest = sentences.slice(2).join(' ');
  return (
    <div role="alert" aria-label="Nitrogen over LOX blocks the run" className="rounded-[6px] border px-3 py-2.5"
         style={{ borderColor: 'color-mix(in srgb, var(--lx-bad) 45%, transparent)', borderLeftWidth: 3, borderLeftColor: 'var(--lx-bad)', background: 'color-mix(in srgb, var(--lx-bad) 7%, var(--lx-surface))' }}>
      <div className="flex items-baseline gap-2 text-[12px] font-medium text-[var(--lx-text)]">
        <span aria-hidden className="font-semibold" style={{ color: 'var(--lx-bad)' }}>{STATUS_GLYPH.bad}</span>
        <Term k="gn2OverLox">Nitrogen over LOX</Term>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-[var(--lx-text-2)]">{lead}</p>
      {rest && (
        <details className="mt-1 text-[11px] leading-snug text-[var(--lx-text-3)]">
          <summary className="cursor-pointer text-[var(--lx-text-2)]">Why it blocks</summary>
          <p className="mt-1">{rest}</p>
        </details>
      )}
      <div className="mt-2 flex flex-wrap gap-1.5">
        <Button size="sm" variant="primary" onClick={onHelium}>Use helium</Button>
        <Button size="sm" onClick={onAcknowledge}>Run anyway…</Button>
      </div>
    </div>
  );
}

/** What stands between the rail and a run: blocking checks spelled out, notes behind a count. */
const HIDE_GN2 = 'lx.hideGn2Warning';
const readHidden = () => { try { return localStorage.getItem(HIDE_GN2) === '1'; } catch { return false; } };

function Preflight({ job, onAcknowledgeGn2 }: { job: LayerXJob; onAcknowledgeGn2: () => void }) {
  const [showNotes, setShowNotes] = useState(false);
  // The "run anyway" warning, once read, can be put away: the run still says it in its notes.
  const [gn2Hidden, setGn2Hidden] = useState(readHidden);
  const hideGn2 = () => { setGn2Hidden(true); try { localStorage.setItem(HIDE_GN2, '1'); } catch { /* private window */ } };
  const { pf, pfLoading, pfError } = job;
  if (pfError) return <div role="alert" className="text-[12px] text-[var(--lx-bad)]">{pfError}</div>;
  if (!pf) return <div className="text-[12px] text-[var(--lx-text-3)]">{pfLoading ? 'Checking…' : job.drawing ? 'Waiting for the design' : 'Choose a drawing'}</div>;
  const gn2 = pf.checks.find((c) => c.key === GN2_CHECK && c.status !== 'ok' && c.status !== 'info');
  const fails = pf.checks.filter((c) => c.status === 'fail' && c !== gn2);
  const notes = pf.checks.filter((c) => c.status === 'warn' && c !== gn2);
  return (
    <div className={`space-y-2 transition-opacity ${pfLoading ? 'opacity-60' : ''}`} aria-busy={pfLoading || undefined}>
      {gn2?.status === 'fail' && <Gn2Block check={gn2} onAcknowledge={onAcknowledgeGn2} onHelium={() => {
        // The helium drawing itself, not a gas swap on the nitrogen one: the rail then names the
        // drawing the run uses, and nothing else carries over from the nitrogen setup.
        const he = heliumTwin(job.drawing, job.drawings);
        if (he) job.setSettings((st) => ({ ...st, drawing_id: he, pressurant: null, ack_gn2_condensation: null }));
        else job.set('pressurant', 'helium');
      }} />}
      {gn2?.status === 'warn' && !gn2Hidden && (
        <div className="flex gap-2 text-[12px]" role="status">
          <span aria-hidden className="w-3 shrink-0 text-center font-semibold" style={{ color: 'var(--lx-warn)' }}>{STATUS_GLYPH.warn}</span>
          <span className="min-w-0 flex-1 text-[var(--lx-text)]">Nitrogen over LOX, run anyway: condensation unmodelled
            <span className="mt-0.5 block text-[11px] leading-snug text-[var(--lx-text-3)]">{gn2.detail}</span>
          </span>
          <button type="button" onClick={hideGn2} aria-label="Hide this warning" title="Hide this warning"
                  className="-mt-0.5 h-5 w-5 shrink-0 rounded text-[14px] leading-none text-[var(--lx-text-3)] hover:bg-[var(--lx-surface-2)] hover:text-[var(--lx-text)]">×</button>
        </div>
      )}
      {fails.length > 0 && (
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-[var(--lx-bad)]">{STATUS_GLYPH.bad} Blocking the run</div>
          <ul className="space-y-1.5">{fails.map((c, k) => <CheckLine key={`${c.key}-${k}`} c={c} open />)}</ul>
        </div>
      )}
      {notes.length > 0 && (
        <div>
          <Button variant="bare" size="sm" aria-expanded={showNotes} onClick={() => setShowNotes((v) => !v)} className="-ml-2">
            <span style={{ color: 'var(--lx-warn)' }} aria-hidden>{STATUS_GLYPH.warn}</span>
            {notes.length} note{notes.length > 1 ? 's' : ''} <span aria-hidden className="text-[var(--lx-text-3)]">{showNotes ? '▾' : '▸'}</span>
          </Button>
          {showNotes && <ul className="mt-1.5 space-y-1">{notes.map((c, k) => <CheckLine key={`${c.key}-${k}`} c={c} />)}</ul>}
        </div>
      )}
      {fails.length === 0 && notes.length === 0 && !gn2 && pf.ok && (
        <div className="text-[12px]" style={{ color: 'var(--lx-ok)' }}>{STATUS_GLYPH.ok} Ready</div>
      )}
    </div>
  );
}

const TIME_STEPS = [
  { value: '0.01', label: '10 ms' }, { value: '0.02', label: '20 ms' }, { value: '0.05', label: '50 ms' }, { value: '0.1', label: '100 ms' },
];

export function Rail({ job, collapsed, onToggle, highlight, onExpandTo }: {
  job: LayerXJob;
  collapsed: boolean;
  onToggle: () => void;
  /** A guided-start step whose control to light up. */
  highlight?: RailStep | null;
  /** Expand the rail and bring a section into view (the collapsed icons). */
  onExpandTo: (section: RailSection) => void;
}) {
  const u = useUnits();
  const { settings, set, derived } = job;
  const [advanced, setAdvanced] = useViewState<boolean>('layerx.advanced', false);
  const [picking, setPicking] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dots = sectionsChanged(settings, job.restated);
  // The pressurant this burn would use: the rail's swap, else the drawing's bottle.
  const gn2Pressurant = (settings.pressurant ?? job.drawing?.summary.bottles?.[0]?.fluid ?? null) === 'nitrogen';
  const [ackFlash, setAckFlash] = useState(false);
  const showAck = () => {
    setAdvanced(true);
    setAckFlash(true);
    window.setTimeout(() => {
      const el = document.querySelector<HTMLElement>('[data-lx-ack]');
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      el?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true });
    }, 30);
    window.setTimeout(() => setAckFlash(false), 1600);
  };

  const runLabel = job.live ? 'Burning…' : job.starting ? 'Starting…' : job.activeJob ? `A ${job.activeWord} is running…` : 'Run burn';

  if (collapsed) {
    return (
      <nav aria-label="Setup" className="flex h-full w-12 flex-col items-center gap-1 border-r border-[var(--lx-line)] bg-[var(--lx-surface)] py-2">
        <Button variant="bare" iconOnly aria-label="Expand the setup rail" title="Expand the rail ( \\ )" onClick={onToggle}
                aria-expanded={false}>
          <RailIcon />
        </Button>
        <div className="my-1 h-px w-6 bg-[var(--lx-line)]" />
        {SECTIONS.map((s) => (
          <Button key={s.key} variant="bare" iconOnly className="relative" onClick={() => onExpandTo(s.key)}
                  aria-label={`${s.label}${dots[s.key] ? ', changed from the design' : ''}`} title={s.label}>
            {s.icon}
            {dots[s.key] && <span aria-hidden className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--lx-accent)]" />}
          </Button>
        ))}
        <div className="mt-auto" />
        {job.pf && !job.pf.ok && (
          <span role="img" aria-label="The run is blocked" title="The run is blocked: expand the rail"
                className="text-[13px] font-semibold" style={{ color: 'var(--lx-bad)' }}>{STATUS_GLYPH.bad}</span>
        )}
      </nav>
    );
  }

  const tankScale = u.scale('pressure', { pressure: 'abs' });
  // The bottle's dial is gauge against the standard atmosphere (api/layerx.ts): psig in, psig out.
  const bottleScale = u.scale('pressure', { pressure: 'gauge', gaugeZeroPsia: STD_ATM_PSIA });
  const drawnPsig = typeof derived?.copv_drawn_psig === 'number' ? (derived.copv_drawn_psig as number) : null;
  const domePsig = typeof derived?.dome_psig === 'number' ? derived.dome_psig : null;
  const loads = derived?.loads_kg && derived.roles ? derived.loads_kg : null;

  return (
    <aside aria-label="Setup" className="flex h-full w-72 flex-col border-r border-[var(--lx-line)] bg-[var(--lx-surface)]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[var(--lx-line)] pl-4 pr-2">
        <span className="text-[12px] text-[var(--lx-text-3)]">Setup</span>
        <Button variant="bare" iconOnly size="sm" aria-label="Collapse the setup rail" title="Collapse ( \\ )" aria-expanded onClick={onToggle}>
          <RailIcon />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <Section id="drawing" title="Drawing" step="drawing" highlight={highlight === 'drawing'}>
          {job.settings.drawing_id && (
            <ParametersPanel drawingId={job.settings.drawing_id} open={paramsOpen} onClose={() => setParamsOpen(false)}
                             onSaved={(n) => job.onMeasurementsSaved(n)} />
          )}
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" aria-hidden tabIndex={-1}
                 onChange={(e) => { const f = e.target.files?.[0]; if (f) job.upload(f); e.target.value = ''; }} />
          <div className="pl-5">
            <Menu label={<span className="min-w-0 flex-1 truncate text-left">{job.drawing?.name ?? (job.drawings.length ? 'Choose a drawing' : 'No drawings found')}</span>}
                  className="w-full !justify-between" title="The feed-system drawing this burn runs on" minWidth={240}>
              <MenuLabel>Feed-system drawings</MenuLabel>
              {job.drawings.map((d) => (
                <MenuItem key={d.id} checked={d.id === settings.drawing_id} onClick={() => set('drawing_id', d.id)}
                          note={d.source.replace(/^shipped:/, 'shipped · ')}>
                  {d.name}
                </MenuItem>
              ))}
            </Menu>
          </div>
          <div className="flex flex-wrap gap-1 pl-3">
            <Button variant="bare" size="sm" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>From pid-designer</Button>
            <Button variant="bare" size="sm" onClick={() => fileRef.current?.click()}>Upload</Button>
          </div>
          {picking && (
            <PidPicker onClose={() => setPicking(false)} onImported={async (d) => { setPicking(false); await job.useDrawing(d); }} />
          )}
          {job.uploadError && <div role="alert" className="pl-5 text-[12px] text-[var(--lx-bad)]">{job.uploadError}</div>}
          {job.drawing && <DrawingFacts d={job.drawing} />}
          {job.drawing && (
            <div className="pl-5">
              <Button className="w-full !justify-between" onClick={() => setParamsOpen(true)}>
                <span>Measured values</span>
                <span className="lx-num text-[12px]" style={{ color: job.restated ? 'var(--lx-ok)' : 'var(--lx-text-3)' }}>
                  {job.restated ? `${job.restated} in use` : 'none'}
                </span>
              </Button>
            </div>
          )}
        </Section>

        <Section id="before" title="Before firing" step="before" highlight={highlight === 'before'}>
          <Field label="Tank pressure" termKey="tankPressure" scale={tankScale}
                 value={settings.tank_pressure_psia ?? job.configTankPsia}
                 defaultValue={job.configTankPsia ?? undefined}
                 placeholder="design" allowEmpty min={14.7}
                 onCommit={(v) => set('tank_pressure_psia', v === null || (job.configTankPsia !== null && Math.abs(v - job.configTankPsia) < 1e-9) ? null : v)} />
          {domePsig !== null && (
            <div className="-mt-1 flex justify-between pl-5 text-[11px] text-[var(--lx-text-3)]">
              <Term k="domeSetting">Dome</Term>
              <span className="lx-num">{u.fmt(u.p(domePsig + STD_ATM_PSIA, 'gauge', STD_ATM_PSIA))}</span>
            </div>
          )}
          <Field label="Bottle fill" termKey="bottleFill" scale={bottleScale}
                 value={(settings.copv_pressure_psig ?? drawnPsig) === null ? null : (settings.copv_pressure_psig ?? drawnPsig)! + STD_ATM_PSIA}
                 defaultValue={drawnPsig === null ? undefined : drawnPsig + STD_ATM_PSIA}
                 placeholder="drawing" allowEmpty min={STD_ATM_PSIA}
                 onCommit={(v) => {
                   const psig = v === null ? null : v - STD_ATM_PSIA;
                   set('copv_pressure_psig', psig === null || (drawnPsig !== null && Math.abs(psig - drawnPsig) < 1e-9) ? null : psig);
                 }} />
          <div className="flex items-center justify-between gap-2">
            <RowLabel>
              <Hint text="The gas in the bottle and everything it presses, swapped on the drawing for this burn. The regulator's droop and line data stay as measured with the drawing's own gas.">
                Pressurant
              </Hint>
            </RowLabel>
            <Segmented ariaLabel="Pressurant" size="sm" value={settings.pressurant ?? 'drawn'}
                       onChange={(v) => set('pressurant', v === 'drawn' ? null : v)}
                       options={[{ value: 'drawn', label: 'As drawn' }, { value: 'nitrogen', label: 'GN2' }, { value: 'helium', label: 'He' }]} />
          </div>
          {loads && settings.load === 'config' && derived?.roles && (
            <div className="flex items-baseline justify-between gap-2 text-[12px]">
              <RowLabel><Hint text="The design's propellant load, fixed by the competition. Change it under Advanced.">Propellant</Hint></RowLabel>
              <span className="lx-num whitespace-nowrap">
                <span style={{ color: 'var(--lx-lox)' }}>{(loads[derived.roles.oxidiser] ?? NaN).toFixed(2)}</span>
                <span className="text-[var(--lx-text-3)]"> + </span>
                <span style={{ color: 'var(--lx-fuel)' }}>{(loads[derived.roles.fuel] ?? NaN).toFixed(2)}</span>
                <span className="lx-unit">{NBSP}kg</span>
              </span>
            </div>
          )}
        </Section>

        <Section id="simulate" title="Simulate">
          <SwitchRow label="Nozzle erosion" termKey="throatRecession" checked={settings.replay ?? true} onChange={(v) => set('replay', v)} />
          <SwitchRow label="Flight" hint="Fly it. The vehicle's acceleration (8–9 g) presses on every column of liquid, which changes what the injector sees. Adds apogee. About 45 s."
                     checked={settings.flight ?? false} onChange={(v) => set('flight', v)} />
          {(settings.flight ?? false) && (
            <Field label="Liftoff mass" scale={u.scale('mass')}
                   value={settings.liftoff_mass_kg ?? job.designLiftoffKg}
                   defaultValue={job.designLiftoffKg ?? undefined}
                   title={job.designLiftoffApprox ? 'The design value is approximate until a flight has run on it.' : undefined}
                   placeholder="design" allowEmpty min={0.001}
                   onCommit={(v) => set('liftoff_mass_kg', v === null || v <= 0 || (job.designLiftoffKg !== null && Math.abs(v - job.designLiftoffKg) < 1e-6) ? null : v)} />
          )}
        </Section>

        <section data-lx-section="advanced" className="border-b border-[var(--lx-line)] px-4 py-3">
          <button type="button" aria-expanded={advanced} aria-controls="lx-rail-advanced" onClick={() => setAdvanced((v) => !v)}
                  className="flex w-full cursor-pointer items-center justify-between rounded-[4px] text-[13px] font-medium text-[var(--lx-text-2)] hover:text-[var(--lx-text)]">
            <span className="flex items-center gap-2">
              Advanced
              {dots.advanced && <span aria-label="changed from the defaults" className="h-1.5 w-1.5 rounded-full bg-[var(--lx-accent)]" />}
            </span>
            <span aria-hidden className="text-[11px] text-[var(--lx-text-3)]">{advanced ? '▾' : '▸'}</span>
          </button>
          {advanced && (
            <div id="lx-rail-advanced" className="mt-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <RowLabel>Propellant load</RowLabel>
                <Segmented ariaLabel="Propellant load" size="sm" value={settings.load} onChange={(v) => set('load', v)}
                           options={[{ value: 'config', label: 'Design', title: "The design's propellant masses" },
                                     { value: 'fill', label: 'Fill', title: "A fraction of each tank's volume" }]} />
              </div>
              {settings.load === 'fill' && (
                <Field label="Fill fraction" scale={u.scale('percent')} value={settings.fill_fraction} defaultValue={DEFAULT_SETTINGS.fill_fraction}
                       min={0.05} max={0.99} onCommit={(v) => set('fill_fraction', v ?? DEFAULT_SETTINGS.fill_fraction)} />
              )}
              <Field label="Unusable propellant" termKey="unusablePropellant" unit="kg" digits={3} value={settings.dry_kg}
                     defaultValue={DEFAULT_SETTINGS.dry_kg} min={0}
                     onCommit={(v) => set('dry_kg', v === null || v < 0.0005 ? 0.001 : v)} />
              <FeedTwinThermal twin={(derived?.feed_twin_thermal ?? null) as Record<string, number | boolean> | null}
                               settings={settings} set={set} />
              <div className="space-y-1.5">
                <RowLabel>Time step</RowLabel>
                <div className="pl-5">
                  <Segmented ariaLabel="Time step" size="sm" value={String(settings.dt)} onChange={(v) => set('dt', Number(v))}
                             options={TIME_STEPS.map((s) => ({ ...s, label: <span className="lx-num">{s.label}</span> }))} />
                </div>
              </div>
              <Field label="Max burn" unit="s" digits={0} value={settings.horizon_s} defaultValue={DEFAULT_SETTINGS.horizon_s} min={1}
                     onCommit={(v) => set('horizon_s', v ?? DEFAULT_SETTINGS.horizon_s)} />
              <Field label="Loaded before T−0" unit="s" digits={0} value={settings.hold_s} defaultValue={DEFAULT_SETTINGS.hold_s} min={0}
                     title="How long the tanks sat loaded: sets the starting wall temperatures."
                     onCommit={(v) => set('hold_s', v ?? DEFAULT_SETTINGS.hold_s)} />


              {/* The main valves' opening time and the tank outlets are on the drawing: not restated here. */}
              <Field label="Fuel lead" termKey="fuelLead" unit="s" digits={2} value={settings.fuel_lead_s ?? 0} defaultValue={0}
                     allowEmpty min={0} max={5}
                     onCommit={(v) => set('fuel_lead_s', v === null || v === 0 ? null : v)} />

              {gn2Pressurant && (
                <div data-lx-ack className={`rounded-[6px] transition-[background-color] duration-300 ${ackFlash ? 'bg-[var(--lx-accent-soft)]' : ''}`}>
                  <SwitchRow label="Run GN2 over LOX anyway" termKey="gn2OverLox" checked={!!settings.ack_gn2_condensation}
                             onChange={(v) => set('ack_gn2_condensation', v ? true : null)} />
                  <div className="pl-5 text-[11px] text-[var(--lx-text-3)]">Condensation into the LOX is not modelled.</div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <div data-lx-step="run"
           className={`shrink-0 space-y-3 border-t border-[var(--lx-line)] px-4 py-3 transition-[background-color] duration-300 ${highlight === 'run' ? 'bg-[var(--lx-accent-soft)]' : ''}`}>
        <Preflight job={job} onAcknowledgeGn2={showAck} />
        <Button variant="primary" className="w-full" disabled={!job.canRun} onClick={job.start}
                aria-keyshortcuts="R" title={job.canRun ? 'Run the burn ( R )' : undefined} icon={<PlayIcon />}>
          {runLabel}
        </Button>
        {job.runError && <div role="alert" className="text-[12px] text-[var(--lx-bad)]">{job.runError}</div>}
      </div>
    </aside>
  );
}

// ------------------------------------------------------------------ icons (14 px line art)

export function RailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="1.5" y="2" width="11" height="10" rx="1.5" /><path d="M5 2v10" />
    </svg>
  );
}

export function PlayIcon() {
  return <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden><path d="M2 1.2v7.6L8.6 5z" fill="currentColor" /></svg>;
}

function DrawingIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <rect x="2" y="2.5" width="4" height="6" rx="2" /><rect x="10" y="2.5" width="4" height="6" rx="2" /><path d="M4 8.5v3h8v-3M8 11.5v2.5" />
    </svg>
  );
}

function GaugeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <circle cx="8" cy="8.5" r="5.5" /><path d="M8 8.5l2.6-2.6" /><path d="M8 3v1M3 8.5h1M12 8.5h1" />
    </svg>
  );
}

function SimIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M2 13.5h12" /><path d="M3 11c2-1 3-6 5-6s3 4 5 4" />
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /><circle cx="6" cy="4.5" r="1.4" fill="var(--lx-surface)" />
      <circle cx="10.5" cy="8" r="1.4" fill="var(--lx-surface)" /><circle cx="5" cy="11.5" r="1.4" fill="var(--lx-surface)" />
    </svg>
  );
}
