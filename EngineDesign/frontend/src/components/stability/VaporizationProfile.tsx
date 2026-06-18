import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, UNSTABLE, STABLE, MUTED, CHART_MARGIN } from './shared';

export function VaporizationProfile({ data }: { data: StabilityRichPayload }) {
  const v = data.vaporization;
  const chart = v.d2_profile.map(([x, y]) => ({ x_m: x * 1000, d2: y }));
  const unburned = v.L_vap_m > v.L_ch_m;
  const xMax = Math.max(...chart.map((p) => p.x_m), v.L_ch_m * 1000, v.L_vap_m * 1000) * 1.05;

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
      <p className="text-xs text-[var(--color-text-secondary)] mt-2">
        SMD {v.smd_um.toFixed(1)} µm
        {unburned && <span className="text-red-400 ml-2">L_vap &gt; L_ch</span>}
      </p>
    </VizCard>
  );
}
