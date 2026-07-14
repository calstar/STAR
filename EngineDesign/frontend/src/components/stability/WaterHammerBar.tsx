import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE } from './shared';

export function WaterHammerBar({ data }: { data: StabilityRichPayload }) {
  const wh = data.water_hammer;
  const spike = wh.spike_psi;
  const avail = wh.available_dp_psi;
  const ok = spike <= avail;
  const ratio = avail > 0 ? spike / avail : Infinity;
  const maxVal = Math.max(spike, avail, 1);

  const rows = [
    { name: 'Joukowsky spike', psi: spike, pct: (spike / maxVal) * 100, color: ok ? STABLE : UNSTABLE },
    { name: 'Available feed ΔP', psi: avail, pct: (avail / maxVal) * 100, color: '#64748b' },
  ];

  return (
    <VizCard title="Water hammer" subtitle="Valve transient — not combustion stability">
      <p className={`text-sm mb-3 ${ok ? 'text-green-400' : 'text-red-400'}`}>
        {ok
          ? `Spike ${spike.toFixed(0)} psi ≤ available ${avail.toFixed(0)} psi`
          : `Spike ${spike.toFixed(0)} psi exceeds available ${avail.toFixed(0)} psi (${ratio.toFixed(1)}×)`}
      </p>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.name}>
            <div className="flex justify-between text-xs text-[var(--color-text-secondary)] mb-1">
              <span>{row.name}</span>
              <span className="font-mono text-[var(--color-text-primary)]">{row.psi.toFixed(0)} psi</span>
            </div>
            <div className="h-5 rounded bg-[var(--color-bg-primary)] overflow-hidden">
              <div
                className="h-full rounded transition-all"
                style={{ width: `${Math.max(row.pct, avail > 0 && row.name.includes('Available') ? 2 : 0.5)}%`, backgroundColor: row.color }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-[10px] text-[var(--color-text-secondary)] mt-3 opacity-80">
        Bars scaled independently for readability; compare absolute psi values above.
      </p>
    </VizCard>
  );
}
