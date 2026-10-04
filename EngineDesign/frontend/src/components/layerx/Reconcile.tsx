import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts';
import type { EngineConfig } from '../../api/client';
import {
  layerx,
  type DesignPatch, type DrillChoice, type LayerXResult, type LayerXSettings, type ReconcilePoint, type ReconcileResult, type RunView,
} from '../../api/layerx';
import { useViewState } from '../../lib/viewState';
import { Hint } from '../Hint';
import { fmt, LOX, FUEL } from './format';
import { pollJob } from './jobs';
import { WriteReconciled } from './ReconcileWrite';

/**
 * The injector, iterated against the whole system (engine/layerx/reconcile.py):
 *
 *   1 target   thrust and O/F, the design point unless typed
 *   2 holes    solved through the drawing's feed, then picked from real drills with what each pair makes
 *   3 check    the picked holes burned on the drawing: O/F and thrust over the whole burn
 *   4 export   the design with the holes written in, as YAML, or into the design itself
 */

type Side = 'oxidizer' | 'fuel';
type Form = { thrust: string; of: string; spray: boolean };
const DEFAULT_FORM: Form = { thrust: '', of: '', spray: true };
const SIDES: [Side, string, string][] = [['oxidizer', 'LOX', LOX], ['fuel', 'Fuel', FUEL]];
const EXACT = 'exact';
const input = 'w-20 rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-1.5 py-0.5 text-[12px] tabular-nums text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]';
const button = 'rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-40';
const quiet = 'rounded-md border border-[var(--color-border)] px-3 py-1.5 text-[12px] text-[var(--color-text-primary)] hover:border-[var(--color-text-muted)] disabled:opacity-40';
const axisTick = { fill: 'var(--color-text-muted)', fontSize: 10 };
const tooltipStyle = { background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 };

