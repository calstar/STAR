import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceArea } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, MUTED, CHART_MARGIN } from './shared';

export function FeedPressureBand({ data }: { data: StabilityRichPayload }) {
  const fp = data.feed_pressure;
  const reg = fp.regulated.map(([t, p]) => ({ t, regulated: p }));
  const bd = fp.blowdown_ref.map(([t, p]) => ({ t, blowdown: p }));
  const merged = reg.map((r, i) => ({ ...r, blowdown: bd[i]?.blowdown }));
  const tMax = Math.max(...merged.map((m) => m.t), 1);

  return (
    <VizCard title="Tank pressure vs time" subtitle="Dome-regulated (solid) vs blowdown reference (dashed)">
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={merged} margin={CHART_MARGIN}>
          <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
          <XAxis
            dataKey="t"
            type="number"
            domain={[0, tMax]}
            tick={{ fill: MUTED, fontSize: 10 }}
            label={{ value: 't [s]', position: 'bottom', offset: 0, fill: MUTED, fontSize: 11 }}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fill: MUTED, fontSize: 10 }}
            width={48}
            label={{
              value: 'P [psi]',
              angle: -90,
              position: 'insideLeft',
              offset: 10,
              fill: MUTED,
              fontSize: 11,
            }}
          />
          <ReferenceArea
            y1={fp.P_set_psi - fp.ripple_psi}
            y2={fp.P_set_psi + fp.ripple_psi}
            fill="#38bdf8"
            fillOpacity={0.1}
          />
          <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
          <Line type="monotone" dataKey="regulated" stroke="#22c55e" dot={false} strokeWidth={2} name="regulated" />
          <Line
            type="monotone"
            dataKey="blowdown"
            stroke="#94a3b8"
            dot={false}
            strokeWidth={1.5}
            strokeDasharray="6 4"
            name="blowdown ref"
          />
        </LineChart>
      </ResponsiveContainer>
    </VizCard>
  );
}
