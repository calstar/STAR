import type { StabilityRichPayload } from './types';
import { VizCard, DESIGN, MUTED } from './shared';

export function FrequencyLadder({ data }: { data: StabilityRichPayload }) {
  const entries: { label: string; hz: number; kind: string }[] = [
    { label: 'chug', hz: data.chug.freq_hz ?? 0, kind: 'chug' },
    ...data.acoustic.modes.map((m) => ({ label: m.name, hz: m.freq_hz, kind: 'acoustic' })),
  ].filter((e) => Number.isFinite(e.hz) && e.hz > 0);
  entries.sort((a, b) => a.hz - b.hz);
  const maxHz = Math.max(...entries.map((e) => e.hz), 1);

  const labelW = 36;
  const barX = labelW + 8;
  const barW = 160;
  const hzLabelW = 52;
  const W = barX + barW + hzLabelW + 8;
  const H = Math.max(120, entries.length * 28 + 32);

  return (
    <VizCard title="Frequency ladder" subtitle="Campbell-style mode ordering">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: H }}>
        {entries.map((e, i) => {
          const y = 24 + i * 28;
          const xEnd = barX + (e.hz / maxHz) * barW;
          return (
            <g key={`${e.label}-${e.hz}`}>
              <text x={4} y={y + 4} fill="#94a3b8" fontSize={11}>
                {e.label}
              </text>
              <line
                x1={barX}
                y1={y}
                x2={xEnd}
                y2={y}
                stroke={e.kind === 'chug' ? '#f59e0b' : DESIGN}
                strokeWidth={2}
              />
              <text
                x={barX + barW + 6}
                y={y + 4}
                fill={MUTED}
                fontSize={10}
                textAnchor="start"
              >
                {e.hz.toFixed(0)} Hz
              </text>
            </g>
          );
        })}
      </svg>
    </VizCard>
  );
}
