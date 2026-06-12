import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE, MUTED } from './shared';

/** Needle in lower semicircle = Rayleigh driving band. */
function isDrivingPhase(omegaTau: number): boolean {
  const ang = ((omegaTau % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return ang > Math.PI / 2 && ang < (3 * Math.PI) / 2;
}

export function PhaseClock({ data }: { data: StabilityRichPayload }) {
  const cx = 100;
  const cy = 92;
  const r = 68;

  const chi = data.assumptions.chi_acoustic;
  const n = data.assumptions.n;
  const tauVap = data.vaporization.tau_conv_s;
  const tauSens = data.vaporization.tau_sens_s ?? (tauVap != null ? chi * tauVap : undefined);
  const drivingModes = data.phase.filter((p) => isDrivingPhase(p.omega_tau));

  // Explicit top/bottom rects clipped to circle — avoids SVG arc sweep flipping halves
  const topHalf = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} L ${cx} ${cy} Z`;
  const botHalf = `M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy} L ${cx} ${cy} Z`;

  return (
    <VizCard title="Phase clock" subtitle="ωτ dial — bottom red = Rayleigh driving band">
      <svg viewBox="0 0 200 175" className="w-full h-[155px]" preserveAspectRatio="xMidYMid meet">
        <path d={topHalf} fill={STABLE} opacity={0.2} />
        <path d={botHalf} fill={UNSTABLE} opacity={0.2} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="#475569" />
        <line x1={cx - r} y1={cy} x2={cx + r} y2={cy} stroke="#475569" strokeDasharray="3 3" opacity={0.5} />
        <text x={cx} y={cy - r + 12} fill={STABLE} fontSize={8} textAnchor="middle">
          damping
        </text>
        <text x={cx} y={cy + r - 4} fill={UNSTABLE} fontSize={8} textAnchor="middle">
          driving
        </text>
        {data.phase.map((p) => {
          const ang = p.omega_tau % (2 * Math.PI);
          const driving = isDrivingPhase(p.omega_tau);
          const color = driving ? UNSTABLE : STABLE;
          const x2 = cx + r * 0.8 * Math.cos(ang - Math.PI / 2);
          const y2 = cy + r * 0.8 * Math.sin(ang - Math.PI / 2);
          const lx = cx + (r + 11) * Math.cos(ang - Math.PI / 2);
          const ly = cy + (r + 11) * Math.sin(ang - Math.PI / 2);
          return (
            <g key={p.mode}>
              <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={color} strokeWidth={2} opacity={0.9} />
              <text x={lx} y={ly + 3} fill={MUTED} fontSize={8} textAnchor="middle">
                {p.mode}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="border-t border-[var(--color-border)] pt-2 space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
        <p style={{ color: drivingModes.length > 0 ? UNSTABLE : STABLE }}>
          {drivingModes.length > 0
            ? `${drivingModes.length} mode${drivingModes.length > 1 ? 's' : ''} in driving half: ${drivingModes.map((m) => m.mode).join(', ')} — see acoustic α`
            : 'All modes in damping half (green needles)'}
        </p>
        <p className="font-mono text-[10px] text-[var(--color-text-primary)]">
          ωτ = 2π · f<sub>mode</sub> · τ<sub>sens</sub>
        </p>
        {tauSens != null && tauVap != null && (
          <p className="font-mono text-[10px]">
            τ<sub>sens</sub> = χ·τ<sub>vap</sub> = {chi.toFixed(2)} × {(tauVap * 1e3).toFixed(1)} ms ={' '}
            <span className="text-[var(--color-text-primary)]">{(tauSens * 1e3).toFixed(1)} ms</span>
            {' · '}χ={chi.toFixed(2)}, n={n.toFixed(2)}
          </p>
        )}
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
          {data.phase.map((p) => (
            <span key={p.mode} style={{ color: isDrivingPhase(p.omega_tau) ? UNSTABLE : STABLE }}>
              {p.mode} {(p.omega_tau / Math.PI).toFixed(1)}π
            </span>
          ))}
        </div>
        <p className="text-[10px] opacity-85 leading-snug">
          Rayleigh: heat release q′ in phase with p′ drives growth. Needle maps ωτ = 2πfτ<sub>sens</sub>; worst
          driving near ωτ ≈ π.
        </p>
      </div>
    </VizCard>
  );
}
