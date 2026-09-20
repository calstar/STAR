import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, UNSTABLE, STABLE, MUTED, CHART_MARGIN } from './shared';

const STREAM_COLORS: Record<string, string> = { O: '#38bdf8', F: '#a78bfa' };

export function VaporizationProfile({ data }: { data: StabilityRichPayload }) {
  const v = data.vaporization;
  // Both streams, not just the oxidizer. The headline metrics describe whichever stream is
  // rate-limiting — on LOX/ethanol that is the fuel, and this card used to report LOX's 211 mm
  // while ethanol needed 426 mm in a 203 mm chamber.
  const streams = (v.streams ?? []).filter((st) => (st.d2_profile?.length ?? 0) > 0);
  const gasStreams = (v.streams ?? []).filter((st) => (st.d2_profile?.length ?? 0) === 0);
  const leadKey = v.rate_limiting_stream ?? 'O';

  // One chart, one series per liquid stream, sampled onto a shared x grid.
  const chart = streams.length
    ? (() => {
        const n = Math.max(...streams.map((st) => st.d2_profile.length));
        const xEnd = Math.max(...streams.map((st) => st.d2_profile[st.d2_profile.length - 1][0]));
        return Array.from({ length: n }, (_, i) => {
          const x = (xEnd * i) / (n - 1);
          const row: Record<string, number> = { x_m: x * 1000 };
          for (const st of streams) {
            const lv = st.L_vap_m;
            row[`d2_${st.stream}`] =
              lv && lv > 0 ? Math.max(0, Math.min(1, 1 - x / lv)) : 1;
          }
          return row;
        });
      })()
    : v.d2_profile.map(([x, y]) => ({ x_m: x * 1000, d2_O: y }));
  const unburned = v.L_vap_m > v.L_ch_m;
  // Round the domain end up to a clean step — recharts renders the raw domain value as a tick,
  // so an unrounded max printed "492.46918316764993" under the axis.
  const xRaw = Math.max(...chart.map((p) => p.x_m), v.L_ch_m * 1000, v.L_vap_m * 1000) * 1.05;
  const xStep = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(xRaw, 1))) - 1)) * 5;
  const xMax = Math.ceil(xRaw / xStep) * xStep;
  const leadFluid = streams.find((st) => st.stream === leadKey)?.fluid ?? leadKey;

  // Fraction of droplet mass vaporized by the chamber exit (d²-law: (d/d0)² = 1 − x/L_vap,
  // mass remaining ∝ (d/d0)³).
  const lvapOk = v.L_vap_m > 0 && Number.isFinite(v.L_vap_m);
  const dSqAtExit = lvapOk ? Math.max(0, 1 - v.L_ch_m / v.L_vap_m) : 0;
  const completion = lvapOk ? (v.L_ch_m >= v.L_vap_m ? 1 : 1 - Math.pow(dSqAtExit, 1.5)) : NaN;
  const completePct = Number.isFinite(completion) ? completion * 100 : NaN;
  const compColor = completePct >= 99.5 ? STABLE : completePct >= 90 ? '#f59e0b' : UNSTABLE;
  const [smdLo, smdHi] = v.smd_band_um ?? [NaN, NaN];

  const metrics: { label: string; value: string; color?: string }[] = [
    { label: 'rate-limiting stream', value: `${leadKey} · ${leadFluid}` },
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
    <VizCard
      title="Vaporization length"
      subtitle={`d²-law decay vs chamber length — headline figures are the rate-limiting stream (${leadFluid})`}
    >
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
          {streams.length
            ? streams.map((st) => (
                <Line
                  key={st.stream}
                  type="monotone"
                  dataKey={`d2_${st.stream}`}
                  name={`${st.stream} · ${st.fluid}`}
                  stroke={STREAM_COLORS[st.stream] ?? '#38bdf8'}
                  dot={false}
                  strokeWidth={st.stream === leadKey ? 2.4 : 1.4}
                  strokeDasharray={st.stream === leadKey ? undefined : '5 3'}
                />
              ))
            : <Line type="monotone" dataKey="d2_O" stroke="#38bdf8" dot={false} strokeWidth={2} />}
        </LineChart>
      </ResponsiveContainer>
      {streams.length > 1 && (
        <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-text-secondary)] mt-1 mb-1">
          {streams.map((st) => (
            <span key={st.stream} className="flex items-center gap-1.5">
              <span
                className="inline-block w-5 h-0.5 rounded"
                style={{ background: STREAM_COLORS[st.stream] ?? '#38bdf8' }}
              />
              {st.stream} · {st.fluid}
              {st.stream === leadKey ? ' (rate-limiting)' : ''}
              {st.L_vap_m != null ? ` — ${(st.L_vap_m * 1000).toFixed(0)} mm` : ''}
            </span>
          ))}
        </div>
      )}
      {gasStreams.map((st) => (
        <p key={st.stream} className="text-[10px] text-[var(--color-text-secondary)] mt-1">
          {st.note ?? `${st.fluid} is injected as a gas — nothing to vaporize.`}
        </p>
      ))}
      <p className="text-xs text-[var(--color-text-secondary)] mt-2 leading-snug">
        Each curve = that propellant's droplet size² shrinking down the chamber (d²-law); it hits 0
        once fully vaporized at <span className="font-mono">L_vap</span>. You want{' '}
        <span className="font-mono">L_vap</span> &lt; <span className="font-mono">L_ch</span> for
        both, so droplets burn before the nozzle. The solid curve is the stream that paces the
        burn — it sets τ and therefore the chug and acoustic verdicts.
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
