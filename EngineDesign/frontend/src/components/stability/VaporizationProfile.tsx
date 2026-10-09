import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, UNSTABLE, STABLE, MUTED, CHART_MARGIN } from './shared';

const STREAM_COLORS: Record<string, string> = { O: '#38bdf8', F: '#a78bfa' };

type Vap = StabilityRichPayload['vaporization'];
type Stream = NonNullable<Vap['streams']>[number];

/**
 * Liquid left along the chamber, per stream, sampled onto one x grid [mm].
 *
 * With a droplet march in the result (the model eta_vap uses) the curve is its own profile of
 * liquid mass remaining. Older results carry only a length: the d²-law then gives mass remaining
 * (1 - x/L_vap)^1.5.
 */
export function remainingRows(streams: Stream[]): Record<string, number>[] {
  const march = streams.some((st) => (st.remaining_profile?.length ?? 0) > 0);
  if (march) {
    const xs = Array.from(new Set(streams.flatMap((st) => (st.remaining_profile ?? []).map(([x]) => x)))).sort((a, b) => a - b);
    const at = (prof: [number, number][], x: number) => {
      if (!prof.length) return NaN;
      if (x <= prof[0][0]) return prof[0][1];
      for (let i = 1; i < prof.length; i++) {
        const [x0, y0] = prof[i - 1];
        const [x1, y1] = prof[i];
        if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
      }
      return prof[prof.length - 1][1];
    };
    return xs.map((x) => {
      const row: Record<string, number> = { x_m: x * 1000 };
      for (const st of streams) if (st.remaining_profile?.length) row[`m_${st.stream}`] = at(st.remaining_profile, x);
      return row;
    });
  }
  const withD2 = streams.filter((st) => (st.d2_profile?.length ?? 0) > 0);
  if (!withD2.length) return [];
  const n = Math.max(...withD2.map((st) => st.d2_profile.length));
  const xEnd = Math.max(...withD2.map((st) => st.d2_profile[st.d2_profile.length - 1][0]));
  return Array.from({ length: n }, (_, i) => {
    const x = (xEnd * i) / (n - 1);
    const row: Record<string, number> = { x_m: x * 1000 };
    for (const st of withD2) {
      const lv = st.L_vap_m;
      row[`m_${st.stream}`] = lv && lv > 0 ? Math.pow(Math.max(0, Math.min(1, 1 - x / lv)), 1.5) : 1;
    }
    return row;
  });
}

