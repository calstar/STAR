import { useMemo, useState } from 'react';
import { Area, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { SweepFactor, SweepMetric, SweepResult } from '../../api/layerx';
import { Hint } from '../Hint';
import { fmt } from './format';

/**
 * The uncertainty sweep (engine/layerx/uncertainty.py): each unmeasured input low and high, one at
 * a time. Read top to bottom:
 *
 *   band       each output's spread below and above, told apart (one ± overstated the side the
 *              inputs push less)
 *   crossings  the cases that break a limit at the end of their range: the inputs worth measuring first
 *   tornado    what moves the chosen output, signed values printed at the bar ends
 *   envelope   thrust through the burn: the nominal, inside the band every case spans
 */

const METRICS: { key: SweepMetric; label: string; unit: string; digits: number; scale?: number }[] = [
  { key: 'mean_thrust_N', label: 'Mean thrust', unit: 'N', digits: 0 },
  { key: 'of_mean', label: 'O/F', unit: '', digits: 3 },
  { key: 'total_impulse_Ns', label: 'Total impulse', unit: 'kN·s', digits: 2, scale: 1e-3 },
  { key: 'copv_end_psia', label: 'Bottle at burnout', unit: 'psi', digits: 0 },
  { key: 'burn_time_s', label: 'Burn time', unit: 's', digits: 2 },
  { key: 'pc_mean_psia', label: 'Chamber pressure', unit: 'psia', digits: 1 },
  { key: 'ox_stiffness_min', label: 'LOX injector ΔP/Pc (lowest)', unit: '%', digits: 1, scale: 100 },
  { key: 'fuel_stiffness_min', label: 'Fuel injector ΔP/Pc (lowest)', unit: '%', digits: 1, scale: 100 },
  { key: 'ox_min_psia', label: 'LOX tank (lowest)', unit: 'psia', digits: 1 },
  { key: 'fuel_min_psia', label: 'Fuel tank (lowest)', unit: 'psia', digits: 1 },
];

const GROUP: Record<string, string> = { feed: 'feed', engine: 'engine', operation: 'on the day' };

function signed(v: number, digits: number): string {
  return `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), digits)}`;
}

function Bars({ factors, metric }: { factors: SweepFactor[]; metric: (typeof METRICS)[number] }) {
  const scale = metric.scale ?? 1;
  const rows = [...factors]
    .map((f) => ({ f, swing: f.swing[metric.key] ?? 0 }))
    .sort((a, b) => b.swing - a.swing);
  const max = Math.max(...rows.map((r) => r.swing), 1e-12);
  return (
    <div className="space-y-1.5">
      {rows.map(({ f }) => {
        const sides = Object.entries(f.cases);
        const deltas = sides.map(([side, c]) => ({ side, c, d: c.ok && c.delta ? c.delta[metric.key] : null }));
        return (
          <div key={f.key} className="grid grid-cols-[13rem_1fr_9rem] items-center gap-3">
            <Hint text={<>{f.basis}</>}>
              <span className="truncate text-[12px] text-[var(--color-text-secondary)]">{f.label}
                <span className="text-[var(--color-text-muted)]"> {GROUP[f.group] ?? f.group}</span></span>
            </Hint>
            <div className="relative h-5" role="img"
                 aria-label={deltas.map(({ side, c, d }) => `${side} (${c.label}): ${d === null || d === undefined ? 'no result' : `${signed(d * scale, metric.digits)} ${metric.unit}`}`).join('; ')}>
              <div className="absolute inset-y-0 left-1/2 w-px bg-[var(--color-border)]" />
              {deltas.map(({ side, d }) => {
                if (d === null || d === undefined) return null;
                const w = (Math.abs(d) / max) * 50;
                const left = d >= 0 ? 50 : 50 - w;
                // Neutral fills, filled for the input's low end and outlined for its high end:
                // neither direction is "good", and colour alone does not carry it.
                return (
                  <span key={side} className="absolute top-0.5 bottom-0.5 rounded-sm"
                        style={{ left: `${left}%`, width: `${Math.max(w, 0.4)}%`,
                                 background: side === 'high' ? 'transparent' : 'var(--color-text-secondary)',
                                 border: side === 'high' ? '1.5px solid var(--color-text-secondary)' : 'none', opacity: 0.8 }} />
                );
              })}
            </div>
            <span className="text-right text-[11px] tabular-nums text-[var(--color-text-primary)]">
              {deltas.filter(({ d }) => d !== null && d !== undefined).map(({ side, d }) => (
                <span key={side} className="ml-2">{signed((d as number) * scale, metric.digits)}</span>
              ))}
              <span className="text-[var(--color-text-muted)]"> {metric.unit}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Thrust through the burn: the nominal inside the band every case spans. */
function Envelope({ sweep }: { sweep: SweepResult }) {
  const data = useMemo(() => {
    if (!sweep.nominal_thrust?.length) return [];
    const t0 = sweep.nominal_thrust[0][0];
    const curves = sweep.factors.flatMap((f) => Object.values(f.cases))
      .filter((c) => c.ok && c.thrust && c.thrust.length > 1).map((c) => c.thrust!);
    const at = (curve: [number, number][], t: number) => {
      if (t < curve[0][0] || t > curve[curve.length - 1][0]) return undefined;
      let k = 0;
      while (k < curve.length - 2 && curve[k + 1][0] < t) k++;
      const [ta, fa] = curve[k];
      const [tb, fb] = curve[k + 1];
      return tb > ta ? fa + ((fb - fa) * (t - ta)) / (tb - ta) : fa;
    };
    return sweep.nominal_thrust.map(([t, F]) => {
      const vals = curves.map((c) => at(c, t)).filter((v): v is number => v !== undefined);
      return { t: t - t0, F, band: vals.length ? [Math.min(...vals, F), Math.max(...vals, F)] as [number, number] : [F, F] as [number, number] };
    });
  }, [sweep]);
  if (!data.length) return null;
  return (
    <div className="max-w-3xl">
      <div className="mb-1 flex items-baseline gap-3 text-xs">
        <span className="text-[var(--color-text-secondary)]">Thrust through the burn <span className="text-[var(--color-text-muted)]">N</span></span>
        <span className="text-[11px] text-[var(--color-text-muted)]">nominal, inside the range every case spans</span>
      </div>
      <ResponsiveContainer width="100%" height={170}>
        <ComposedChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="t" type="number" domain={[0, 'dataMax']} tickCount={5} axisLine={false} tickLine={false}
                 tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }} tickFormatter={(v: number) => `${fmt(v, 1)} s`} height={18} />
          <YAxis domain={['auto', 'auto']} width={52} tick={{ fill: 'var(--color-text-muted)', fontSize: 10 }} tickFormatter={(v: number) => fmt(v, 0)}
                 axisLine={false} tickLine={false} tickCount={4} />
          <Tooltip contentStyle={{ background: 'var(--color-bg-tertiary)', border: '1px solid var(--color-border)', borderRadius: 6, fontSize: 11 }}
                   labelFormatter={(v: number) => `${fmt(v, 2)} s`}
                   formatter={(v: number | [number, number], name: string) => [Array.isArray(v) ? `${fmt(v[0], 0)}–${fmt(v[1], 0)} N` : `${fmt(v, 0)} N`, name]} />
          <Area dataKey="band" name="every case" stroke="none" fill="var(--color-text-secondary)" fillOpacity={0.18} isAnimationActive={false} />
          <Line dataKey="F" name="nominal" dot={false} stroke="var(--color-text-primary)" strokeWidth={1.8} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function UncertaintyView({ sweep }: { sweep: SweepResult }) {
  const [metricKey, setMetricKey] = useState<SweepMetric>('mean_thrust_N');
  const metric = METRICS.find((m) => m.key === metricKey) ?? METRICS[0];
  const failed = sweep.factors.some((f) => Object.values(f.cases).some((c) => !c.ok));
  const crossings = sweep.crossings ?? [];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-5 gap-x-8 gap-y-4">
        {METRICS.slice(0, 5).map((m) => {
          const nom = sweep.nominal[m.key];
          const scale = m.scale ?? 1;
          const lo = sweep.band_low?.[m.key] ?? sweep.band[m.key];
          const hi = sweep.band_high?.[m.key] ?? sweep.band[m.key];
          return (
            <div key={m.key}>
              <Hint text={`The sweep's own nominal is ${fmt((nom ?? NaN) * scale, m.digits)} ${m.unit} (on the pad, no erosion); the spread below and above it is what to read.`}>
                <span className="text-xs text-[var(--color-text-secondary)]">{m.label}</span>
              </Hint>
              <div className="mt-1 text-lg tabular-nums text-[var(--color-text-primary)]">
                −{fmt((lo ?? NaN) * scale, m.digits)} <span className="text-[var(--color-text-muted)]">/</span> +{fmt((hi ?? NaN) * scale, m.digits)}
                <span className="text-[13px] text-[var(--color-text-muted)]"> {m.unit}</span>
              </div>
              {nom ? <div className="text-[11px] text-[var(--color-text-muted)] tabular-nums">−{fmt(((lo ?? 0) / Math.abs(nom)) * 100, 1)} / +{fmt(((hi ?? 0) / Math.abs(nom)) * 100, 1)} %</div> : null}
            </div>
          );
        })}
      </div>

      {crossings.length > 0 && (
        <div className="max-w-3xl space-y-1 text-[12px]">
          <div className="text-[var(--color-danger)]">✗ {crossings.length} input{crossings.length > 1 ? 's' : ''} at the end of {crossings.length > 1 ? 'their ranges break' : 'its range breaks'} a limit: measure these first</div>
          {crossings.map((c, k) => (
            <div key={k} className="tabular-nums text-[var(--color-text-secondary)]">
              {c.factor} <span className="text-[var(--color-text-muted)]">{c.side} ({c.case})</span>: {c.breaks.join(', ')}
            </div>
          ))}
        </div>
      )}

      <div>
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <span className="text-sm font-medium text-[var(--color-text-primary)]">What moves it</span>
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value as SweepMetric)} aria-label="Output to rank by"
                  className="rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 py-0.5 text-[12px] text-[var(--color-text-primary)]">
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
          <span className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)]">
            <span className="inline-block h-2.5 w-4 rounded-sm bg-[var(--color-text-secondary)] opacity-80" /> input low
            <span className="ml-2 inline-block h-2.5 w-4 rounded-sm border-[1.5px] border-[var(--color-text-secondary)]" /> input high
          </span>
        </div>
        <Bars factors={sweep.factors} metric={metric} />
      </div>
      <Envelope sweep={sweep} />
      <div className="text-[12px] text-[var(--color-text-muted)] max-w-3xl space-y-1">
        <Hint text={sweep.basis}><span>{sweep.cases} burns, {fmt(sweep.wall_s / 60, 1)} min. Each input moved alone; each side adds its swings in quadrature.</span></Hint>
        {sweep.notes.map((n, k) => <p key={k} className={failed ? 'text-[var(--color-warning)]' : ''}>{n}</p>)}
      </div>
    </div>
  );
}
