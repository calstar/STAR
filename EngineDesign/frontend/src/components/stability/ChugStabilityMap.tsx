import type { StabilityRichPayload } from './types';
import { VizCard, MUTED, STABLE, UNSTABLE } from './shared';

const STREAM_COLORS = { O: '#38bdf8', F: '#a78bfa' };
const X_MIN = 0.08;
const X_MAX = 0.45;

interface Props {
  data: StabilityRichPayload;
  etaInjOverride?: number;
}

export function ChugStabilityMap({ data, etaInjOverride }: Props) {
  const boundary = data.chug.boundary_curve;
  const streams = data.chug.design_streams ?? [
    { stream: 'O', eta_inj: data.assumptions.eta_inj_O, tau_theta_c: 0 },
    { stream: 'F', eta_inj: data.assumptions.eta_inj_F, tau_theta_c: 0 },
  ];
  const designO = streams.find((s) => s.stream === 'O');
  const designF = streams.find((s) => s.stream === 'F');
  const etaO = etaInjOverride ?? designO?.eta_inj ?? data.assumptions.eta_inj_O;
  const tauO = designO?.tau_theta_c ?? 0;
  const etaF = designF?.eta_inj ?? data.assumptions.eta_inj_F;
  const tauF = designF?.tau_theta_c ?? tauO;

  // Dominant chug pole (folded in from the former s-plane map): σ = growth rate, ω = 2πf.
  const sigma = data.chug.pole?.real ?? data.chug.alpha ?? NaN;
  const omega = data.chug.pole?.imag ?? (data.chug.freq_hz ?? 0) * 2 * Math.PI;
  const poleFinite = Number.isFinite(sigma) && Number.isFinite(omega);
  const poleStable = sigma < 0;
  const poleFreqHz = omega / (2 * Math.PI);
  const decayMs = poleStable && Math.abs(sigma) > 1 ? (1000 / Math.abs(sigma)).toFixed(0) : null;
  const zeta = data.chug.zeta;
  const zetaStr = typeof zeta === 'number' && Number.isFinite(zeta) ? ` · ζ=${zeta.toFixed(3)}` : '';

  const yMax = Math.max(
    ...boundary.map(([, t]) => t),
    tauO,
    tauF,
    1,
  ) * 1.12;

  const W = 300;
  const H = 220;
  const pad = { l: 44, r: 16, t: 14, b: 44 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const toX = (eta: number) => pad.l + ((eta - X_MIN) / (X_MAX - X_MIN)) * plotW;
  const toY = (tau: number) => pad.t + plotH - (tau / yMax) * plotH;

  const boundaryPts = boundary
    .map(([eta, tau]) => `${toX(eta)},${toY(tau)}`)
    .join(' ');

  const yTicks = [0, yMax * 0.33, yMax * 0.66, yMax].map((v) => Math.round(v * 10) / 10);
  const xTicks = [0.1, 0.2, 0.3, 0.4];

  return (
    <VizCard
      title="Injector stiffness map"
      subtitle="Stiffer injector (higher η_inj) and shorter lag (lower τ/θ_c) → more stable; dominant chug pole below"
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: H }}>
        {/* grid */}
        {yTicks.map((t) => (
          <g key={`y-${t}`}>
            <line
              x1={pad.l}
              y1={toY(t)}
              x2={pad.l + plotW}
              y2={toY(t)}
              stroke="#334155"
              strokeDasharray="3 3"
            />
            <text x={pad.l - 6} y={toY(t) + 4} fill={MUTED} fontSize={9} textAnchor="end">
              {t.toFixed(1)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={`x-${t}`}>
            <line
              x1={toX(t)}
              y1={pad.t}
              x2={toX(t)}
              y2={pad.t + plotH}
              stroke="#334155"
              strokeDasharray="3 3"
            />
            <text x={toX(t)} y={H - 22} fill={MUTED} fontSize={9} textAnchor="middle">
              {t.toFixed(1)}
            </text>
          </g>
        ))}

        {/* axes */}
        <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="#475569" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="#475569" />
        <text x={pad.l + plotW / 2} y={H - 6} fill={MUTED} fontSize={10} textAnchor="middle">
          η_inj = ΔP_inj / Pc
        </text>
        <text
          x={12}
          y={pad.t + plotH / 2}
          fill={MUTED}
          fontSize={10}
          textAnchor="middle"
          transform={`rotate(-90, 12, ${pad.t + plotH / 2})`}
        >
          τ / θ_c
        </text>

        {/* marginal boundary */}
        {boundary.length > 1 && (
          <polyline
            points={boundaryPts}
            fill="none"
            stroke={UNSTABLE}
            strokeWidth={2.5}
          />
        )}

        {/* design dots */}
        <circle cx={toX(etaO)} cy={toY(tauO)} r={7} fill={STREAM_COLORS.O} stroke="#fff" strokeWidth={1.5} />
        <text x={toX(etaO) + 10} y={toY(tauO) + 4} fill={STREAM_COLORS.O} fontSize={9}>
          O
        </text>
        <circle cx={toX(etaF)} cy={toY(tauF)} r={7} fill={STREAM_COLORS.F} stroke="#fff" strokeWidth={1.5} />
        <text x={toX(etaF) + 10} y={toY(tauF) + 4} fill={STREAM_COLORS.F} fontSize={9}>
          F
        </text>
      </svg>

      {/* legend below plot — no overlap with axis title */}
      <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-text-secondary)] -mt-1 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-0.5 bg-red-500 rounded" /> marginal boundary
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STREAM_COLORS.O }} /> O (LOX)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STREAM_COLORS.F }} /> F (fuel)
        </span>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)]">
        O η={etaO.toFixed(2)} F η={etaF.toFixed(2)} · margin{' '}
        <span style={{ color: data.chug.margin >= 1.05 ? STABLE : UNSTABLE }}>
          {data.chug.margin.toFixed(3)}
        </span>
        <span className="opacity-70"> (below red = stable)</span>
      </p>

      {/* Dominant chug pole — confirms the sign & frequency behind the margin (former s-plane card). */}
      {poleFinite ? (
        <p className="text-[11px] mt-1 font-mono" style={{ color: poleStable ? STABLE : UNSTABLE }}>
          pole {poleStable ? 'stable' : 'unstable'} σ={sigma.toFixed(1)} ω={omega.toFixed(0)} rad/s (
          {poleFreqHz.toFixed(0)} Hz)
          {zetaStr}
          {decayMs != null ? ` · e-fold ≈ ${decayMs} ms` : ''}
        </p>
      ) : (
        <p className="text-[11px] mt-1 text-[var(--color-text-secondary)] opacity-70">
          pole data unavailable for this evaluation
        </p>
      )}

      {/* per-stream coordinates that put the dots on the map */}
      <table className="w-full mt-3 text-[11px]">
        <thead>
          <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="font-medium text-left pb-1">stream</th>
            <th className="font-medium text-right pb-1">η_inj = ΔP/Pc</th>
            <th className="font-medium text-right pb-1">τ / θ_c</th>
          </tr>
        </thead>
        <tbody>
          {[
            { stream: 'O (LOX)', eta: etaO, tau: tauO, color: STREAM_COLORS.O },
            { stream: 'F (fuel)', eta: etaF, tau: tauF, color: STREAM_COLORS.F },
          ].map((s) => (
            <tr key={s.stream}>
              <td className="py-0.5">
                <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: s.color }} />
                <span className="text-[var(--color-text-primary)]">{s.stream}</span>
              </td>
              <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{s.eta.toFixed(2)}</td>
              <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{s.tau.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="text-[10px] text-[var(--color-text-secondary)] mt-2 leading-snug">
        Each dot is a propellant stream at its injector stiffness (x) and combustion lag (y). Dots
        below/right of the red marginal boundary are stable — the farther from the curve, the more
        chug margin. To push a stream safer: <span className="text-[var(--color-text-primary)]">raise injector ΔP</span>{' '}
        (η_inj → moves right) or <span className="text-[var(--color-text-primary)]">atomize finer</span>{' '}
        (smaller SMD shortens the lag → moves down).
      </p>
      {poleFinite && (
        <p className="text-[10px] text-[var(--color-text-secondary)] mt-1 leading-snug">
          The pole is the actual root of the chug loop: σ&lt;0 means any chug oscillation decays
          {decayMs != null ? `, shrinking ~3× every ${decayMs} ms` : ''}. ζ is its damping ratio
          (higher = better damped).
        </p>
      )}
    </VizCard>
  );
}
