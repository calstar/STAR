import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, UNSTABLE, STABLE, MUTED, CHART_MARGIN } from './shared';

export function VaporizationProfile({ data }: { data: StabilityRichPayload }) {
  const v = data.vaporization;
  const chart = v.d2_profile.map(([x, y]) => ({ x_m: x * 1000, d2: y }));
  const unburned = v.L_vap_m > v.L_ch_m;
  const xMax = Math.max(...chart.map((p) => p.x_m), v.L_ch_m * 1000, v.L_vap_m * 1000) * 1.05;

  // Fraction of droplet mass vaporized by the chamber exit (d²-law: (d/d0)² = 1 − x/L_vap,
  // mass remaining ∝ (d/d0)³).
  const lvapOk = v.L_vap_m > 0 && Number.isFinite(v.L_vap_m);
  const dSqAtExit = lvapOk ? Math.max(0, 1 - v.L_ch_m / v.L_vap_m) : 0;
  const completion = lvapOk ? (v.L_ch_m >= v.L_vap_m ? 1 : 1 - Math.pow(dSqAtExit, 1.5)) : NaN;
  const completePct = Number.isFinite(completion) ? completion * 100 : NaN;
  const compColor = completePct >= 99.5 ? STABLE : completePct >= 90 ? '#f59e0b' : UNSTABLE;
  const [smdLo, smdHi] = v.smd_band_um ?? [NaN, NaN];

  const metrics: { label: string; value: string; color?: string }[] = [
    {
      label: 'SMD (droplet diameter)',
      value:
        Number.isFinite(smdLo) && Number.isFinite(smdHi)
          ? `${v.smd_um.toFixed(1)} µm  (${smdLo.toFixed(0)}–${smdHi.toFixed(0)})`
          : `${v.smd_um.toFixed(1)} µm`,
    },
    { label: 'L_vap (vaporization length)', value: `${(v.L_vap_m * 1000).toFixed(0)} mm`, color: unburned ? UNSTABLE : STABLE },
    { label: 'L_ch (chamber length)', value: `${(v.L_ch_m * 1000).toFixed(0)} mm` },
    {
      label: 'vaporized by chamber exit',
      value: Number.isFinite(completePct) ? `${completePct.toFixed(0)}%` : '—',
      color: compColor,
    },
  ];
  if (v.tau_conv_s != null && Number.isFinite(v.tau_conv_s)) {
    metrics.push({ label: 'τ_conv (vaporization lag)', value: `${(v.tau_conv_s * 1e3).toFixed(1)} ms` });
  }
  if (v.tau_sens_s != null && Number.isFinite(v.tau_sens_s)) {
    metrics.push({ label: 'τ_sens (sensitive lag)', value: `${(v.tau_sens_s * 1e3).toFixed(1)} ms` });
  }

  return (
    <VizCard title="Vaporization length" subtitle="d²-law decay vs chamber length">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chart} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="x_m"
            type="number"
            domain={[0, xMax]}
            tick={{ fill: MUTED, fontSize: 10 }}
            label={{ value: 'x [mm]', position: 'bottom', offset: 0, fill: MUTED, fontSize: 11 }}
          />
          <YAxis domain={[0, 1]} tick={{ fill: MUTED, fontSize: 10 }} width={36} />
          <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
          <ReferenceLine
            x={v.L_ch_m * 1000}
            stroke={STABLE}
            strokeDasharray="4 4"
            label={{ value: 'L_ch', fill: STABLE, fontSize: 10, position: 'insideTopLeft' }}
          />
          <ReferenceLine
            x={v.L_vap_m * 1000}
            stroke={unburned ? UNSTABLE : STABLE}
            strokeDasharray="4 4"
            label={{ value: 'L_vap', fill: unburned ? UNSTABLE : STABLE, fontSize: 10, position: 'insideTopRight' }}
          />
          <Line type="monotone" dataKey="d2" stroke="#38bdf8" dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
      <p className="text-xs text-[var(--color-text-secondary)] mt-2 leading-snug">
        Blue curve = droplet size² shrinking down the chamber (d²-law); it hits 0 once fully
        vaporized at <span className="font-mono">L_vap</span>. You want{' '}
        <span className="font-mono">L_vap</span> &lt; <span className="font-mono">L_ch</span> so
        droplets burn before the nozzle.
      </p>

      <table className="w-full mt-3 text-[11px]">
        <tbody>
          {metrics.map((m) => (
            <tr key={m.label} className="border-b border-[var(--color-border)] last:border-0">
              <td className="py-0.5 text-[var(--color-text-secondary)]">{m.label}</td>
              <td
                className="py-0.5 text-right font-mono"
                style={{ color: m.color ?? 'var(--color-text-primary)' }}
              >
                {m.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unburned && (
        <p className="text-[11px] mt-2" style={{ color: UNSTABLE }}>
          L_vap &gt; L_ch - droplets exit unburned, dropping c* efficiency and lengthening the
          combustion lag.
        </p>
      )}

      <p className="text-[10px] text-[var(--color-text-secondary)] mt-2 leading-snug">
        Atomization is the lever: a smaller SMD shortens <span className="font-mono">L_vap</span> and
        the lag <span className="font-mono">τ_conv</span>. That τ is what feeds the chug loop and sets
        the phase-clock angle (ωτ = 2π·f·χ·τ_vap) - so finer droplets improve performance{' '}
        <em>and</em> stability at once.
      </p>
    </VizCard>
  );
}
