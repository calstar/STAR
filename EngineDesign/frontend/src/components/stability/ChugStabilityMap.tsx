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
      subtitle="Stiffer injector (higher η_inj) and shorter lag (lower τ/θ_c) → more stable"
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
    </VizCard>
  );
}
