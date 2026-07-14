import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE, DESIGN, MUTED, marginColor } from './shared';

interface Props {
  data: StabilityRichPayload;
}

export function ChugPoleMap({ data }: Props) {
  const pole = data.chug.pole ?? {
    real: data.chug.alpha ?? NaN,
    imag: (data.chug.freq_hz ?? 0) * 2 * Math.PI,
  };
  const sigma = pole.real ?? NaN;
  const omega = pole.imag ?? NaN;

  if (!Number.isFinite(sigma) || !Number.isFinite(omega)) {
    return (
      <VizCard title="s-plane pole map" subtitle="Dominant chug pole — left half = stable">
        <p className="text-xs text-[var(--color-text-secondary)]">Pole data unavailable for this evaluation.</p>
      </VizCard>
    );
  }

  // Auto-fit so a strongly damped pole (large |σ|) stays visible
  const sigmaMin = Math.min(sigma * 1.15, -Math.max(Math.abs(sigma) * 0.05, 8));
  const sigmaMax = Math.max(8, Math.abs(sigma) * 0.05);
  const omegaMax = Math.max(omega * 1.15, 50);

  const W = 260;
  const H = 200;
  const pad = { l: 36, r: 12, t: 18, b: 28 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const toX = (s: number) => pad.l + ((s - sigmaMin) / (sigmaMax - sigmaMin)) * plotW;
  const toY = (w: number) => pad.t + plotH - (w / omegaMax) * plotH;
  const axisX = toX(0);
  const px = toX(sigma);
  const py = toY(omega);
  const freqHz = omega / (2 * Math.PI);
  const stable = sigma < 0;
  const zeta = data.chug.zeta;
  const decayMs = stable && Math.abs(sigma) > 1 ? (1000 / Math.abs(sigma)).toFixed(0) : null;

  return (
    <VizCard
      title="s-plane pole map"
      subtitle="Complex root of the chug loop — blue dot = dominant pole"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[180px]" preserveAspectRatio="xMidYMid meet">
        <rect x={pad.l} y={pad.t} width={axisX - pad.l} height={plotH} fill={STABLE} opacity={0.1} />
        <rect x={axisX} y={pad.t} width={pad.l + plotW - axisX} height={plotH} fill={UNSTABLE} opacity={0.08} />
        <line x1={axisX} y1={pad.t} x2={axisX} y2={pad.t + plotH} stroke="#475569" strokeDasharray="4 4" />
        <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="#475569" strokeDasharray="4 4" />
        <text x={pad.l} y={12} fill={MUTED} fontSize={10}>
          Im(s) = ω [rad/s]
        </text>
        <text x={pad.l + plotW - 48} y={H - 6} fill={MUTED} fontSize={10}>
          Re(s) = σ
        </text>
        <text x={pad.l + 2} y={pad.t + 12} fill={MUTED} fontSize={9}>
          stable
        </text>
        <text x={axisX + 4} y={pad.t + 12} fill={MUTED} fontSize={9}>
          unstable
        </text>
        <circle cx={px} cy={py} r={7} fill={DESIGN} stroke="#fff" strokeWidth={2} />
        <text x={px + 10} y={py - 6} fill={DESIGN} fontSize={10} fontWeight={600}>
          pole
        </text>
      </svg>

      <div className="border-t border-[var(--color-border)] pt-2 space-y-1 text-[11px] text-[var(--color-text-secondary)]">
        <p style={{ color: stable ? STABLE : UNSTABLE }}>
          <span className="font-semibold">{stable ? 'Stable' : 'Unstable'}</span>
          {decayMs != null ? ` — e-fold ≈ ${decayMs} ms` : ''}
        </p>
        <p className="font-mono text-[10px] text-[var(--color-text-primary)]">
          σ={sigma.toFixed(1)} ω={omega.toFixed(0)} rad/s ({freqHz.toFixed(0)} Hz)
          {zeta != null && Number.isFinite(zeta) ? ` · ζ=${zeta.toFixed(3)}` : ''}
          {' · '}
          <span style={{ color: marginColor(data.chug.margin) }}>margin {data.chug.margin.toFixed(3)}</span>
        </p>
        <p className="text-[10px] opacity-80 leading-snug">
          Left of axis = decaying chug root (σ&lt;0). Stiffness map shows margin; this confirms sign &amp; frequency.
        </p>
      </div>
    </VizCard>
  );
}