export function VaporizationProfile({ data }: { data: StabilityRichPayload }) {
  const v = data.vaporization;
  const all = v.streams ?? [];
  const streams = all.filter((st) => st.smd_um != null);
  const gasStreams = all.filter((st) => st.smd_um == null);
  const leadKey = v.rate_limiting_stream ?? 'O';
  const lead = streams.find((st) => st.stream === leadKey);
  const leadFluid = lead?.fluid ?? leadKey;
  const fromMarch = streams.some((st) => (st.remaining_profile?.length ?? 0) > 0);
  const chart = remainingRows(streams);

  const lvap = v.L_vap_m;                       // null: not 95 % vaporized by the chamber end
  const lvapOk = lvap != null && Number.isFinite(lvap) && lvap > 0;
  const unburned = !lvapOk || lvap! > v.L_ch_m;
  // Vaporized by the chamber end: the march's own number when there is one.
  const completion = v.frac_vaporized_end != null
    ? v.frac_vaporized_end
    : lvapOk ? (v.L_ch_m >= lvap! ? 1 : 1 - Math.pow(Math.max(0, 1 - v.L_ch_m / lvap!), 1.5)) : NaN;
  const completePct = Number.isFinite(completion) ? completion * 100 : NaN;
  const compColor = completePct >= 99.5 ? STABLE : completePct >= 90 ? '#f59e0b' : UNSTABLE;
  const [smdLo, smdHi] = v.smd_band_um ?? [NaN, NaN];

  // Round the domain end up to a clean step: recharts prints the raw domain value as a tick.
  const xRaw = Math.max(...chart.map((p) => p.x_m), v.L_ch_m * 1000, lvapOk ? lvap! * 1000 : 0) * 1.05;
  const xStep = Math.pow(10, Math.max(0, Math.floor(Math.log10(Math.max(xRaw, 1))) - 1)) * 5;
  const xMax = Math.ceil(xRaw / xStep) * xStep;

  const metrics: { label: string; value: string; color?: string }[] = [
    { label: 'slowest stream', value: `${leadKey} · ${leadFluid}` },
    {
      label: 'SMD (droplet diameter)',
      value:
        Number.isFinite(smdLo) && Number.isFinite(smdHi)
          ? `${v.smd_um.toFixed(1)} µm  (${smdLo.toFixed(0)}–${smdHi.toFixed(0)})`
          : `${v.smd_um.toFixed(1)} µm`,
    },
    {
      label: 'L_vap (95 % vapour)',
      value: lvapOk ? `${(lvap! * 1000).toFixed(0)} mm` : 'past the chamber end',
      color: unburned ? UNSTABLE : STABLE,
    },
    { label: 'L_ch (L*·At/Ac)', value: `${(v.L_ch_m * 1000).toFixed(0)} mm` },
    {
      label: 'vaporized by the chamber end',
      value: Number.isFinite(completePct) ? `${completePct.toFixed(1)}%` : '—',
      color: compColor,
    },
  ];
  if (v.tau_conv_s != null && Number.isFinite(v.tau_conv_s)) {
    metrics.push({ label: 'τ_conv (chug lag)', value: `${(v.tau_conv_s * 1e3).toFixed(1)} ms` });
  }
  if (v.tau_sens_s != null && Number.isFinite(v.tau_sens_s)) {
    metrics.push({ label: 'τ_sens (sensitive lag)', value: `${(v.tau_sens_s * 1e3).toFixed(1)} ms` });
  }

  return (
    <VizCard
      title="Vaporization length"
      subtitle={`Liquid left down the chamber; the slowest stream is ${leadFluid}.`}
      info={<>
        <span className="block">{fromMarch
          ? 'The droplet march that sets η_vap: drops form where the sheet breaks up, heat up, evaporate with blowing, and are dragged by the burning gas.'
          : 'This result carries no droplet march, so it is a d²-law estimate at injection speed.'}</span>
        <span className="block">L_vap is where 95 % of a stream is vapour, from the face. τ_conv is the chug model's lag (atomize + vaporize + mix), not this curve.</span>
      </>}
    >
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={chart} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="x_m"
            type="number"
            domain={[0, xMax]}
            ticks={Array.from({ length: Math.round(xMax / xStep) + 1 }, (_, i) => i * xStep)}
            tick={{ fill: MUTED, fontSize: 10 }}
            label={{ value: 'x from the face [mm]', position: 'bottom', offset: 0, fill: MUTED, fontSize: 11 }}
          />
          <YAxis domain={[0, 1]} ticks={[0, 0.25, 0.5, 0.75, 1]} tickFormatter={(v: number) => v.toFixed(2)}
                 tick={{ fill: MUTED, fontSize: 10 }} width={36} />
          <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
          <ReferenceLine
            x={v.L_ch_m * 1000}
            stroke={STABLE}
            strokeDasharray="4 4"
            label={{ value: 'L_ch', fill: STABLE, fontSize: 10, position: 'insideTopLeft' }}
          />
          {lvapOk && (
            <ReferenceLine
              x={lvap! * 1000}
              stroke={unburned ? UNSTABLE : STABLE}
              strokeDasharray="4 4"
              label={{ value: 'L_vap', fill: unburned ? UNSTABLE : STABLE, fontSize: 10, position: 'insideTopRight' }}
            />
          )}
          {streams.map((st) => (
            <Line
              key={st.stream}
              type="monotone"
              dataKey={`m_${st.stream}`}
              name={`${st.stream} · ${st.fluid}`}
              stroke={STREAM_COLORS[st.stream] ?? '#38bdf8'}
              dot={false}
              strokeWidth={st.stream === leadKey ? 2.4 : 1.4}
              strokeDasharray={st.stream === leadKey ? undefined : '5 3'}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {streams.length > 1 && (
        <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-text-secondary)] mt-1 mb-1">
          {streams.map((st) => (
            <span key={st.stream} className="flex items-center gap-1.5">
              <span className="inline-block w-5 h-0.5 rounded" style={{ background: STREAM_COLORS[st.stream] ?? '#38bdf8' }} />
              {st.stream} · {st.fluid}
              {st.stream === leadKey ? ' (slowest)' : ''}
              {st.L_vap_m != null ? ` — 95 % at ${(st.L_vap_m * 1000).toFixed(0)} mm` : ' — not 95 % by the end'}
              {st.frac_vaporized_end != null ? `, ${(st.frac_vaporized_end * 100).toFixed(1)} % at L_ch` : ''}
            </span>
          ))}
        </div>
      )}
      {gasStreams.map((st) => (
        <p key={st.stream} className="text-[10px] text-[var(--color-text-secondary)] mt-1">
          {st.note ?? `${st.fluid} is injected as a gas — nothing to vaporize.`}
        </p>
      ))}


      <table className="w-full mt-3 text-[11px]">
        <tbody>
          {metrics.map((m) => (
            <tr key={m.label} className="border-b border-[var(--color-border)] last:border-0">
              <td className="py-0.5 text-[var(--color-text-secondary)]">{m.label}</td>
              <td className="py-0.5 text-right font-mono" style={{ color: m.color ?? 'var(--color-text-primary)' }}>
                {m.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {unburned && (
        <p className="text-[11px] mt-2" style={{ color: UNSTABLE }}>
          {leadFluid} is not 95 % vaporized by the chamber end: unburned liquid costs c* efficiency.
        </p>
      )}


    </VizCard>
  );
}
