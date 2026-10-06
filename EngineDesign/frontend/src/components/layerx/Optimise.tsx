import { useEffect, useMemo, useState } from 'react';
import { Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Scatter, ComposedChart } from 'recharts';
import {
  layerx,
  type LayerXSettings, type OptEvaluation, type OptimizeObjective, type OptimizeResult, type OptVariable, type RunView,
} from '../../api/layerx';
import { useViewState } from '../../lib/viewState';
import { DraftNumber } from './fields';
import { Hint } from '../Hint';
import { finite, fmt, FT, VERDICT } from './format';
import { pollJob } from './jobs';

/**
 * Phase 4 (engine/layerx/optimize.py): the feed hardware that gets the most from the fixed load.
 *
 *   form     what to search (tank pressure, bottle fill, bottle size), for what (impulse or apogee), within what
 *   answer   the winner, verified the way a Layer X run burns, against where the search started
 *   path     every burn the search made, in order; feasible ones filled
 */

const axisTick = { fill: 'var(--color-text-muted)', fontSize: 10 };
const tooltipStyle = { background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 };

type Bounds = Record<string, { enabled: boolean; lo: number; hi: number }>;
type Form = { objective: OptimizeObjective; bounds: Bounds; boundsFor?: string; margin: number; stiffness: boolean; ofBand: string; budget: number };
const DEFAULT_FORM: Form = { objective: 'impulse', bounds: {}, margin: VERDICT.copvHeadroomPsi, stiffness: true, ofBand: '', budget: 40 };

const OBJECTIVE: Record<OptimizeObjective, { label: string; name: string; unit: string; scale: number; digits: number; hint: string }> = {
  impulse: { label: 'most impulse', name: 'Total impulse', unit: 'N·s', scale: 1, digits: 0,
             hint: 'The same total impulse a burn shows.' },
  apogee: { label: 'highest apogee', name: 'Apogee', unit: 'ft AGL', scale: FT, digits: 0,
            hint: 'Each try is flown. About four times slower.' },
};

function value(e: OptEvaluation | undefined | null, objective: OptimizeObjective): number | null {
  if (!e || e.objective === null || e.objective === undefined) return null;
  return e.objective * OBJECTIVE[objective].scale;
}

/** A constraint's number in the unit people read it in: fractions as %, apogee in feet. */
function show(c: { unit?: string | null }, v: number): string {
  if (!c.unit) return `${fmt(v * 100, 1)} %`;
  if (c.unit === 'm') return `${fmt(v * FT, 0)} ft`;
  return `${fmt(v, 0)} ${c.unit}`;
}

