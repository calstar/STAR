import { useState, type ReactNode } from 'react';
import type { Calibration, CrossCheck, EngineCheck, Provenance } from '../../../api/layerx';
import type { EngineConfig } from '../../../api/client';
import { FeedFitSummary, FeedFitView } from '../../layerx/FeedFit';
import { PSI, sig } from '../../layerx/format';
import { runWhen } from '../../layerx/runs';
import { useTimeStore } from '../time/hooks';
import { formatT } from '../time/markers';
import { diag, diagFailed, diagMissing, rawDiag, type DiagKey, type ModelInfo, type VVDiag } from '../contract';
import { Button, NotComputed, Panel, Segmented, STATUS_GLYPH, STATUS_VAR, STATUS_WORD } from '../ui';
import { NBSP, useUnits } from '../units';
import type { GradedLimit } from '../useRunData';
import { downloadExport, EXPORTS } from './exports';
import { blockWords } from './blocks';
import { Hint, Legacy, NotYet, Pairs, Table } from './kit';
import type { PageProps } from './Overview';

/**
 * Record asks "Can I trust this run?": its name and note, what the figures leave out, the events,
 * the engine fit against EngineDesign, the feed against Forward mode, the injector feed, and the
 * run's provenance down to every defaulted parameter. Compact re-implementations of the old
 * Details blocks (layerx/LayerXResult.tsx), which were not exported.
 */

const field = 'w-full rounded-[6px] border border-[var(--lx-line-strong)] bg-[var(--lx-bg)] px-2 py-1.5 text-[13px] text-[var(--lx-text)] placeholder:text-[var(--lx-text-3)] hover:border-[var(--lx-text-3)]';

function RunNote({ job }: Pick<PageProps, 'job'>) {
  const run = job.run!;
  const [name, setName] = useState(run.meta?.name ?? '');
  const [note, setNote] = useState(run.meta?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = async (meta: { name?: string; note?: string }) => setError(await job.annotate(meta));
  return (
    <Panel title="This run" right={<span>saved with the run on the server</span>} className="lg:col-span-12">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[16rem_minmax(0,1fr)_auto] md:items-start">
        <label className="block">
          <span className="mb-1 block text-[12px] text-[var(--lx-text-2)]">Name</span>
          <input className={field} placeholder={runWhen(run)} value={name} maxLength={80}
                 onChange={(e) => setName(e.target.value)} onBlur={() => { if (name !== (run.meta?.name ?? '')) void save({ name }); }}
                 onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
        </label>
        <label className="block">
          <span className="mb-1 block text-[12px] text-[var(--lx-text-2)]">Note</span>
          <textarea className={`${field} min-h-[34px]`} rows={2} maxLength={2000} placeholder="What this run was for, what it showed, what was decided"
                    value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== (run.meta?.note ?? '')) void save({ note }); }} />
        </label>
        <div className="flex items-end gap-3 md:h-full">
          <Button variant="danger" size="sm" onClick={async () => {
            if (!window.confirm('Delete this run for good?')) return;
            setError(await job.deleteRun());
          }}>Delete run</Button>
        </div>
      </div>
      {error && <div role="alert" className="mt-2 text-[12px] text-[var(--lx-bad)]">{error}</div>}
    </Panel>
  );
}

