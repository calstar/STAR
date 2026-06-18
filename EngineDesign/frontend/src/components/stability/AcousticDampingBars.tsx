import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE, MARGINAL, CHART_MARGIN } from './shared';
import { SideTooltip } from './SideTooltip';

const DAMP_COLORS = { noz: '#0ea5e9', visc: '#6366f1', inj: '#a855f7', twophase: '#14b8a6' };

const DAMP_LABELS: Record<string, string> = {
  driving: 'combustion driving',
  noz: 'nozzle damping',
  visc: 'viscous damping',
  inj: 'injector damping',
  twophase: 'two-phase damping',
};

export function AcousticDampingBars({ data }: { data: StabilityRichPayload }) {
  const rows = data.acoustic.modes.map((m) => ({
    mode: m.name,
    driving: m.driving,
    noz: -m.damping.noz,
    visc: -m.damping.visc,
    inj: -m.damping.inj,
    twophase: -m.damping.twophase,
    alpha: m.alpha,
  }));

  return (
    <VizCard
      title="Acoustic damping budget"
      subtitle="Red = driving; stacked colors = damping mechanisms (hover for values)"
    >
      <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 40)}>
        <BarChart data={rows} layout="vertical" margin={{ ...CHART_MARGIN, left: 36, right: 24 }}>
          <XAxis type="number" tick={{ fill: '#64748b', fontSize: 10 }} />
          <YAxis type="category" dataKey="mode" width={36} tick={{ fill: '#94a3b8', fontSize: 11 }} />
          <Tooltip
            content={<SideTooltip />}
            cursor={{ fill: 'rgba(148, 163, 184, 0.08)' }}
            wrapperStyle={{ outline: 'none', zIndex: 20 }}
            allowEscapeViewBox={{ x: true, y: true }}
            formatter={(value: number, name: string) => [
              Math.abs(value).toFixed(4),
              DAMP_LABELS[name] ?? name,
            ]}
          />
          <Bar dataKey="driving" name="driving" fill={UNSTABLE} stackId="a" />
          <Bar dataKey="noz" name="noz" fill={DAMP_COLORS.noz} stackId="b" />
          <Bar dataKey="visc" name="visc" fill={DAMP_COLORS.visc} stackId="b" />
          <Bar dataKey="inj" name="inj" fill={DAMP_COLORS.inj} stackId="b" />
          <Bar dataKey="twophase" name="twophase" fill={DAMP_COLORS.twophase} stackId="b" />
        </BarChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-2 mt-2 text-[10px] text-[var(--color-text-secondary)]">
        {rows.map((r) => (
          <span key={r.mode} style={{ color: r.alpha < 0 ? STABLE : r.alpha < 5 ? MARGINAL : UNSTABLE }}>
            {r.mode} α={r.alpha.toFixed(0)}
          </span>
        ))}
      </div>
    </VizCard>
  );
}
