import type { StabilityRichPayload } from './types';
import { VizCard, MUTED, STABLE, UNSTABLE } from './shared';

const STREAM_COLORS: Record<string, string> = { O: '#38bdf8', F: '#a78bfa' };

/** Fallback sweep window when the backend did not send one (old payloads). */
const DEFAULT_X_MIN = 0.08;
const DEFAULT_X_MAX = 0.45;

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

  // Stream identity comes from the config, never from this file. The labels used to read
  // "O (LOX)" and "F (fuel)" on every engine, including ones burning neither.
  const nameO = designO?.fluid ?? data.assumptions.fluid_O ?? 'oxidizer';
  const nameF = designF?.fluid ?? data.assumptions.fluid_F ?? 'fuel';
  const phaseO = designO?.phase ?? data.assumptions.phase_O;
  const phaseF = designF?.phase ?? data.assumptions.phase_F;
  const lagModel = data.chug.lag_model ?? data.assumptions.time_lag_model;

  // Sweep window follows the design point (backend-supplied), so the dots stay on the chart.
  const [X_MIN, X_MAX] = data.chug.eta_window ?? [DEFAULT_X_MIN, DEFAULT_X_MAX];

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
  const xTicks = Array.from({ length: 4 }, (_, i) => X_MIN + ((X_MAX - X_MIN) * (i + 0.5)) / 4);

  return (
    <VizCard
      title="Chug stability boundary — stiffness vs lag"
      subtitle="Design plane, not the s-plane: each dot is one propellant stream. Below the red curve = stable. Eigenvalues are in the root-locus card."
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
              {t.toFixed(2)}
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
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STREAM_COLORS.O }} /> O · {nameO}
          {phaseO === 'gas' ? ' (gas)' : ''}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: STREAM_COLORS.F }} /> F · {nameF}
          {phaseF === 'gas' ? ' (gas)' : ''}
        </span>
      </div>

      <p className="text-xs text-[var(--color-text-secondary)]">
        O η={etaO.toFixed(2)} F η={etaF.toFixed(2)} · margin{' '}
        <span style={{ color: data.chug.margin >= 1.05 ? STABLE : UNSTABLE }}>
          {data.chug.margin.toFixed(3)}
        </span>
        <span className="opacity-70"> (below red = stable)</span>
      </p>


      {/* Per-stream coordinates, and the lag decomposition that produced the y coordinate.
          τ is a sum (Leonardi 2017 eq. 5), so showing only the total hides which term to attack. */}
      <table className="w-full mt-3 text-[11px]">
        <thead>
          <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="font-medium text-left pb-1">stream</th>
            <th className="font-medium text-right pb-1">η_inj</th>
            <th className="font-medium text-right pb-1" title="atomization lag">τ_at</th>
            <th className="font-medium text-right pb-1" title="vaporization lag">τ_vap</th>
            <th className="font-medium text-right pb-1" title="mixing lag">τ_mix</th>
            <th className="font-medium text-right pb-1">τ / θ_c</th>
          </tr>
        </thead>
        <tbody>
          {[
            { key: 'O', label: nameO, phase: phaseO, eta: etaO, tau: tauO, color: STREAM_COLORS.O, d: designO },
            { key: 'F', label: nameF, phase: phaseF, eta: etaF, tau: tauF, color: STREAM_COLORS.F, d: designF },
          ].map((s) => {
            const ms = (v: number | null | undefined) =>
              typeof v === 'number' && Number.isFinite(v) ? (v * 1000).toFixed(2) : '—';
            return (
              <tr key={s.key}>
                <td className="py-0.5">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: s.color }} />
                  <span className="text-[var(--color-text-primary)]">{s.label}</span>
                  {s.phase === 'gas' && (
                    <span className="ml-1 text-[9px] text-[var(--color-text-secondary)]">gas</span>
                  )}
                </td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{s.eta.toFixed(2)}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{ms(s.d?.tau_atom_s)}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{ms(s.d?.tau_vap_s)}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">{ms(s.d?.tau_mix_s)}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-primary)]">{s.tau.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[9.5px] text-[var(--color-text-secondary)] mt-1 opacity-80">
        τ terms in ms.{' '}
        {lagModel === 'leonardi_dtl'
          ? 'Double time lag τ = τ_at + τ_vap + τ_mix (Leonardi et al., Acta Astronautica 139, 2017). A gas-phase propellant carries only τ_mix.'
          : lagModel === 'd2_law'
            ? 'Quiescent d²-law droplet lifetime — no atomization or mixing term.'
            : ''}
      </p>

      <p className="text-[10px] text-[var(--color-text-secondary)] mt-2 leading-snug">
        Each dot is a propellant stream at its injector stiffness (x) and combustion lag (y). Dots
        below/right of the red marginal boundary are stable - the farther from the curve, the more
        chug margin. To push a stream safer: <span className="text-[var(--color-text-primary)]">raise injector ΔP</span>{' '}
        (η_inj → moves right) or <span className="text-[var(--color-text-primary)]">atomize finer</span>{' '}
        (smaller SMD shortens the lag → moves down).
      </p>
    </VizCard>
  );
}