const num = (t: string): number | null => {
  const v = Number(t);
  return t.trim() !== '' && Number.isFinite(v) && v > 0 ? v : null;
};
const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${fmt(v * 100, digits)} %`;

function Step({ n, title, children, aside }: { n: number; title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-baseline gap-3">
        <span className="flex h-5 w-5 items-center justify-center rounded-full border border-[var(--color-border)] text-[11px] tabular-nums text-[var(--color-text-secondary)]">{n}</span>
        <h3 className="text-[14px] font-medium text-[var(--color-text-primary)]">{title}</h3>
        {aside && <span className="ml-auto">{aside}</span>}
      </div>
      <div className="pl-8">{children}</div>
    </section>
  );
}

function Progress({ job }: { job: RunView }) {
  return (
    <div className="max-w-xl">
      <div className="mb-1 flex justify-between text-[12px] text-[var(--color-text-muted)]"><span>{job.stage}</span><span className="tabular-nums">{fmt(job.progress * 100, 0)} %</span></div>
      <div className="h-1 overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]">
        <div className="h-full bg-[var(--color-accent)] transition-[width] duration-300" style={{ width: `${Math.max(job.progress, 0.02) * 100}%` }} />
      </div>
    </div>
  );
}

/** The design point, the current holes and the picked ones, through the drawing's feed. */
function Comparison({ res, picked }: { res: ReconcileResult; picked: ReconcilePoint | null }) {
  type Row = { label: string; get: (p: ReconcilePoint) => number | null; digits: number; unit: string; scale?: number; band?: string; hint?: string };
  const rows: Row[] = [
    { label: 'Thrust', get: (p) => p.thrust_N, digits: 0, unit: 'N' },
    { label: 'O/F', get: (p) => p.of, digits: 3, unit: '' },
    { label: 'Chamber pressure', get: (p) => p.pc_psia, digits: 1, unit: 'psia' },
    { label: 'LOX ΔP/Pc', get: (p) => p.stiffness_O, digits: 1, unit: '%', scale: 100, band: 'stiffness_O' },
    { label: 'Fuel ΔP/Pc', get: (p) => p.stiffness_F, digits: 1, unit: '%', scale: 100, band: 'stiffness_F' },
    { label: 'Momentum ratio', get: (p) => p.momentum_ratio, digits: 3, unit: '', band: 'momentum_ratio',
      hint: 'Set by the two injector drops through the feed; hole size cannot move it at fixed flows.' },
    { label: 'Spray tilt', get: (p) => p.tilt_deg, digits: 2, unit: '°', hint: 'Each doublet\'s resultant from the axis; + toward the wall.' },
  ];
  const cols: [string, ReconcilePoint | null, string][] = [
    ['Design point', res.design, 'Forward mode at the lockup through the design\'s own feed_system: what the design promises.'],
    ['Current holes', res.before, 'The design\'s holes through this drawing\'s feed.'],
    ['Picked holes', picked, 'The holes picked above, through this drawing\'s feed.'],
  ];
  const ok = (v: number | null, band?: string) => {
    const b = band ? res.band[band] : undefined;
    if (v === null || !b) return true;
    return (b[0] === null || v >= b[0]) && (b[1] === null || v <= b[1]);
  };
  return (
    <table className="w-full max-w-2xl text-[12px] tabular-nums">
      <thead>
        <tr className="text-left text-[var(--color-text-muted)]">
          <th className="py-1 font-normal" />
          {cols.map(([label, , hint]) => <th key={label} className="py-1 font-normal text-right"><Hint align="right" text={hint}><span>{label}</span></Hint></th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label} className="border-t border-[var(--color-border)]/50">
            <td className="py-1 text-[var(--color-text-secondary)]">{r.hint ? <Hint text={r.hint}>{r.label}</Hint> : r.label}</td>
            {cols.map(([label, p]) => {
              const v = p ? r.get(p) : null;
              return (
                <td key={label} className="py-1 text-right"
                    style={{ color: !ok(v, r.band) ? 'var(--color-warning)' : label === 'Picked holes' ? 'var(--color-text-primary)' : 'var(--color-text-secondary)' }}>
                  {v === null || !Number.isFinite(v) ? '—' : fmt(v * (r.scale ?? 1), r.digits)} <span className="text-[var(--color-text-muted)]">{r.unit}</span>
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DrillColumn({ side, label, color, res, value, onChange }: {
  side: Side; label: string; color: string; res: ReconcileResult; value: string; onChange: (v: string) => void;
}) {
  const exact = side === 'oxidizer' ? res.after.d_O_mm : res.after.d_F_mm;
  const now = side === 'oxidizer' ? res.before.d_O_mm : res.before.d_F_mm;
  const options: (DrillChoice & { key: string })[] = [
    { key: EXACT, drill: 'Exact size', d_mm: exact, area_error: 0 },
    ...res.drill_options[side].map((d) => ({ ...d, key: d.drill })),
  ];
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-[12px]" style={{ color }}>{label} holes <span className="text-[var(--color-text-muted)]">now {fmt(now, 3)} mm</span></legend>
      <div role="radiogroup" aria-label={`${label} drill`} className="space-y-0.5">
        {options.map((o) => (
          <label key={o.key} className={`flex cursor-pointer items-baseline gap-3 rounded px-2 py-1 text-[12px] tabular-nums ${value === o.key ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]/60'}`}>
            <input type="radio" name={`drill-${side}`} checked={value === o.key} onChange={() => onChange(o.key)} className="accent-[var(--color-accent)]" />
            <span className="w-20">{o.drill}</span>
            <span className="w-20 text-right">{fmt(o.d_mm, 3)} mm</span>
            <span className="text-[var(--color-text-muted)]">{o.key === EXACT ? 'solved' : `${pct(o.area_error)} area`}</span>
            {o.d_mm < now - 1e-4 && <span className="text-[11px] text-[var(--color-warning)]">smaller: new plate</span>}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** O/F and thrust over the burn of the picked holes, against the target. */
