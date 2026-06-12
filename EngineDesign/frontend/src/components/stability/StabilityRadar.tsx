import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, marginColor, STABLE } from './shared';
import { SideTooltip } from './SideTooltip';

const THRESHOLD = 1.05;

export function StabilityRadar({ data }: { data: StabilityRichPayload }) {
  const rows = data.radar.axes.map((axis, i) => ({
    axis,
    value: data.radar.values[i],
    threshold: data.radar.threshold[i],
  }));

  return (
    <VizCard
      title="Stability radar"
      subtitle="Blue = your design; dashed green ring = pass threshold (1.05)"
    >
      <ResponsiveContainer width="100%" height={200}>
        <RadarChart data={rows} cx="50%" cy="50%" outerRadius="72%">
          <PolarGrid stroke="#334155" />
          <PolarAngleAxis dataKey="axis" tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <PolarRadiusAxis domain={[0, 1.4]} tick={{ fill: '#64748b', fontSize: 9 }} />
          <Radar name="design" dataKey="value" stroke="#38bdf8" fill="#38bdf8" fillOpacity={0.35} />
          <Radar name="threshold" dataKey="threshold" stroke={STABLE} fill="none" strokeDasharray="4 4" />
          <Tooltip
            content={<SideTooltip />}
            wrapperStyle={{ outline: 'none', zIndex: 20 }}
            allowEscapeViewBox={{ x: true, y: true }}
            formatter={(v: number) => [v.toFixed(3), 'margin']}
          />
        </RadarChart>
      </ResponsiveContainer>

      <div className="border-t border-[var(--color-border)] pt-2 space-y-1">
        <p className="text-xs" style={{ color: marginColor(data.summary.min_margin, data.summary.gate_margin_threshold) }}>
          <span className="font-semibold">{data.summary.state}</span>
          {' · min '}
          {data.summary.min_margin.toFixed(3)}
          {data.summary.limiting_mode ? ` (${data.summary.limiting_mode})` : ''}
        </p>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-secondary)]">
          {data.radar.axes.map((axis, i) => {
            const val = data.radar.values[i];
            const ok = val >= THRESHOLD;
            return (
              <span key={axis} style={{ color: ok ? STABLE : '#f59e0b' }}>
                {axis} {val.toFixed(2)}
              </span>
            );
          })}
        </div>
        <p className="text-[10px] opacity-80 leading-snug">
          chug = injector/feed · 1L/1T = acoustic · vaporization = droplets burned in L_ch. ≥ {THRESHOLD} passes gate.
        </p>
      </div>
    </VizCard>
  );
}