function LeftOut({ settings, setup, className }: { settings: Provenance['settings']; setup?: Record<string, unknown> | null; className: string }) {
  // What the burn ran: the feed twin's Setup (provenance.setup), else the run's own switches.
  const ran = (k: 'ullage_collapse' | 'ullage_vapour' | 'line_walls') => (setup && k in setup ? !!setup[k] : !!settings[k]);
  const off = [!ran('ullage_collapse') && 'ullage collapse', !ran('ullage_vapour') && 'propellant vapour', !ran('line_walls') && 'line-wall heat']
    .filter(Boolean) as string[];
  const dry = (settings.dry_kg ?? 0.001) <= 0.002;
  const items: [string, string][] = [
    ['Start transient', '−0.7 to −1.5 % impulse'],
    ...(dry ? [['Propellant the sump keeps', 'burnt dry here; −1.5 to −2.7 % impulse if 0.2 kg stays behind'] as [string, string]] : []),
    ...(off.length ? [[`Run without ${off.join(', ')}`, 'line walls and vapour add ~190 psi to the bottle at burnout on the 6.8 kN stand'] as [string, string]] : []),
  ];
  return (
    <Panel title="Not in these figures" className={className}>
      <ul className="space-y-2.5">
        {items.map(([k, v]) => (
          <li key={k}>
            <span className="block text-[12px] text-[var(--lx-text-2)]">{k}</span>
            <span className="block text-[11px] leading-snug text-[var(--lx-text-3)]">{v}</span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Events({ data, className }: Pick<PageProps, 'data'> & { className: string }) {
  const store = useTimeStore();
  const events = [...data.result.events].sort((a, b) => a.t - b.t);
  return (
    <Panel title="Events" right={<span className="lx-num">{events.length}</span>} className={className}>
      <Table caption="What happened during the burn, and when" head={['Time', 'Event', { sr: 'Detail' }]} align={['r', 'l', 'l']} maxHeight={260}
             rows={events.map((e) => [
               <button key="t" type="button" className="lx-num cursor-pointer rounded-[4px] px-1 text-[var(--lx-text)] hover:bg-[var(--lx-surface-2)]"
                       onClick={() => store.focus(e.t, `event-${e.kind}`)} aria-label={`Put the cursor at ${formatT(e.t)}`}>{formatT(e.t)}</button>,
               <span key="l" style={{ color: e.kind === 'warn' ? 'var(--lx-warn)' : 'var(--lx-text)' }}>{e.label}</span>,
               <span key="d" className="font-sans text-[var(--lx-text-3)]">{e.detail}</span>,
             ])} />
    </Panel>
  );
}

function EngineFit({ cal, reference, check, className }: { cal: Calibration | null; reference: Record<string, number> | null; check?: EngineCheck; className: string }) {
  const u = useUnits();
  const pct = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(d)}\u00a0%`);
  const rows: [string, string][] = [];
  if (cal?.mode === 'card' && cal.fit && cal.card) {
    const f = cal.fit;
    rows.push(
      ['Chamber pressure, held out', `${(f.envelope_closed_pc * 100).toFixed(3)} %`],
      ['Thrust, held out', `${(f.envelope_closed_thrust * 100).toFixed(3)} %`],
      ['Flow, held out', `${(f.envelope_closed_mdot * 100).toFixed(3)} %`],
      ['Whole scan', `${(f.box_closed_pc * 100).toFixed(2)} %`],
      ['Tolerance', `${(f.tolerance * 100).toFixed(1)} % · ${cal.card.within_tolerance ? 'met' : 'NOT met'}`],
      ['Samples', `${cal.card.samples} around ${u.fmt(u.p(cal.card.center_psia))}`],
    );
  } else if (cal) {
    rows.push(['Engine', cal.mode]);
  }
  if (cal?.of_range) rows.push(['Tabulated O/F', `${cal.of_range[0].toFixed(2)} – ${cal.of_range[1].toFixed(2)}`]);
  if (reference) {
    rows.push(['EngineDesign at T−0', `${u.fmt(u.p(reference.Pc / PSI))} · ${u.fmt(u.f(reference.F))}`]);
  }
  return (
    <Panel title={<Hint text="EngineDesign's injector and chamber, solved at line-exit pressure pairs around the run's and interpolated at every step; held out = against solves the card was not fitted to.">Engine fit</Hint>}
           right={check?.worst ? <span className="lx-num">worst {pct(Math.max(check.worst.pc, check.worst.mdot_O, check.worst.mdot_F), 2)}</span> : undefined}
           className={className}>
      {rows.length ? <Pairs rows={rows} /> : <NotComputed height={60} />}
      {check?.available && check.rows && check.rows.length > 0 && (
        <div className="mt-4">
          <Table caption="The burn against EngineDesign through the burn" maxHeight={220}
                 head={['t', 'Pc', 'ΔPc', 'ΔF', 'Δṁ LOX', 'Δṁ fuel']} align={['r', 'r', 'r', 'r', 'r', 'r']}
                 rows={check.rows.map((r) => [formatT(r.t), u.fmt(u.p(r.layerx?.pc)), pct(r.rel?.pc), pct(r.rel?.thrust), pct(r.rel?.mdot_O), pct(r.rel?.mdot_F)])} />
        </div>
      )}
    </Panel>
  );
}

function CrossCheckBlock({ cc, className }: { cc?: CrossCheck; className: string }) {
  const u = useUnits();
  return (
    <Panel title={<Hint text={cc?.basis ?? ''}>Feed vs Forward mode</Hint>}
           right={cc?.available && cc.t !== undefined ? <span className="lx-num">at {formatT(cc.t)}</span> : undefined} className={className}>
      {cc?.available && cc.rows ? (
        <Table caption="This burn's feed against Forward mode's feed losses" head={[{ sr: 'Quantity' }, 'Layer X', 'Forward mode', 'Difference']} align={['l', 'r', 'r', 'r']}
               rows={cc.rows.map((r) => {
                 const big = r.rel !== null && Math.abs(r.rel) > 0.02;
                 const d = r.unit === 'kg/s' || r.unit === '' ? 3 : r.unit === 's' ? 1 : r.unit === 'N' ? 0 : 1;
                 return [
                   <span key="l">{r.label}{r.unit ? <span className="lx-unit">{'\u00a0'}{r.unit}</span> : null}</span>,
                   r.layerx === null ? '—' : r.layerx.toFixed(d),
                   r.enginedesign === null ? '—' : r.enginedesign.toFixed(d),
                   <span key="d" style={{ color: big ? 'var(--lx-warn)' : 'var(--lx-text-3)' }}>{r.rel === null ? '—' : `${r.rel >= 0 ? '+' : '−'}${Math.abs(r.rel * 100).toFixed(2)}\u00a0%`}</span>,
                 ];
               })} />
      ) : <NotComputed height={60}>{cc?.error ?? 'Not computed for this run'}</NotComputed>}
      {cc?.available && cc.tank_psia_O !== undefined && (
        <div className="mt-2 text-[11px] text-[var(--lx-text-3)]">tanks <span className="lx-num">{u.fmt(u.p(cc.tank_psia_O))} / {u.fmt(u.p(cc.tank_psia_F))}</span></div>
      )}
    </Panel>
  );
}


// ------------------------------------------------------------------ conservation and convergence

const pctOf = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(d)}${NBSP}%`);

function Glyph({ limit }: { limit: GradedLimit | undefined }) {
  if (!limit || limit.info) return null;
  return <span aria-label={STATUS_WORD[limit.status]} className="mr-1.5 font-semibold" style={{ color: STATUS_VAR[limit.status] }}>{STATUS_GLYPH[limit.status]}</span>;
}

function ChecksPanel({ vv, limits }: { vv: VVDiag; limits: readonly GradedLimit[] }) {
  const u = useUnits();
  const lim = (re: RegExp) => limits.find((l) => re.test(l.key));
  const m = vv.mass;
  const sides = (['ox', 'fuel'] as const).filter((k) => m?.[k]);
  return (
    <Panel title={<Hint text="Does the run add up? Every kilogram loaded is burned, left or trapped; every kilogram of gas that left the bottle is in an ullage or vented; and the answer does not move when the step is halved or the passes repeat.">Conservation and convergence</Hint>}
           className="lg:col-span-7">
      {sides.length > 0 && (
        <Table caption="Propellant mass balance" head={[{ sr: 'Side' }, 'Loaded', 'Burned', 'Left', 'Trapped', 'Error']} align={['l', 'r', 'r', 'r', 'r', 'r']}
               rows={sides.map((k) => {
                 const x = m![k]!;
                 return [
                   <span key="s" style={{ color: k === 'ox' ? 'var(--lx-lox)' : 'var(--lx-fuel)' }}>{k === 'ox' ? 'LOX' : 'Fuel'}</span>,
                   u.fmt(u.m(x.loaded_kg ?? null)), u.fmt(u.m(x.burned_kg ?? null)), u.fmt(u.m(x.residual_kg ?? null)), u.fmt(u.m(x.trapped_kg ?? null)),
                   <span key="e"><Glyph limit={lim(/conservation|mass_error|mass_balance/)} />{pctOf(x.error_pct, 3)}</span>,
                 ];
               })} />
      )}
      <div className="mt-4">
        <Pairs rows={[
          ...(vv.pressurant ? [[<span key="g" style={{ color: 'var(--lx-gas)' }}>Gas: bottle out → ullage in + vented</span>,
            `${u.fmt(u.m(vv.pressurant.bottle_out_kg ?? null))} → ${u.fmt(u.m(vv.pressurant.ullage_in_kg ?? null))} + ${u.fmt(u.m(vv.pressurant.vented_kg ?? null))} · ${pctOf(vv.pressurant.error_pct)}`] as [ReactNode, ReactNode]] : []),
          ...(vv.energy ? [[vv.energy.basis ? <Hint key="e" text={vv.energy.basis}>Energy balance</Hint> : 'Energy balance', pctOf(vv.energy.error_pct)] as [ReactNode, ReactNode]] : []),
          ...(vv.dt_check ? [[`Half the step (${vv.dt_check.half_dt_s ?? '—'} s)`, `impulse ${pctOf(vv.dt_check.impulse_delta_pct as number | null | undefined, 3)}`] as [ReactNode, ReactNode]] : []),
        ]} />
      </div>
      {vv.convergence && vv.convergence.length > 0 && (
        <div className="mt-4">
          <Table caption="What each pass changed" head={['Pass', 'Throat history moved', 'Acceleration moved']} align={['l', 'r', 'r']}
                 rows={vv.convergence.map((c) => [c.pass, c.throat_residual === null || c.throat_residual === undefined ? '—' : `${(c.throat_residual * 100).toFixed(3)}${NBSP}%`,
                   c.accel_residual === null || c.accel_residual === undefined ? '—' : `${(c.accel_residual * 100).toFixed(3)}${NBSP}%`])} />
        </div>
      )}
    </Panel>
  );
}

function ExportsPanel({ job, className }: Pick<PageProps, 'job'> & { className: string }) {
  const [note, setNote] = useState<string | null>(null);
  const id = job.run?.id;
  return (
    <Panel title="Exports" className={className}>
      <ul className="space-y-1">
        {EXPORTS.map((e) => (
          <li key={e.fmt} className="flex items-center justify-between gap-3">
            <Hint text={e.note} className="text-[12px] text-[var(--lx-text-2)]">{e.label}</Hint>
            <Button size="sm" disabled={!id} onClick={async () => { if (id) setNote(await downloadExport(id, e.fmt)); }}>Download</Button>
          </li>
        ))}
        <li className="flex items-center justify-between gap-3">
          <Hint text="For OpenRocket: propellant, dry mass and size from the design" className="text-[12px] text-[var(--lx-text-2)]">Thrust curve (.eng)</Hint>
          <Button size="sm" disabled={!job.result?.timeseries} onClick={() => { void job.exportEng(); }}>Download</Button>
        </li>
        <li className="flex items-center justify-between gap-3">
          <Hint text="What to dial, what each channel should read and when, and the lines not to cross. One page." className="text-[12px] text-[var(--lx-text-2)]">Test card</Hint>
          <Button size="sm" onClick={() => { void job.printTestCard(); }}>Print</Button>
        </li>
      </ul>
      {(note || job.exportError) && <div role="status" className="mt-2 text-[12px] text-[var(--lx-text-3)]">{note ?? job.exportError}</div>}
    </Panel>
  );
}

function ModelsPanel({ models }: { models: { key: string; model: ModelInfo }[] }) {
  return (
    <Panel title={<Hint text="Every block of this result that rests on a model: the model, where it comes from and what it assumes (provenance.models).">Models behind this run</Hint>}
           right={<span className="lx-num">{models.length}</span>} className="lg:col-span-12">
      <Table caption="The models behind each result block" head={['Block', 'Model and source', 'Assumes']} align={['l', 'l', 'l']} maxHeight={340}
             rows={models.map(({ key, model }) => [
               <span key="b" className="whitespace-nowrap">{blockWords(key)}</span>,
               <span key="m" className="block font-sans">
                 <span className="text-[var(--lx-text)]">{model.name ?? '—'}</span>
                 {model.source && <span className="mt-0.5 block text-[11px] leading-snug text-[var(--lx-text-3)]">{model.source}</span>}
               </span>,
               model.assumptions?.length
                 ? <Hint key="a" text={model.assumptions.map((a, k) => `${k + 1}. ${a}`).join('  ')}
                         className="whitespace-nowrap font-sans text-[var(--lx-text-2)]">{model.assumptions.length} assumption{model.assumptions.length > 1 ? 's' : ''}</Hint>
                 : <span key="a" className="whitespace-nowrap font-sans text-[var(--lx-text-3)]">none listed</span>,
             ])} />
    </Panel>
  );
}

/** A long record in a box that scrolls (a Tab stop, so the keyboard can scroll it too). */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  // Named apart from its panel: two regions with one name are one landmark twice to a screen reader.
  return <div className="max-h-[300px] min-w-0 overflow-y-auto pr-1" tabIndex={0} role="region" aria-label={`Every ${label.toLowerCase()}`}>{children}</div>;
}

const SOURCE_LABEL: Record<string, string> = { default: 'Default', estimated: 'Estimated', manufacturer: 'Datasheet', measured: 'Measured', drawing: 'Drawing' };

function kv(obj: Record<string, unknown>): [string, string][] {
  return Object.entries(obj)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .map(([k, v]) => [k, typeof v === 'number' ? (Number.isInteger(v) ? String(v) : sig(v)) : String(v)]);
}

function ProvenanceBlock({ p }: { p: Provenance }) {
  const [all, setAll] = useState<'defaults' | 'all'>('defaults');
  const defaults = p.assembly.assumptions.filter((a) => a.source === 'default');
  const rows = all === 'all' ? p.assembly.assumptions : defaults;
  const short = (h: string) => (h ? h.slice(0, 12) : '—');
  return (
    <>
      <Panel title="Run record" className="lg:col-span-4">
        <Pairs rows={[
          ['Drawing', p.drawing.name], ['Drawing source', p.drawing.source], ['Drawing hash', short(p.drawing.sha256)],
          ['Engine config hash', short(p.config_sha256)], ['Feed network', `${p.assembly.nodes} nodes, ${p.assembly.branches} branches`],
          ['Feed model', p.feedtwin_version ? `feedtwin ${p.feedtwin_version}` : 'feedtwin'],
          ['Solve time', p.wall_s !== undefined ? `${p.wall_s.toFixed(1)} s` : '—'], ['Run', new Date(p.created * 1000).toLocaleString()],
        ]} />
      </Panel>
      <Panel title="Solver settings" right={<span className="lx-num">{kv(p.setup).length}</span>} className="lg:col-span-4">
        <Scroll label="Solver settings"><Pairs rows={kv(p.setup)} /></Scroll>
      </Panel>
      <Panel title="Burn settings" right={<span className="lx-num">{kv(p.plan).length}</span>} className="lg:col-span-4">
        <Scroll label="Burn settings"><Pairs rows={kv(p.plan)} /></Scroll>
      </Panel>
      <Panel title="Unspecified parameters" className="lg:col-span-12"
             right={<Segmented ariaLabel="Which parameters" size="sm" value={all} onChange={setAll}
                               options={[{ value: 'defaults', label: `Defaults ${defaults.length}` }, { value: 'all', label: `All assumed ${p.assembly.assumptions.length}` }]} />}>
        {rows.length ? (
          <Table caption="Parameters the drawing does not state" head={['Component', 'Parameter', 'Value', 'Basis', 'Reference']} align={['l', 'l', 'r', 'l', 'l']} maxHeight={300}
                 rows={rows.map((a) => [
                   a.component, <span key="p" className="font-sans text-[var(--lx-text-2)]">{a.parameter}</span>,
                   <span key="v">{sig(a.value)}<span className="lx-unit">{'\u00a0'}{a.unit}</span></span>,
                   <span key="s" className="font-sans" style={{ color: a.source === 'default' ? 'var(--lx-warn)' : 'var(--lx-text-3)' }}>{SOURCE_LABEL[a.source] ?? a.source}</span>,
                   <span key="r" className="block max-w-[22rem] truncate font-sans text-[var(--lx-text-3)]" title={a.reference}>{a.reference}</span>,
                 ])} />
        ) : <NotComputed height={48}>Every parameter is stated on the drawing</NotComputed>}
        {p.notes.length > 0 && (
          <div className="mt-3 text-[12px] text-[var(--lx-text-3)]"><Hint text={p.notes.join(' ')}>{p.notes.length} model assumption{p.notes.length > 1 ? 's' : ''}</Hint></div>
        )}
      </Panel>
    </>
  );
}

export function Record({ data, job, theme, onConfigUpdated }: PageProps & { onConfigUpdated?: (c: EngineConfig) => void }) {
  const r = data.result;
  const d = diag(r);
  const raw = rawDiag(r);
  // Every model block, flattened by the backend (DATA-CONTRACT 5, provenance.models); a run from
  // before that carries only the diagnostics blocks' own.
  const flat = (r.provenance as { models?: ({ block?: string } & ModelInfo)[] }).models;
  const models: { key: string; model: ModelInfo }[] = Array.isArray(flat) && flat.length
    ? flat.filter((m) => m && typeof m === 'object').map((m) => ({ key: m.block ?? '—', model: m }))
    : (Object.keys(raw) as DiagKey[])
      .map((key) => ({ key: key as string, model: (raw[key] as { model?: ModelInfo } | null)?.model }))
      .filter((x): x is { key: string; model: ModelInfo } => !!x.model && typeof x.model === 'object');
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {job.run && <RunNote key={job.run.id} job={job} />}
      {/* Rows of 7 + 5 columns, so every row ends flush whichever blocks the run carries. */}
      {d.vv || diagFailed(r, 'vv') ? (
        <>
          {d.vv
            ? <ChecksPanel vv={d.vv} limits={data.limits} />
            : <Panel title="Conservation and convergence" className="lg:col-span-7"><NotComputed height={96}>{diagMissing(r, 'vv')}</NotComputed></Panel>}
          <ExportsPanel job={job} className="lg:col-span-5" />
          <Events data={data} className="lg:col-span-7" />
          <LeftOut settings={r.provenance.settings} setup={(r.provenance as unknown as { setup?: Record<string, unknown> }).setup ?? null} className="lg:col-span-5" />
          <EngineFit cal={r.provenance.calibration} reference={r.provenance.engine_reference} check={r.engine_check} className="lg:col-span-7" />
          <CrossCheckBlock cc={r.cross_check} className="lg:col-span-5" />
        </>
      ) : (
        <>
          <ExportsPanel job={job} className="lg:col-span-5" />
          <Events data={data} className="lg:col-span-7" />
          <div className="flex min-w-0 flex-col gap-6 lg:col-span-5">
            <LeftOut settings={r.provenance.settings} setup={(r.provenance as unknown as { setup?: Record<string, unknown> }).setup ?? null} className="" />
            <CrossCheckBlock cc={r.cross_check} className="flex-1" />
          </div>
          <EngineFit cal={r.provenance.calibration} reference={r.provenance.engine_reference} check={r.engine_check} className="lg:col-span-7" />
        </>
      )}
      {models.length > 0 && <ModelsPanel models={models} />}
      {r.feed_fit && (
        <Panel title="Injector feed" right={<span className="truncate"><FeedFitSummary fit={r.feed_fit} /></span>} className="lg:col-span-12">
          <Legacy theme={theme}>
            <FeedFitView fit={r.feed_fit} runId={job.run?.id ?? ''} onConfigUpdated={onConfigUpdated}
                         designMoved={job.designMoved || job.designUnknown} whatIf={!!job.whatIf} designSha={r.provenance.config_sha256} />
          </Legacy>
        </Panel>
      )}
      <ProvenanceBlock p={r.provenance} />
      <NotYet items={[
        !d.vv && !diagFailed(r, 'vv') && 'conservation and convergence checks',
        !models.length && 'the models behind each diagnostic',
      ].filter((x): x is string => !!x)} />
    </div>
  );
}