function CheckView({ result, target }: { result: LayerXResult; target: { thrust_N: number; of: number } }) {
  const dv = result.delivered;
  const series = result.series;
  const rows = useMemo(() => {
    if (dv && dv.t.length) {
      const t0 = dv.t[0];
      return dv.t.map((t, i) => ({ t: t - t0, of: dv.mr[i], thrust: dv.thrust_N[i] }));
    }
    const fire = series.t.map((_, i) => i).filter((i) => series.firing[i]);
    const t0 = fire.length ? series.t[fire[0]] : 0;
    return fire.map((i) => ({ t: series.t[i] - t0, of: series.chamber.mr[i], thrust: series.chamber.thrust_N[i] }));
  }, [dv, series]);
  const s = result.summary;
  const meanThrust = dv?.summary.mean_thrust_N ?? s.mean_thrust_N;
  const plot = (key: 'of' | 'thrust', label: string, unit: string, ref: number, band: number, digits: number, color: string) => (
    <div>
      <div className="mb-1 text-xs text-[var(--color-text-secondary)]">{label} <span className="text-[var(--color-text-muted)]">{unit}</span>
        <span className="ml-3 text-[11px] text-[var(--color-text-muted)]">dashed: target {fmt(ref, digits)}, shaded ±{fmt(band * 100, 0)} %</span></div>
      <ResponsiveContainer width="100%" height={150}>
        <LineChart data={rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <ReferenceArea y1={ref * (1 - band)} y2={ref * (1 + band)} fill="var(--color-success)" fillOpacity={0.07} ifOverflow="extendDomain" />
          <ReferenceLine y={ref} stroke="var(--color-text-muted)" strokeDasharray="4 3" ifOverflow="extendDomain" />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickCount={5} axisLine={false} tickLine={false}
                 tick={axisTick} tickFormatter={(v: number) => `${fmt(v, 1)} s`} height={18} />
          {/* The target and its band always in view: off-target is exactly when they matter. */}
          <YAxis domain={[(lo: number) => Math.min(lo, ref * (1 - band)), (hi: number) => Math.max(hi, ref * (1 + band))]}
                 width={48} tick={axisTick} tickFormatter={(v: number) => fmt(v, key === 'of' ? 2 : 0)} axisLine={false} tickLine={false} tickCount={4} />
          <Tooltip contentStyle={tooltipStyle} labelFormatter={(t: number) => `t = ${fmt(t, 2)} s`} formatter={(v: number) => [fmt(v, digits), label]} />
          <Line type="monotone" dataKey={key} dot={false} strokeWidth={1.8} stroke={color} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
  const ofErr = s.of_mean ? s.of_mean / target.of - 1 : null;
  const fErr = meanThrust ? meanThrust / target.thrust_N - 1 : null;
  // Graded against the band the drill map draws: ±1 % O/F, ±2 % thrust.
  const off = (e: number | null, band: number) => e !== null && Math.abs(e) > band;
  const cells: [string, string, string, string, boolean?][] = [
    ['Mean O/F', fmt(s.of_mean, 3), pct(ofErr, 2), `${fmt(s.of_min, 2)}–${fmt(s.of_max, 2)} over the burn`, off(ofErr, 0.01)],
    ['Mean thrust', `${fmt(meanThrust, 0)} N`, pct(fErr, 2), 'eroding throat included', off(fErr, 0.02)],
    ['Total impulse', `${fmt((dv?.summary.total_impulse_Ns ?? s.total_impulse_Ns) / 1000, 2)} kN·s`, '', `burn ${fmt(s.burn_time_s, 2)} s`],
    ['Runs dry first', s.depleted_side === 'oxidiser' ? 'LOX' : s.depleted_side === 'fuel' ? 'Fuel' : '—', '',
     `left: LOX ${fmt(s.ox.residual_kg, 2)} kg, fuel ${fmt(s.fuel.residual_kg, 2)} kg`],
    ['Lowest ΔP/Pc', `${fmt((s.ox.stiffness_min ?? NaN) * 100, 1)} / ${fmt((s.fuel.stiffness_min ?? NaN) * 100, 1)} %`, '', 'LOX / fuel'],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-x-6 gap-y-3 text-[12px] tabular-nums">
        {cells.map(([label, value, err, sub, outside]) => (
          <div key={label}>
            <div className="text-[var(--color-text-secondary)]">{label}</div>
            <div className="mt-0.5 text-[15px] text-[var(--color-text-primary)]">{value} {err && (
              <span className="text-[12px]" style={{ color: outside ? 'var(--color-warning)' : 'var(--color-text-muted)' }}>
                {outside ? '! ' : ''}{err}
              </span>
            )}</div>
            <div className="text-[11px] text-[var(--color-text-muted)]">{sub}</div>
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
        {plot('of', 'O/F over the burn', '', target.of, 0.01, 3, 'var(--color-text-primary)')}
        {plot('thrust', 'Thrust over the burn', 'N', target.thrust_N, 0.02, 0, 'var(--color-accent)')}
      </div>
    </div>
  );
}

function download(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Every drill pair the solve priced, as thrust against O/F at the condition it solved for: the
 * design space a drill index allows. The box is the check's own tolerance (±2 % thrust, ±1 % O/F);
 * a hollow dot puts an injector's ΔP/Pc outside the design band. Clicking a dot picks both drills.
 */
/** Each side's orifice Cd ±3 % (the correlation's scatter, uncalibrated), as it moves O/F and thrust:
 * O/F goes as Cd_O/Cd_F (√2 × 3 %), total flow and so thrust as their mean (3 % / √2). */
const CD_OF = Math.SQRT2 * 0.03;
const CD_F = 0.03 / Math.SQRT2;

function DrillMap({ res, picked, onPick }: { res: ReconcileResult; picked: { oxidizer: string; fuel: string };
  onPick: (oxidizer: string, fuel: string) => void }) {
  const inBand = (v: number | null, b: (number | null)[] | undefined) =>
    v === null || !b || b[0] === null || b[0] === undefined ? true : v >= (b[0] as number) && (b[1] === null || b[1] === undefined || v <= (b[1] as number));
  const pts = res.drill_grid.map((g) => ({
    ...g, x: g.of, y: g.thrust_N,
    ok: inBand(g.stiffness_O, res.band?.stiffness_O) && inBand(g.stiffness_F, res.band?.stiffness_F),
    on: g.oxidizer === picked.oxidizer && g.fuel === picked.fuel,
  }));
  if (!pts.length) return null;
  const pick = pts.find((p) => p.on) ?? null;
  const T = res.target.thrust_N;
  const O = res.target.of;
  const xs = pts.map((p) => p.x).concat([O * 0.985, O * 1.015]);
  const ys = pts.map((p) => p.y).concat([T * 0.97, T * 1.03]);
  type P = (typeof pts)[number];
  const dot = (props: { cx?: number; cy?: number; payload?: P }) => {
    const { cx, cy, payload } = props;
    if (cx === undefined || cy === undefined || !payload) return <g />;
    const color = payload.on ? 'var(--color-accent)' : payload.ok ? 'var(--color-text-secondary)' : 'var(--color-warning)';
    return (
      <circle cx={cx} cy={cy} r={payload.on ? 5.5 : 3.6} fill={payload.ok || payload.on ? color : 'var(--color-bg-secondary)'}
              stroke={color} strokeWidth={1.4} style={{ cursor: 'pointer' }} onClick={() => onPick(payload.oxidizer, payload.fuel)} />
    );
  };
  return (
    <div className="max-w-3xl">
      <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
        <Hint text="Each LOX drill against each fuel drill, priced in Forward mode at the condition the holes were solved for. The green box is ±2 % thrust and ±1 % O/F around the target. The blue box around the pick is where it may really land while the orifice Cd is uncalibrated (±3 % each side); a cold flow shrinks it. Hollow: an injector's ΔP/Pc leaves the design band. Click a dot to pick both drills.">
          <span className="text-[12px] text-[var(--color-text-secondary)]">Every drill pair</span>
        </Hint>
        <span className="text-[11px] text-[var(--color-text-muted)]">thrust N against O/F · click to pick</span>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 6, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--color-border)" strokeOpacity={0.35} />
            <XAxis dataKey="x" type="number" name="O/F" domain={[Math.min(...xs), Math.max(...xs)]} tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                   tickFormatter={(v) => fmt(v, 2)} tickLine={false} axisLine={{ stroke: 'var(--color-border)' }} height={28}
                   label={{ value: 'O/F', position: 'insideBottomRight', offset: 0, fill: 'var(--color-text-muted)', fontSize: 10 }} />
            <YAxis dataKey="y" type="number" name="Thrust" domain={[Math.min(...ys), Math.max(...ys)]} tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }}
                   tickFormatter={(v) => fmt(v, 0)} tickLine={false} axisLine={false} width={52}
                   label={{ value: 'thrust N', angle: -90, position: 'insideLeft', offset: 4, fill: 'var(--color-text-muted)', fontSize: 10 }} />
            <ZAxis range={[40, 40]} />
            <ReferenceArea x1={O * 0.99} x2={O * 1.01} y1={T * 0.98} y2={T * 1.02} fill="var(--color-success)" fillOpacity={0.08}
                           stroke="var(--color-success)" strokeOpacity={0.4} strokeDasharray="3 3" />
            {pick && (
              // Where the picked pair may really land: each side's Cd ±3 % (uncalibrated) moves O/F
              // by up to ±4.2 % and thrust by ±2.1 %. Until a cold flow measures Cd, this is the pick.
              <ReferenceArea x1={pick.x * (1 - CD_OF)} x2={pick.x * (1 + CD_OF)} y1={pick.y * (1 - CD_F)} y2={pick.y * (1 + CD_F)}
                             fill="var(--color-accent)" fillOpacity={0.06} stroke="var(--color-accent)" strokeOpacity={0.5}
                             ifOverflow="extendDomain" />
            )}
            <Tooltip cursor={{ strokeDasharray: '3 3' }} contentStyle={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 }}
                     content={({ payload }) => {
                       const p = payload?.[0]?.payload as P | undefined;
                       if (!p) return null;
                       return (
                         <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-2 py-1.5 text-[11px] tabular-nums text-[var(--color-text-secondary)]">
                           <div className="text-[var(--color-text-primary)]">LOX {p.oxidizer} · fuel {p.fuel}</div>
                           <div>{fmt(p.thrust_N, 0)} N ({p.thrust_N >= T ? '+' : ''}{fmt((p.thrust_N / T - 1) * 100, 1)} %) · O/F {fmt(p.of, 3)} ({p.of >= O ? '+' : ''}{fmt((p.of / O - 1) * 100, 1)} %)</div>
                           <div>ΔP/Pc {fmt((p.stiffness_O ?? NaN) * 100, 1)} · {fmt((p.stiffness_F ?? NaN) * 100, 1)} % · Pc {fmt(p.pc_psia, 0)} psia</div>
                         </div>
                       );
                     }} />
            <Scatter data={pts} shape={dot} isAnimationActive={false} />
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Reconcile({ payload, ready, isVisible, busy = false, onStarted, onConfigUpdated, focus = null, onFocusUsed, designHash = null, designName = 'design', onOpenRun }: {
  payload: LayerXSettings | null; ready: boolean; isVisible: boolean; busy?: boolean; onStarted?: () => void;
  onConfigUpdated?: (config: EngineConfig) => void; focus?: { id: string; nonce: number } | null; onFocusUsed?: () => void;
  designHash?: string | null; designName?: string;
  /** Open a burn in the Burn tab, with everything it shows. */
  onOpenRun?: (id: string) => void;
}) {
  const [form, setForm] = useViewState<Form>('layerx.reconcile.form.v1', DEFAULT_FORM);
  const [openId, setOpenId] = useViewState<string>('layerx.reconcile.open', '');
  const [job, setJob] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The drills picked and the burn that checked them, per solve: kept across tab switches and
  // reloads, so opening the check in full and coming back finds them where they were.
  const [sel, setSel] = useViewState<{ job: string; oxidizer: string; fuel: string; check: string }>(
    'layerx.reconcile.sel.v1', { job: '', oxidizer: EXACT, fuel: EXACT, check: '' });
  const picks = useMemo<Record<Side, string>>(() => ({ oxidizer: sel.oxidizer, fuel: sel.fuel }), [sel.oxidizer, sel.fuel]);
  const setPicks = (f: (p: Record<Side, string>) => Record<Side, string>) =>
    setSel((v) => ({ ...v, ...f({ oxidizer: v.oxidizer, fuel: v.fuel }), check: '' }));
  const [check, setCheck] = useState<RunView | null>(null);
  const [withFeed, setWithFeed] = useState(true);
  const [exportError, setExportError] = useState<string | null>(null);

  // A job picked from Recent: opened once, then handed back so a remount does not re-apply it.
  useEffect(() => {
    if (!focus) return;
    setOpenId(focus.id);
    onFocusUsed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce]);
  useEffect(() => {
    if (!isVisible || !openId || job?.id === openId) return;
    layerx.run(openId).then((r) => { if (r.data && r.data.kind === 'reconcile') setJob(r.data); });
  }, [isVisible, openId, job?.id]);
  const live = !!job && (job.status === 'queued' || job.status === 'running');
  const liveId = live && job ? job.id : null;
  useEffect(() => {
    if (!liveId) return;
    return pollJob(liveId, 1000, setJob, () => onStarted?.());
  }, [liveId, onStarted]);
  const checkLive = !!check && (check.status === 'queued' || check.status === 'running');
  const checkLiveId = checkLive && check ? check.id : null;
  useEffect(() => {
    if (!checkLiveId) return;
    return pollJob(checkLiveId, 1000, setCheck, () => onStarted?.());
  }, [checkLiveId, onStarted]);

  const solved = job?.status === 'done' && job.kind === 'reconcile' ? (job.result as ReconcileResult) : null;
  // A result saved before drill options existed cannot be picked from: it asks to be solved again.
  const legacy = !!solved && !(solved.drill_options && solved.drill_grid && solved.passage_length_m && solved.angles);
  const result = useMemo(() => (solved && !legacy ? solved : null), [solved, legacy]);
  const stale = !!(result && designHash && result.config_sha256 && designHash !== result.config_sha256);
  // New holes solved: back to the exact sizes, and the old check no longer applies.
  if (result && job && sel.job !== job.id) {
    setSel({ job: job.id, oxidizer: EXACT, fuel: EXACT, check: '' });
    if (check) setCheck(null);
  }
  // The check burn for these picks, fetched back after a tab switch or a reload.
  useEffect(() => {
    if (!sel.check || check?.id === sel.check) return;
    layerx.run(sel.check).then((r) => { if (r.data) setCheck(r.data); });
  }, [sel.check, check?.id]);

  const start = async () => {
    if (!payload) return;
    setError(null);
    const r = await layerx.startReconcile({
      settings: { ...payload, design_patch: null }, thrust_N: num(form.thrust), of: num(form.of), hold_spray_direction: form.spray,
    });
    if (r.error || !r.data) { setError(r.error ?? 'Could not start.'); return; }
    setOpenId(r.data.id);
    setJob({ id: r.data.id, kind: 'reconcile', status: r.data.status, stage: 'Starting', progress: 0, error: null,
             started: Date.now() / 1000, finished: null, design: '', settings: payload });
    onStarted?.();
  };

  // The picked holes, as a size per side and as the patch every later step uses.
  const sizes = useMemo<Record<Side, number> | null>(() => {
    if (!result) return null;
    const of = (side: Side): number | null => (picks[side] === EXACT
      ? (side === 'oxidizer' ? result.after.d_O_mm : result.after.d_F_mm)
      : result.drill_options[side].find((d) => d.drill === picks[side])?.d_mm ?? null);
    const o = of('oxidizer');
    const f = of('fuel');
    return o === null || f === null ? null : { oxidizer: o, fuel: f };
  }, [result, picks]);
  const patch = useMemo<DesignPatch | null>(() => {
    if (!result || !sizes) return null;
    const out: DesignPatch = {};
    for (const [side] of SIDES) {
      const d = sizes[side] / 1000;
      const L = result.passage_length_m[side];
      out[side] = { d_jet: d, impingement_angle: result.angles[side], ...(L ? { orifice_l_over_d: L / d } : {}) };
    }
    return out;
  }, [result, sizes]);
  const predicted = useMemo<ReconcilePoint | null>(() => {
    if (!result) return null;
    if (picks.oxidizer === EXACT && picks.fuel === EXACT) return result.after;
    const row = result.drill_grid.find((g) => g.oxidizer === picks.oxidizer && g.fuel === picks.fuel);
    if (!row) return null;
    return { ...result.after, ...row, isp_s: NaN, mdot_O: NaN, mdot_F: NaN, dp_O_psi: null, dp_F_psi: null,
             angle_O_deg: result.angles.oxidizer, angle_F_deg: result.angles.fuel };
  }, [result, picks]);
  const pickLabel = (side: Side) => (picks[side] === EXACT ? `${fmt(sizes?.[side] ?? null, 3)} mm` : picks[side]);

  const burnCheck = async () => {
    if (!payload || !patch) return;
    setError(null);
    // Checked at the condition the holes were solved for (tank pressure, pressurant, flight), not
    // whatever the rail says now; the drawing is the rail's, which preflight has already passed.
    const base: LayerXSettings = { ...payload, ...(job?.settings ?? {}), drawing_id: payload.drawing_id };
    const settings = { ...base, design_patch: patch };
    const r = await layerx.start(settings);
    if (r.error || !r.data) { setError(r.error ?? 'Could not start the check.'); return; }
    setSel((v) => ({ ...v, check: r.data!.id }));
    setCheck({ id: r.data.id, kind: 'run', status: r.data.status, stage: 'Starting', progress: 0, error: null,
               started: Date.now() / 1000, finished: null, design: '', settings });
    onStarted?.();
  };
  const checkResult = check?.status === 'done' ? (check.result as LayerXResult) : null;
  const fittedFeed = (result?.design_update as { feed_system?: Record<string, unknown> } | undefined)?.feed_system ?? null;
  const update = result && patch ? {
    injector: { geometry: Object.fromEntries(SIDES.map(([s]) => [s, { d_jet: patch[s]!.d_jet, impingement_angle: patch[s]!.impingement_angle }])) },
    ...(SIDES.some(([s]) => patch[s]?.orifice_l_over_d) ? {
      discharge: Object.fromEntries(SIDES.filter(([s]) => patch[s]?.orifice_l_over_d).map(([s]) => [s, { orifice_l_over_d: patch[s]!.orifice_l_over_d }])),
    } : {}),
    ...(withFeed && fittedFeed ? { feed_system: fittedFeed } : {}),
  } : null;
  const exportYaml = async () => {
    if (!result || !patch) return;
    setExportError(null);
    const r = await layerx.exportConfig({
      design_patch: patch,
      feed_system: withFeed ? fittedFeed : null,
      name: `${designName}_injector_${pickLabel('oxidizer')}_${pickLabel('fuel')}`.replace(/[\s#]+/g, ''),
      note: `Holes for ${fmt(result.target.thrust_N, 0)} N at O/F ${fmt(result.target.of, 3)} through the drawing's feed (${result.condition}, ${fmt(result.lockup_psia, 1)} psia lockup).`
        + (checkResult ? ` Burned: mean O/F ${fmt(checkResult.summary.of_mean, 3)}, mean thrust ${fmt(checkResult.delivered?.summary.mean_thrust_N ?? checkResult.summary.mean_thrust_N, 0)} N.` : ' Not burned before export.'),
    });
    if (r.error || !r.data) { setExportError(r.error ?? 'Export failed.'); return; }
    download(r.data.text, r.data.filename, 'application/x-yaml');
  };

  return (
    <div className="space-y-10">
      <Step n={1} title="Target" aside={result && <span className="text-[12px] text-[var(--color-text-muted)]">{result.condition}, {fmt(result.lockup_psia, 1)} psia lockup{payload?.pressurant ? `, ${payload.pressurant}` : ''}</span>}>
        <div className="space-y-3">
          <div className="text-[13px] text-[var(--color-text-secondary)]">
            Make{' '}
            <input className={input} inputMode="decimal" placeholder={result ? fmt(result.design.thrust_N, 0) : 'design'} aria-label="Target thrust, N" value={form.thrust}
                   onChange={(e) => setForm((f) => ({ ...f, thrust: e.target.value.replace(/[^0-9.]/g, '') }))} /> N at O/F{' '}
            <input className={input} inputMode="decimal" placeholder={result ? fmt(result.design.of, 3) : 'design'} aria-label="Target O/F" value={form.of}
                   onChange={(e) => setForm((f) => ({ ...f, of: e.target.value.replace(/[^0-9.]/g, '') }))} />{' '}
            through this drawing's feed, {payload?.flight ? 'in flight' : 'on the pad'}.
            <span className="ml-2 text-[12px] text-[var(--color-text-muted)]">Blank: the design point.</span>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={form.spray} onChange={(e) => setForm((f) => ({ ...f, spray: e.target.checked }))} />
            <Hint text="Whole-degree jet angles, the included angle held, to bring the spray resultant back to the design's tilt. A changed angle means a new plate.">
              <span>Hold the spray direction</span>
            </Hint>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={start} disabled={live || busy || !ready || !payload} className={button}
                    title={busy && !live ? 'Another Layer X job is running.' : undefined}>
              {live ? 'Solving…' : result ? 'Solve again' : 'Solve holes'}
            </button>
            {live && job && <button type="button" onClick={() => layerx.cancel(job.id)} className={quiet}>Cancel</button>}
            <Hint text="Burns on the drawing, fits its feed, resizes the holes, and burns again until they stop moving: usually three burns.">
              <span className="text-[12px] text-[var(--color-text-muted)]">~{payload?.flight ? 3 : 1} min</span>
            </Hint>
            {!ready && <span className="text-[12px] text-[var(--color-warning)]">Fix what’s blocking the run first.</span>}
            {error && <span className="text-[12px] text-[var(--color-danger)]">{error}</span>}
            {job?.status === 'failed' && <span className="text-[12px] text-[var(--color-danger)]">{job.error}</span>}
            {job?.status === 'cancelled' && <span className="text-[12px] text-[var(--color-text-muted)]">Cancelled.</span>}
            {legacy && <span className="text-[12px] text-[var(--color-text-muted)]">This solve is from an earlier version without drill options; solve again.</span>}
          </div>
          {live && job && <Progress job={job} />}
        </div>
      </Step>

      {result && (
        <>
          <Step n={2} title="Holes" aside={<span className="text-[12px] text-[var(--color-text-muted)]">{result.passes.length} burns, {result.converged ? 'holes settled' : 'holes still moving'}</span>}>
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-3xl">
                {SIDES.map(([side, label, color]) => (
                  <DrillColumn key={side} side={side} label={label} color={color} res={result} value={picks[side]}
                               onChange={(v) => { setPicks((p) => ({ ...p, [side]: v })); setCheck(null); }} />
                ))}
              </div>
              <DrillMap res={result} picked={picks} onPick={(o, f) => { setPicks(() => ({ oxidizer: o, fuel: f })); setCheck(null); }} />
              <Comparison res={result} picked={predicted} />
              {!predicted && <div className="text-[12px] text-[var(--color-text-muted)]">An exact size beside a drill is not predicted here; burn it to see.</div>}
              {result.notes.length > 0 && <div className="max-w-3xl space-y-1 text-[12px] text-[var(--color-warning)]">{result.notes.map((n, k) => <p key={k}>{n}</p>)}</div>}
            </div>
          </Step>

          <Step n={3} title="Check over the burn">
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={burnCheck} disabled={!patch || checkLive || busy || !ready} className={button}>
                  {checkLive ? 'Burning…' : checkResult ? 'Burn again' : `Burn with ${pickLabel('oxidizer')} / ${pickLabel('fuel')}`}
                </button>
                <span className="text-[12px] text-[var(--color-text-muted)]">a whole burn on the drawing with these holes; the design is not changed</span>
                {check?.status === 'failed' && <span className="text-[12px] text-[var(--color-danger)]">{check.error}</span>}
                {checkResult && check && onOpenRun && (
                  <button type="button" onClick={() => onOpenRun(check.id)} className="text-[12px] text-[var(--color-accent)] hover:underline">
                    Open this burn in full
                  </button>
                )}
              </div>
              {checkLive && check && <Progress job={check} />}
              {checkResult && <CheckView result={checkResult} target={result.target} />}
            </div>
          </Step>

          <Step n={4} title="Export">
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
                <input type="checkbox" checked={withFeed} onChange={(e) => setWithFeed(e.target.checked)} />
                <Hint text="The drawing's feed as K0 per side, so Forward mode and Layer 1 size against the feed the injector will see.">
                  <span>Include the drawing's feed (fitted K0)</span>
                </Hint>
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <button type="button" onClick={exportYaml} disabled={!patch} className={quiet}>Download YAML</button>
                {update && <WriteReconciled key={`${job?.id}-${picks.oxidizer}-${picks.fuel}-${withFeed}`} update={update} runId={job?.id ?? ''}
                                            onConfigUpdated={onConfigUpdated} designSha={result?.config_sha256 ?? null}
                                            stale={stale ? 'The design has changed since these holes were sized. Solve again.' : null} />}
                {exportError && <span className="text-[12px] text-[var(--color-danger)]">{exportError}</span>}
              </div>
              {!checkResult && <div className="text-[12px] text-[var(--color-text-muted)]">Not burned yet with these holes.</div>}
            </div>
          </Step>
        </>
      )}
    </div>
  );
}
