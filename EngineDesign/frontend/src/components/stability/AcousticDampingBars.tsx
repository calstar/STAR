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
    freq_hz: m.freq_hz,
  }));
  rows.sort((a, b) => a.freq_hz - b.freq_hz);

  return (
    <VizCard
      title="Acoustic damping budget"
      subtitle="Red: combustion driving. Colours: damping. Report only."
      info={<>
        <span className="block">α is the net growth rate, driving minus damping: below zero a mode decays, above it grows. Modes are ordered by frequency; hover a bar for its terms.</span>
        <span className="block">The injector-face and two-phase damping are fixed fractions of π·f ({data.assumptions.damping_injector_frac ?? '?'} and {data.assumptions.damping_twophase_frac ?? '?'}), uncalibrated. Rate high-frequency stability by test: ≥ 25 kHz Pc, pulse or bomb.</span>
      </>}
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
      <table className="w-full mt-3 text-[11px]">
        <thead>
          <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="font-medium text-left pb-1">mode</th>
            <th className="font-medium text-right pb-1">f [Hz]</th>
            <th className="font-medium text-right pb-1">α [1/s]</th>
            <th className="font-medium text-right pb-1">state</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = r.alpha < 0 ? STABLE : r.alpha < 5 ? MARGINAL : UNSTABLE;
            return (
              <tr key={r.mode}>
                <td className="py-0.5 font-mono text-[var(--color-text-primary)]">{r.mode}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">
                  {Number.isFinite(r.freq_hz) ? r.freq_hz.toFixed(0) : '—'}
                </td>
                <td className="py-0.5 text-right font-mono" style={{ color }}>
                  {r.alpha > 0 ? '+' : ''}
                  {r.alpha.toFixed(0)}
                </td>
                <td className="py-0.5 text-right" style={{ color }}>
                  {r.alpha < 0 ? 'damped' : 'driven'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(() => {
        // How much of each verdict rests on the two assumed damping terms (injector face, two-phase:
        // fixed fractions of π·f with no closed form, uncalibrated).
        const shares = data.acoustic.modes.map((m) => {
          const tot = m.damping.noz + m.damping.visc + m.damping.inj + m.damping.twophase;
          return tot > 0 ? (m.damping.inj + m.damping.twophase) / tot : NaN;
        }).filter(Number.isFinite);
        if (!shares.length) return null;
        return (
          <p className="text-[11px] mt-2" style={{ color: MARGINAL }}>
            ◇ {Math.round(100 * Math.min(...shares))}–{Math.round(100 * Math.max(...shares))} % of the damping is assumed.
          </p>
        );
      })()}
    </VizCard>
  );
}