function Answer({ res, onApply }: { res: OptimizeResult; onApply: (x: Record<string, number>) => void }) {
  const o = OBJECTIVE[res.objective];
  const vb = res.verified?.best;
  const vs = res.verified?.start;
  const best = vb && vb.ok !== false && vb.figures ? vb : res.best;
  const start = vs && vs.ok !== false && vs.figures ? vs : res.start;
  const b = value(best, res.objective);
  const s = value(start, res.objective);
  const gain = b !== null && s !== null && s !== 0 ? (b / s - 1) * 100 : null;
  const feasible = (best.violation ?? 1) <= 1e-6;
  const vars = res.variables.filter((v) => v.enabled);
  return (
    <div className="space-y-6">
      {!feasible && (
        <div role="alert" className="rounded-md border border-[var(--color-danger)]/50 bg-[var(--color-danger)]/10 px-3 py-2 text-[13px] text-[var(--color-danger)]">
          ✗ No setting met every limit. The closest is shown: {best.constraints.filter((c) => !c.ok).map((c) => c.label).join(', ')}.
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-5">
        <div>
          <Hint text={o.hint}><span className="text-xs text-[var(--color-text-secondary)]">{o.name}</span></Hint>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-[1.8rem] leading-none font-semibold tracking-tight tabular-nums text-[var(--color-text-primary)]">{fmt(b, o.digits)}</span>
            <span className="text-sm text-[var(--color-text-secondary)]">{o.unit}</span>
          </div>
          <div className="mt-1.5 text-[11px] tabular-nums text-[var(--color-text-muted)]">
            {gain !== null ? <>{gain >= 0 ? '+' : ''}{fmt(gain, 2)} % from {fmt(s, o.digits)}</> : '—'}
          </div>
        </div>
        {vars.map((v) => (
          <div key={v.key}>
            <span className="text-xs text-[var(--color-text-secondary)]">{v.label}</span>
            <div className="mt-1 flex items-baseline gap-1.5">
              <span className="text-[1.8rem] leading-none font-semibold tracking-tight tabular-nums text-[var(--color-text-primary)]">
                {fmt(best.x[v.key], v.unit === 'L' ? 2 : 0)}
              </span>
              <span className="text-sm text-[var(--color-text-secondary)]">{v.unit}</span>
            </div>
            <div className="mt-1.5 text-[11px] tabular-nums text-[var(--color-text-muted)]">
              was {fmt(v.start, v.unit === 'L' ? 2 : 0)}
              {v.key === 'lockup_psia' && best.dome_psig !== undefined && <>, dome {fmt(best.dome_psig, 1)} psig</>}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => onApply(best.x)}
                className={feasible
                  ? 'rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)]'
                  : 'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-secondary)] hover:border-[var(--color-text-muted)]'}>
          {feasible ? 'Use these settings' : 'Use anyway'}
        </button>
        {vars.some((v) => v.key === 'copv_volume_L') && (
          <span className="text-[12px] text-[var(--color-text-muted)]">A different bottle size goes on the drawing.</span>
        )}
      </div>

      {best.figures && (
        <table className="w-full max-w-2xl text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[var(--color-text-muted)]">
              <th className="py-1 font-normal">{feasible ? 'All limits met' : 'No try met every limit'}</th>
              <th className="py-1 font-normal text-right">Value</th>
              <th className="py-1 font-normal text-right">Limit</th>
            </tr>
          </thead>
          <tbody>
            {best.constraints.map((c) => (
              <tr key={c.key} className="border-t border-[var(--color-border)]/50">
                <td className="py-1" style={{ color: c.ok ? 'var(--color-text-secondary)' : 'var(--color-danger)' }}>{c.ok ? '✓' : '✗'} {c.label}</td>
                <td className="py-1 text-right text-[var(--color-text-primary)]">
                  {c.value === undefined ? c.detail ?? '—' : show(c, c.value)}
                </td>
                <td className="py-1 text-right text-[var(--color-text-muted)]">
                  {c.limit === undefined ? '' : `${c.kind === 'min' ? '≥' : '≤'} ${show(c, c.limit)}`}
                </td>
              </tr>
            ))}
            {[
              ['Burn time', best.figures.burn_time_s, 's', 2],
              ['Mean thrust', best.figures.mean_thrust_N, 'N', 0],
              ['Chamber pressure', best.figures.pc_mean_psia, 'psia', 1],
              ['O/F', best.figures.of_mean, '', 3],
              ['Isp', best.figures.isp_mean_s, 's', 1],
              ['Left over LOX / fuel', null, '', 0],
            ].map(([label, v, unit, d]) => (
              <tr key={label as string} className="border-t border-[var(--color-border)]/50 text-[var(--color-text-muted)]">
                <td className="py-1">{label as string}</td>
                <td className="py-1 text-right text-[var(--color-text-secondary)]">
                  {label === 'Left over LOX / fuel'
                    ? `${fmt(best.figures!.ox_residual_kg, 3)} / ${fmt(best.figures!.fuel_residual_kg, 3)} kg`
                    : `${fmt(v as number | null, d as number)} ${unit}`}
                </td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Path({ res }: { res: OptimizeResult }) {
  const o = OBJECTIVE[res.objective];
  const rows = res.history.map((e, k) => {
    const v = value(e, res.objective);
    const ok = (e.violation ?? 1) <= 1e-6;
    return { k: k + 1, feasible: ok ? v : null, infeasible: ok ? null : v };
  });
  const running = res.history.reduce<(number | null)[]>((acc, e) => {
    const v = value(e, res.objective);
    const prev = acc.length ? acc[acc.length - 1] : null;
    const ok = v !== null && (e.violation ?? 1) <= 1e-6;
    acc.push(ok ? Math.max(prev ?? -Infinity, v) : prev);
    return acc;
  }, []);
  const data = rows.map((r, i) => ({ ...r, best: running[i] }));
  const vars = res.variables.filter((v) => v.enabled);
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs text-[var(--color-text-secondary)]">Every try <span className="text-[var(--color-text-muted)]">{o.unit}</span></div>
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
            <XAxis dataKey="k" type="number" domain={[1, 'dataMax']} tickCount={6} axisLine={false} tickLine={false} tick={axisTick} height={18} />
            <YAxis domain={['auto', 'auto']} width={56} tick={axisTick} tickFormatter={(v: number) => fmt(v, 0)} axisLine={false} tickLine={false} tickCount={4} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={(k: number) => `burn ${k}`} formatter={(v: number, name: string) => [`${fmt(v, o.digits)} ${o.unit}`, name]} />
            <Line type="stepAfter" dataKey="best" name="best so far" dot={false} strokeWidth={1.4} stroke="var(--color-text-muted)" isAnimationActive={false} />
            <Scatter dataKey="feasible" name="within limits" fill="var(--color-text-primary)" isAnimationActive={false} />
            <Scatter dataKey="infeasible" name="breaks a limit" fill="var(--color-danger)" isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {vars.length > 0 && (
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
          {vars.map((v) => {
            // Every try against this variable: the shape of the objective along it, limits marked.
            const pts = res.history.map((e) => {
              const y = value(e, res.objective);
              const ok = (e.violation ?? 1) <= 1e-6;
              return { x: e.x[v.key], feasible: ok ? y : null, infeasible: ok ? null : y };
            }).filter((p) => p.x !== undefined);
            return (
              <div key={v.key} className="min-w-0">
                <div className="mb-1 text-xs text-[var(--color-text-secondary)]">{o.name} against {v.label.toLowerCase()} <span className="text-[var(--color-text-muted)]">{v.unit}</span></div>
                <ResponsiveContainer width="100%" height={140}>
                  <ComposedChart data={pts} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} tickCount={4} axisLine={false} tickLine={false} tick={axisTick} height={18}
                           tickFormatter={(x: number) => fmt(x, v.unit === 'L' ? 2 : 0)} />
                    <YAxis domain={['auto', 'auto']} width={56} tick={axisTick} tickFormatter={(y: number) => fmt(y, 0)} axisLine={false} tickLine={false} tickCount={3} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(x: number) => `${v.label} ${fmt(x, v.unit === 'L' ? 2 : 1)} ${v.unit}`}
                             formatter={(y: number, name: string) => [`${fmt(y, o.digits)} ${o.unit}`, name]} />
                    <Scatter dataKey="feasible" name="within limits" fill="var(--color-text-primary)" isAnimationActive={false} />
                    <Scatter dataKey="infeasible" name="breaks a limit" fill="var(--color-danger)" isAnimationActive={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })}
        </div>
      )}
      <div className="max-h-64 overflow-auto rounded border border-[var(--color-border)]">
        <table className="w-full text-[12px] tabular-nums">
          <thead className="sticky top-0 bg-[var(--color-bg-secondary)] text-left text-[var(--color-text-muted)]">
            <tr>
              <th className="px-2 py-1 font-normal">#</th>
                            {vars.map((v) => <th key={v.key} className="px-2 py-1 font-normal text-right">{v.label} <span className="text-[var(--color-text-muted)]">{v.unit}</span></th>)}
              <th className="px-2 py-1 font-normal text-right">{o.name}</th>
              <th className="px-2 py-1 font-normal">Limits</th>
            </tr>
          </thead>
          <tbody>
            {res.history.map((e, k) => {
              const bad = e.constraints.filter((c) => !c.ok);
              return (
                <tr key={k} className="border-t border-[var(--color-border)]/50">
                  <td className="px-2 py-0.5 text-[var(--color-text-muted)]">{k + 1}</td>
                                    {vars.map((v) => <td key={v.key} className="px-2 py-0.5 text-right text-[var(--color-text-secondary)]">{fmt(e.x[v.key], v.unit === 'L' ? 2 : 1)}</td>)}
                  <td className="px-2 py-0.5 text-right text-[var(--color-text-primary)]">{fmt(value(e, res.objective), o.digits)}</td>
                  <td className="px-2 py-0.5" style={{ color: bad.length ? 'var(--color-danger)' : 'var(--color-text-muted)' }}>
                    {bad.length ? bad.map((c) => c.label).join(', ') : '✓'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}



export function Optimise({ payload, ready, isVisible, onApply, busy = false, onStarted, focus = null, onFocusUsed }: {
  payload: LayerXSettings | null; ready: boolean; isVisible: boolean; onApply: (patch: Partial<LayerXSettings>) => void;
  busy?: boolean; onStarted?: () => void; focus?: { id: string; nonce: number } | null; onFocusUsed?: () => void;
}) {
  const [form, setForm] = useViewState<Form>('layerx.optimise.form.v1', DEFAULT_FORM);
  const [openId, setOpenId] = useViewState<string>('layerx.optimise.open', '');
  const [job, setJob] = useState<RunView | null>(null);
  const [vars, setVars] = useState<OptVariable[]>([]);
  const [designOf, setDesignOf] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(payload);

  useEffect(() => {
    if (!isVisible || !payload || !ready) return;
    layerx.optimizeVariables(payload).then((r) => {
      if (!r.data) { setError(r.error ?? 'Could not read the variables for this design.'); return; }
      setError(null);
      setVars(r.data.variables);
      setDesignOf(r.data.design_of);
      // Bounds typed for another design or drawing do not carry over: they are keyed by the
      // defaults the backend derives for this one.
      const fp = JSON.stringify(r.data.variables.map((v) => [v.key, v.lo, v.hi, v.start]));
      setForm((f) => (f.boundsFor === fp ? f : { ...f, bounds: {}, boundsFor: fp }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isVisible, ready]);

  // A job picked from Recent: opened once, then handed back so a remount does not re-apply it.
  useEffect(() => {
    if (!focus) return;
    setOpenId(focus.id);
    onFocusUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  useEffect(() => {
    if (!isVisible || !openId || job?.id === openId) return;
    layerx.run(openId).then((r) => { if (r.data && r.data.kind === 'optimize') setJob(r.data); });
  }, [isVisible, openId, job?.id]);
  const live = !!job && (job.status === 'queued' || job.status === 'running');
  const liveId = live && job ? job.id : null;
  useEffect(() => {
    if (!liveId) return;
    return pollJob(liveId, 1000, setJob, () => onStarted?.());
  }, [liveId, onStarted]);

  const bound = (v: OptVariable) => form.bounds[v.key] ?? { enabled: v.enabled, lo: v.lo, hi: v.hi };
  const setBound = (v: OptVariable, patch: Partial<{ enabled: boolean; lo: number; hi: number }>) =>
    setForm((f) => ({ ...f, bounds: { ...f.bounds, [v.key]: { ...bound(v), ...patch } } }));

  // Each searched variable needs a range: from below to.
  const badBounds = vars.filter((v) => { const b = bound(v); return b.enabled && !(b.hi > b.lo); });
  const start = async () => {
    if (!payload || badBounds.length) return;
    setError(null);
    const variables: Record<string, { enabled: boolean; lo: number; hi: number }> = {};
    for (const v of vars) variables[v.key] = bound(v);
    const band = form.ofBand.trim() === '' ? null : Number(form.ofBand) / 100;
    const r = await layerx.startOptimize({
      settings: payload, objective: form.objective, variables, dropout_margin_psi: form.margin, stiffness: form.stiffness,
      of_band_rel: band !== null && Number.isFinite(band) && band > 0 ? band : null, max_evaluations: form.budget,
    });
    if (r.error || !r.data) { setError(r.error ?? 'Could not start the search.'); return; }
    setOpenId(r.data.id);
    setJob({ id: r.data.id, kind: 'optimize', status: r.data.status, stage: 'Starting', progress: 0, error: null,
             started: Date.now() / 1000, finished: null, design: '', settings: payload });
    onStarted?.();
  };
  const result = useMemo(() => (job?.status === 'done' && job.kind === 'optimize' ? (job.result as OptimizeResult) : null), [job]);
  // Only what the search moved: a variable it held stays as the rail had it ("from the design").
  const apply = (x: Record<string, number>, searched: Set<string>) => {
    const patch: Partial<LayerXSettings> = {};
    if (searched.has('lockup_psia') && x.lockup_psia !== undefined) patch.tank_pressure_psia = Math.round(x.lockup_psia * 10) / 10;
    if (searched.has('copv_psig') && x.copv_psig !== undefined) patch.copv_pressure_psig = Math.round(x.copv_psig);
    onApply(patch);
  };
  const small = 'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] disabled:opacity-40';

  return (
    <div className="space-y-8">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <span className="text-[13px] text-[var(--color-text-secondary)]">Find the hardware with the</span>
          <div className="flex rounded-md border border-[var(--color-border)] p-0.5">
            {(Object.keys(OBJECTIVE) as OptimizeObjective[]).map((k) => (
              <button key={k} type="button" onClick={() => setForm((f) => ({ ...f, objective: k }))} title={OBJECTIVE[k].hint}
                      className={`rounded px-3 py-1 text-[12px] ${form.objective === k ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-muted)]'}`}>
                {OBJECTIVE[k].label}
              </button>
            ))}
          </div>
        </div>

        <table className="w-full max-w-xl text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[var(--color-text-muted)]">
              <th className="py-1 font-normal w-8" />
              <th className="py-1 font-normal">by changing</th>
              <th className="py-1 font-normal w-24">from</th>
              <th className="py-1 font-normal w-24">to</th>
            </tr>
          </thead>
          <tbody>
            {vars.map((v) => {
              const b = bound(v);
              return (
                <tr key={v.key} className="border-t border-[var(--color-border)]/50">
                  <td className="py-1.5"><input type="checkbox" checked={b.enabled} aria-label={`change ${v.label}`} onChange={(e) => setBound(v, { enabled: e.target.checked })} /></td>
                  <td className="py-1.5 pr-3 text-[var(--color-text-secondary)] whitespace-nowrap">
                    <Hint text={v.basis}><span>{v.label} <span className="text-[var(--color-text-muted)]">{v.unit} · now {fmt(v.start, v.unit === 'L' ? 2 : 0)}</span></span></Hint>
                  </td>
                  <td className="py-1 pr-2"><DraftNumber ariaLabel={`${v.label} from`} value={b.lo} disabled={!b.enabled}
                    onCommit={(t) => { const x = finite(t); if (x !== null) setBound(v, { lo: x }); }} /></td>
                  <td className="py-1 pr-2"><DraftNumber ariaLabel={`${v.label} to`} value={b.hi} disabled={!b.enabled}
                    onCommit={(t) => { const x = finite(t); if (x !== null) setBound(v, { hi: x }); }} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="space-y-2 text-[13px] text-[var(--color-text-secondary)]">
          <div className="text-[12px] text-[var(--color-text-muted)]">while keeping</div>
          <label className="flex items-center gap-2">
            <span>the bottle at least</span>
            <span className="w-16"><DraftNumber ariaLabel="Bottle margin, psi" value={form.margin}
                         onCommit={(t) => { const v = finite(t); if (v !== null && v >= 0) setForm((f) => ({ ...f, margin: v })); }} /></span>
            <Hint text="Below this the regulator can no longer hold tank pressure. The verdicts use the same number.">
              <span>psi above the tanks when the burn ends</span>
            </Hint>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.stiffness} onChange={(e) => setForm((f) => ({ ...f, stiffness: e.target.checked }))} />
            <Hint text="Each injector's pressure drop stays above the design's minimum share of chamber pressure: the margin against chug.">
              <span>each injector's pressure drop above the design minimum</span>
            </Hint>
          </label>
          <label className="flex items-center gap-2">
            <span>O/F within ±</span>
            <input className="w-16 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[12px] tabular-nums text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]" inputMode="decimal" value={form.ofBand} placeholder="any" aria-label="O/F band, percent"
                   onChange={(e) => setForm((f) => ({ ...f, ofBand: e.target.value.replace(/[^0-9.]/g, '') }))} />
            <span>% of {designOf ? fmt(designOf, 2) : 'the design O/F'}</span>
          </label>
          <label className="flex items-center gap-2 text-[12px] text-[var(--color-text-muted)]">
            <span>stop after</span>
            <span className="w-16"><DraftNumber ariaLabel="Most burns" value={form.budget}
                         onCommit={(t) => { const v = finite(t); if (v !== null) setForm((f) => ({ ...f, budget: Math.max(5, Math.min(200, Math.round(v))) })); }} /></span>
            <span>burns</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={start} disabled={!!live || busy || !ready || !vars.length || badBounds.length > 0}
                  className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40"
                  title={busy && !live ? 'Another Layer X job is going; the backend runs one at a time.' : undefined}>
            {live ? 'Searching…' : result ? 'Search again' : 'Search'}
          </button>
          {live && job && (
            <button type="button" onClick={() => layerx.cancel(job.id)} className={small}>Cancel</button>
          )}
          <button type="button" onClick={() => setForm((f) => ({ ...f, bounds: {} }))} className="text-[12px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)]">
            Reset bounds
          </button>
          <Hint text="Every try is a whole burn on the drawing with the rail's other settings. The winner is burned again in full, and those are the numbers shown.">
            <span className="text-[12px] text-[var(--color-text-muted)]">
              ~{form.objective === 'apogee' ? Math.round(form.budget * 30 / 4 / 60) : Math.max(1, Math.round(form.budget * 10 / 4 / 60))} min
            </span>
          </Hint>
          {!ready && <span className="text-[12px] text-[var(--color-warning)]">Fix what’s blocking the run first.</span>}
          {badBounds.length > 0 && <span className="text-[12px] text-[var(--color-warning)]">{badBounds.map((v) => v.label).join(', ')}: “from” must be below “to”.</span>}
          {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
          {job?.status === 'failed' && <span className="text-[12px] text-[var(--color-danger)]">{job.error}</span>}
          {job?.status === 'cancelled' && <span className="text-[12px] text-[var(--color-text-muted)]">Cancelled.</span>}
        </div>
        {live && job && (
          <div className="max-w-xl">
            <div className="mb-1 flex justify-between text-[12px] text-[var(--color-text-muted)]"><span>{job.stage}</span><span className="tabular-nums">{fmt(job.progress * 100, 0)} %</span></div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
              <div className="h-full bg-[var(--color-accent)] transition-[width] duration-300" style={{ width: `${Math.max(job.progress, 0.02) * 100}%` }} />
            </div>
          </div>
        )}
      </div>

      {result && (
        <>
          <Answer res={result} onApply={(x) => apply(x, new Set(result.variables.filter((v) => v.enabled).map((v) => v.key)))} />
          <Path res={result} />
          <div className="max-w-3xl space-y-1 text-[12px] leading-snug text-[var(--color-text-muted)]">
            {result.notes.map((n, k) => <p key={k} className="text-[var(--color-warning)]">{n}</p>)}
            <Hint text={`${result.basis} Engine card centred at ${fmt(result.card_center_psia, 0)} psia.`}>
              <span>{result.evaluations} tries, {fmt(result.wall_s / 60, 1)} min</span>
            </Hint>
          </div>
        </>
      )}
    </div>
  );
}

