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

const AXIS_INFO: Record<string, { label: string; desc: string; card: string }> = {
  chug: { label: 'Chug', desc: 'low-frequency feed-coupled loop', card: 'Injector stiffness map' },
  '1L': { label: '1L acoustic', desc: 'first longitudinal chamber mode', card: 'Acoustic damping budget' },
  '1T': { label: '1T acoustic', desc: 'first tangential chamber mode', card: 'Acoustic damping budget' },
  vaporization: { label: 'Vaporization', desc: 'droplets fully burned within L_ch', card: 'Vaporization length' },
};

export function StabilityRadar({ data }: { data: StabilityRichPayload }) {
  const rows = data.radar.axes.map((axis, i) => ({
    axis,
    value: data.radar.values[i],
    threshold: data.radar.threshold[i],
  }));

  // weakest axis → tells the user where to look next
  const weakest = rows.reduce((min, r) => (r.value < min.value ? r : min), rows[0]);
  const weakInfo = weakest ? AXIS_INFO[weakest.axis] : undefined;

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
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
              <th className="font-medium text-left pb-1">axis</th>
              <th className="font-medium text-left pb-1">what it measures</th>
              <th className="font-medium text-right pb-1">margin</th>
              <th className="font-medium text-right pb-1">vs {THRESHOLD}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const info = AXIS_INFO[r.axis];
              const ok = r.value >= THRESHOLD;
              return (
                <tr key={r.axis}>
                  <td className="py-0.5 text-[var(--color-text-primary)]">{info?.label ?? r.axis}</td>
                  <td className="py-0.5 text-[var(--color-text-secondary)]">{info?.desc ?? '—'}</td>
                  <td className="py-0.5 text-right font-mono" style={{ color: ok ? STABLE : '#f59e0b' }}>
                    {r.value.toFixed(2)}
                  </td>
                  <td className="py-0.5 text-right" style={{ color: ok ? STABLE : '#f59e0b' }}>
                    {ok ? 'pass' : 'tight'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {weakest && weakInfo && (
          <p className="text-[11px] leading-snug pt-1">
            <span className="text-[var(--color-text-secondary)]">Weakest axis: </span>
            <span style={{ color: weakest.value >= THRESHOLD ? STABLE : '#f59e0b' }}>
              {weakInfo.label} ({weakest.value.toFixed(2)})
            </span>
            <span className="text-[var(--color-text-secondary)]"> - open the “{weakInfo.card}” card to improve it.</span>
          </p>
        )}
        <p className="text-[10px] opacity-80 leading-snug text-[var(--color-text-secondary)]">
          Each axis is a margin: the growth rate remapped so ≥ {THRESHOLD} clears the gate. The blue
          shape should stay outside the dashed green ring on every axis.
        </p>
      </div>
    </VizCard>
  );
}
