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

/** Round ticks (1/2/5 x 10^k) from `lo` up to the first one at or above `hi`. */
function niceTicks(lo: number, hi: number, target = 4): number[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [lo, lo + 1];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step - 1e-9 * step; v += step) out.push(+v.toPrecision(12));
  if (out[out.length - 1] < hi) out.push(+(out[out.length - 1] + step).toPrecision(12));
  return out;
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

  // The design in the boundary's own frame (mass-weighted stiffness and lag, both scaled from the
  // design): one point, nominal mixing lag, and a second at the mixing lag the gate is taken at.
  const dp = data.chug.design_point;
  const system = dp != null && Number.isFinite(dp.eta) && Number.isFinite(dp.tau_theta_c);
  const gateY = dp?.gate_tau_theta_c;
  // The y range is set by the design and gate points, with room above them: the question the chart
  // answers is how far the design sits below the boundary at its own stiffness. Where the injector
  // is stiff the boundary climbs steeply out of that range (it is computed up to 20x the design's
  // lag); it leaves through the top of the plot rather than being flattened along it. The old
  // range (the curve, capped at 4x the design) ran the curve flat along the top for a third of
  // the chart, which read as a boundary that stops rising.
  const anchors = system
    ? [dp!.tau_theta_c, gateY ?? 0]
    : [tauO, tauF];
  const yTop = Math.max(...anchors.filter((v) => Number.isFinite(v)), 0.1) * 2.4;
  const yTicks = niceTicks(0, yTop);
  const yMax = yTicks[yTicks.length - 1];

  const W = 300;
  const H = 220;
  const pad = { l: 44, r: 16, t: 14, b: 44 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const toX = (eta: number) => pad.l + ((eta - X_MIN) / (X_MAX - X_MIN)) * plotW;
  const toY = (tau: number) => pad.t + plotH - (tau / yMax) * plotH;
  const clipId = 'chug-map-clip';

  // Drawn at its true height and clipped to the plot.
  const boundaryPts = boundary.map(([eta, tau]) => `${toX(eta)},${toY(tau)}`).join(' ');
  // Where the boundary leaves the top of the plot, for a small arrow saying it carries on.
  const exitAt = (() => {
    for (let i = 1; i < boundary.length; i++) {
      const [e0, t0] = boundary[i - 1];
      const [e1, t1] = boundary[i];
      if (t0 <= yMax && t1 > yMax) return e0 + ((yMax - t0) / (t1 - t0)) * (e1 - e0);
    }
    return null;
  })();
  // The boundary is computed only where some lag up to its search limit goes unstable; at a
  // stiffer injector there is no boundary to draw, and the design can sit out there.
  const lastEta = boundary.length ? boundary[boundary.length - 1][0] : null;
  const endsEarly = lastEta != null && lastEta < X_MAX - 0.02 * (X_MAX - X_MIN);
  const beyondCurve = system && lastEta != null && dp!.eta > lastEta;

  const xTicks = Array.from({ length: 4 }, (_, i) => X_MIN + ((X_MAX - X_MIN) * (i + 0.5)) / 4);

  // The two markers sit on one vertical a few units apart; their labels used to print on top of
  // each other. Close together, "gate" goes above its ring and "design" below its dot.
  const designPy = system ? toY(dp!.tau_theta_c) : 0;
  const gatePy = system && gateY != null && Number.isFinite(gateY) ? toY(gateY) : null;
  const crowded = gatePy != null && Math.abs(gatePy - designPy) < 14;
  const labelX = system ? toX(dp!.eta) + 9 : 0;
  const labelAnchor: 'start' | 'end' = system && labelX > W - pad.r - 36 ? 'end' : 'start';
  const lx = labelAnchor === 'end' ? toX(dp!.eta) - 9 : labelX;

  return (
    <VizCard
      title="Chug stability boundary — stiffness vs lag"
      subtitle="Below the red curve is stable."
      info={<>
        <span className="block">Chug is one loop through both streams, so the design is one point: x is the flow-weighted injector ΔP/Pc, y the flow-weighted combustion lag over the gas residence time θ_c. The curve is where the loop's gain margin reaches 1 when every drop (x) or every lag (y) is scaled from this design.</span>
        <span className="block">Raise injector ΔP to move right; a finer spray shortens the lag and moves down. Lags in the table are in ms: {lagModel === 'd2_law' ? 'the quiescent d²-law droplet lifetime' : 'τ = τ_at + τ_vap + τ_mix (Leonardi et al., Acta Astronautica 139, 2017)'}.</span>
      </>}
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
              {Number.isInteger(t) ? t : t.toFixed(1)}
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

        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* marginal boundary, clipped to the plot */}
        {boundary.length > 1 && (
          <polyline
            points={boundaryPts}
            fill="none"
            stroke={UNSTABLE}
            strokeWidth={2.5}
            clipPath={`url(#${clipId})`}
          />
        )}
        {exitAt != null && (
          <g>
            <path d={`M ${toX(exitAt) - 4} ${pad.t + 7} L ${toX(exitAt)} ${pad.t + 1} L ${toX(exitAt) + 4} ${pad.t + 7}`}
                  fill="none" stroke={UNSTABLE} strokeWidth={1.5} />
            <text x={toX(exitAt) + 7} y={pad.t + 9} fill={UNSTABLE} fontSize={8}>continues above</text>
          </g>
        )}

        {system ? (
          <>
            {gatePy != null && (
              <>
                <line x1={toX(dp!.eta)} y1={designPy} x2={toX(dp!.eta)} y2={gatePy} stroke="#e2e8f0" strokeDasharray="2 2" />
                <circle cx={toX(dp!.eta)} cy={gatePy} r={6} fill="none" stroke="#e2e8f0" strokeWidth={1.5} />
                <text x={lx} y={crowded ? Math.min(gatePy, designPy) - 8 : gatePy + 4} fill="#e2e8f0" fontSize={9} textAnchor={labelAnchor}>gate</text>
              </>
            )}
            <circle cx={toX(dp!.eta)} cy={designPy} r={6} fill="#e2e8f0" stroke="#0f172a" strokeWidth={1.5} />
            <text x={lx} y={crowded ? Math.max(gatePy!, designPy) + 14 : designPy + 4} fill="#e2e8f0" fontSize={9} textAnchor={labelAnchor}>design</text>
          </>
        ) : (
          <>
            <circle cx={toX(etaO)} cy={toY(tauO)} r={7} fill={STREAM_COLORS.O} stroke="#fff" strokeWidth={1.5} />
            <circle cx={toX(etaF)} cy={toY(tauF)} r={7} fill={STREAM_COLORS.F} stroke="#fff" strokeWidth={1.5} />
          </>
        )}
      </svg>

      {/* legend below plot — no overlap with axis title */}
      <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-text-secondary)] -mt-1 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-0.5 bg-red-500 rounded" /> marginal boundary
        </span>
        {system && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-2.5 h-2.5 rounded-full bg-slate-200" /> design, nominal mixing lag
            {gateY != null && <><span className="inline-block w-2.5 h-2.5 rounded-full border border-slate-200 ml-2" /> at the gate's mixing lag ({(dp!.gate_mixing_fraction ?? 0).toFixed(2)})</>}
          </span>
        )}
      </div>

      {endsEarly && (
        <p className="text-xs text-[var(--color-text-secondary)] mb-1">
          The boundary ends at η {lastEta!.toFixed(2)}: at a stiffer injector no lag up to 20× the design's makes the loop unstable.
          {beyondCurve && <> The design, at η {dp!.eta.toFixed(2)}, is past it.</>}
        </p>
      )}
      <p className="text-xs text-[var(--color-text-secondary)]">
        {system ? <>mean η = {dp!.eta.toFixed(3)} (O {etaO.toFixed(2)}, F {etaF.toFixed(2)})</> : <>O η={etaO.toFixed(2)} F η={etaF.toFixed(2)}</>}
        {' · gain margin '}
        <span style={{ color: data.chug.margin >= 1.05 ? STABLE : UNSTABLE }}>
          {data.chug.margin.toFixed(3)}
        </span>
        <span className="opacity-70"> at the gate, {(data.chug.gain_margin_nominal ?? NaN).toFixed(3)} nominal</span>
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
    </VizCard>
  );
}
