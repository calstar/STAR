import type { StabilityRichPayload } from './types';
import { VizCard, MUTED, STABLE, UNSTABLE, DESIGN } from './shared';

/**
 * Root locus of the chug loop in the s-plane.
 *
 * The characteristic equation is 1 + L(s) = 0 with L the open-loop transfer of the
 * feed -> injector -> chamber -> combustion path. Each point on the branch is an
 * eigenvalue s = sigma + j*omega of that closed loop at one value of the swept gain,
 * eta_inj = dP_inj/Pc. The imaginary axis is the stability boundary: sigma < 0 (left
 * half-plane) means any chug oscillation decays.
 *
 * This replaces a chart that plotted a marginal boundary in (eta, tau/theta_c) and
 * mentioned the pole only as a line of text underneath — which showed neither the
 * eigenvalues nor the axis they have to stay left of.
 */

const ZETA_RAYS = [0.1, 0.3, 0.5];

interface Props {
  data: StabilityRichPayload;
}

export function ChugRootLocus({ data }: Props) {
  const locus = data.chug.root_locus ?? [];
  const poleSigma = data.chug.pole?.real ?? data.chug.alpha ?? NaN;
  const poleOmega = data.chug.pole?.imag ?? (data.chug.freq_hz ?? 0) * 2 * Math.PI;
  const havePole = Number.isFinite(poleSigma) && Number.isFinite(poleOmega);
  const critical = data.chug.eta_critical;

  if (locus.length < 2 && !havePole) {
    return (
      <VizCard title="Chug root locus" subtitle="s-plane eigenvalues of the chug loop">
        <p className="text-xs text-[var(--color-text-secondary)]">
          The chug root-find did not converge for this evaluation, so there is no locus to draw.
        </p>
      </VizCard>
    );
  }

  const sigmas = locus.map((p) => p.real).concat(havePole ? [poleSigma] : []);
  const omegas = locus.map((p) => p.imag).concat(havePole ? [poleOmega] : []);

  // Keep sigma = 0 inside the frame always — the whole point of the chart is which side of it
  // the eigenvalues sit on, so the boundary must never be cropped out.
  const sMin = Math.min(...sigmas, 0);
  const sMax = Math.max(...sigmas, 0);
  const sPad = Math.max((sMax - sMin) * 0.18, Math.abs(sMax - sMin) < 1e-9 ? 1 : 0);
  const xMin = sMin - sPad;
  const xMax = sMax + sPad;
  // ZOOM OMEGA TO THE DATA. Pinning yMin to 0 put this locus (omega 400-460 rad/s) into the
  // top 11 % of the frame and left the other 89 % empty, which makes a shallow arc read as a
  // flat line. Only pull the floor to 0 when the data actually goes near it.
  const wLo = Math.min(...omegas);
  const wHi = Math.max(...omegas, 1);
  const wSpan = Math.max(wHi - wLo, wHi * 0.08, 1);
  const yFloor = wLo - wSpan * 0.45;
  const yMin = yFloor < wHi * 0.12 ? 0 : yFloor;
  const yMax = wHi + wSpan * 0.35;

  // Frame. The right margin has to hold BOTH the Hz mirror ticks and the rotated Hz axis
  // title: at r = 30 the title was laid out from x = 283.8 to x = 346.2 against a 320-wide
  // viewBox, i.e. 26 px outside it, and got clipped.
  const W = 348;
  const H = 264;
  const pad = { l: 56, r: 54, t: 26, b: 52 };
  const plotW = W - pad.l - pad.r;
  const plotH = H - pad.t - pad.b;

  const toX = (s: number) => pad.l + ((s - xMin) / (xMax - xMin)) * plotW;
  const toY = (w: number) => pad.t + plotH - ((w - yMin) / (yMax - yMin)) * plotH;

  const x0 = toX(0); // the stability boundary
  const clipId = 'locus-plot-clip';

  const branch = locus.map((p) => `${toX(p.real)},${toY(p.imag)}`).join(' ');

  // Ticks on round numbers (1/2/5 x 10^k), not on evenly-divided data extents — a growth-rate
  // axis reading "-42, -19, 4, 50" is unreadable and hides where zero is.
  const niceTicks = (lo: number, hi: number, target = 5): number[] => {
    const span = hi - lo;
    if (!Number.isFinite(span) || span <= 0) return [lo];
    const raw = span / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
    const first = Math.ceil(lo / step) * step;
    const out: number[] = [];
    for (let v = first; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return out;
  };
  const xTicks = niceTicks(xMin, xMax);
  const yTicks = niceTicks(yMin, yMax);
  const decimals = (ticks: number[]) => {
    const step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 1;
    return step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  };
  const xDec = decimals(xTicks);
  const yDec = decimals(yTicks);

  // Constant-zeta rays: zeta = -sigma/|s|, so the ray leaves the origin at angle
  // atan2(omega, sigma) with sigma = -zeta*r, omega = sqrt(1-zeta^2)*r. Each ray is clipped
  // where it leaves the frame, and labelled there, so the labels never pile up in a corner.
  const rays = ZETA_RAYS.map((z) => {
    const dirX = -z;
    const dirY = Math.sqrt(1 - z * z);
    // scale until the ray exits through the left edge or the top edge, whichever comes first
    const tLeft = dirX < 0 ? xMin / dirX : Infinity;
    const tTop = dirY > 0 ? yMax / dirY : Infinity;
    const t = Math.min(tLeft, tTop);
    const exitsTop = tTop <= tLeft;
    return { z, x: dirX * t, y: dirY * t, exitsTop };
  }).filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y));

  const arrowAt = locus.length > 3 ? locus[Math.floor(locus.length * 0.62)] : null;
  const arrowPrev = locus.length > 3 ? locus[Math.floor(locus.length * 0.62) - 1] : null;

  const fmt = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const poleStable = poleSigma < 0;
  const poleZeta = data.chug.zeta;
  const eFoldMs = Number.isFinite(poleSigma) && Math.abs(poleSigma) > 1e-6
    ? 1000 / Math.abs(poleSigma)
    : NaN;

  return (
    <VizCard
      title="Chug root locus (s-plane)"
      subtitle="Closed-loop eigenvalues s = σ + jω as injector stiffness η_inj sweeps. Left of the axis = stable."
    >
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minHeight: H }}>
        <defs>
          <marker id="locus-arrow" markerWidth="7" markerHeight="7" refX="4" refY="2.5"
                  orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L5,2.5 L0,5 z" fill={DESIGN} />
          </marker>
          {/* Zooming omega means the zeta rays leave from off-frame; clip them to the axes
              rather than letting them draw across the margins. */}
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={plotW} height={plotH} />
          </clipPath>
        </defs>

        {/* half-plane shading: the single most important thing on the chart */}
        <rect x={pad.l} y={pad.t} width={Math.max(0, x0 - pad.l)} height={plotH}
              fill={STABLE} opacity={0.07} />
        <rect x={x0} y={pad.t} width={Math.max(0, pad.l + plotW - x0)} height={plotH}
              fill={UNSTABLE} opacity={0.09} />

        {/* grid */}
        {yTicks.map((t, i) => (
          <g key={`y${i}`}>
            <line x1={pad.l} y1={toY(t)} x2={pad.l + plotW} y2={toY(t)}
                  stroke="#334155" strokeDasharray="2 4" />
            <text x={pad.l - 6} y={toY(t) + 3.5} fill={MUTED} fontSize={8.5} textAnchor="end">
              {t.toFixed(yDec)}
            </text>
            {/* right-hand mirror in Hz, so the frequency is readable off the chart itself */}
            <text x={pad.l + plotW + 4} y={toY(t) + 3.5} fill={MUTED} fontSize={7.5}
                  textAnchor="start" opacity={0.75}>
              {(t / (2 * Math.PI)).toFixed(0)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <g key={`x${i}`}>
            <line x1={toX(t)} y1={pad.t} x2={toX(t)} y2={pad.t + plotH}
                  stroke="#334155" strokeDasharray="2 4" />
            <text x={toX(t)} y={H - 30} fill={MUTED} fontSize={8.5} textAnchor="middle">
              {t.toFixed(xDec)}
            </text>
          </g>
        ))}

        {/* constant-zeta rays from the origin */}
        <g clipPath={`url(#${clipId})`}>
          {rays.map((r) => {
            const px = toX(r.x);
            const py = toY(r.y);
            if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
            return (
              <line key={`z${r.z}`} x1={x0} y1={toY(0)} x2={px} y2={py}
                    stroke={MUTED} strokeWidth={0.7} strokeDasharray="1 5" opacity={0.8} />
            );
          })}
        </g>
        {/* Ray labels go INSIDE the frame. They used to be placed at pad.t - 3, which is
            above the plot entirely -- they floated in the gap under the subtitle, detached
            from the rays they name. */}
        {rays.map((r) => (
          <text
            key={`zl${r.z}`}
            x={r.exitsTop ? toX(r.x) : pad.l + 4}
            y={r.exitsTop ? pad.t + 9 : toY(r.y) - 3}
            fill={MUTED}
            fontSize={7.5}
            opacity={0.9}
            textAnchor={r.exitsTop ? 'middle' : 'start'}
          >
            ζ={r.z}
          </text>
        ))}

        {/* THE stability boundary */}
        <line x1={x0} y1={pad.t} x2={x0} y2={pad.t + plotH} stroke={UNSTABLE} strokeWidth={1.8} />
        {/* At the TOP this sat on the frame line and fought the zeta labels for the same
            few pixels. The boundary is a full-height line; label it where nothing else is. */}
        <text x={x0 + 4} y={pad.t + plotH - 5} fill={UNSTABLE} fontSize={8} fontWeight={600}>
          σ = 0
        </text>

        {/* locus branch */}
        {locus.length > 1 && (
          <polyline points={branch} fill="none" stroke={DESIGN} strokeWidth={2} opacity={0.85} />
        )}
        {arrowAt && arrowPrev && (
          <line
            x1={toX(arrowPrev.real)} y1={toY(arrowPrev.imag)}
            x2={toX(arrowAt.real)} y2={toY(arrowAt.imag)}
            stroke={DESIGN} strokeWidth={2} markerEnd="url(#locus-arrow)"
          />
        )}
        {/* endpoints of the sweep, so the direction is readable without hovering */}
        {locus.length > 1 && (
          <>
            <circle cx={toX(locus[0].real)} cy={toY(locus[0].imag)} r={2.5}
                    fill="none" stroke={DESIGN} strokeWidth={1.2} />
            {/* Start label goes BELOW its point and end label above: the sweep starts at the
                top-left where the zeta=0.5 ray label also lives, and the two overlapped by
                7.5 x 7.1 px. Splitting them vertically separates them for any locus shape. */}
            <text x={toX(locus[0].real) + 4} y={toY(locus[0].imag) + 11} fill={DESIGN}
                  fontSize={7.5} textAnchor="start">
              η={locus[0].eta.toFixed(2)}
            </text>
            <text
              x={toX(locus[locus.length - 1].real) - 4}
              y={toY(locus[locus.length - 1].imag) - 7}
              fill={DESIGN} fontSize={7.5} textAnchor="end"
            >
              η={locus[locus.length - 1].eta.toFixed(2)}
            </text>
          </>
        )}

        {/* the operating-point eigenvalue */}
        {havePole && (
          <g>
            <line x1={toX(poleSigma) - 6} y1={toY(poleOmega) - 6}
                  x2={toX(poleSigma) + 6} y2={toY(poleOmega) + 6}
                  stroke={poleStable ? STABLE : UNSTABLE} strokeWidth={2.4} />
            <line x1={toX(poleSigma) - 6} y1={toY(poleOmega) + 6}
                  x2={toX(poleSigma) + 6} y2={toY(poleOmega) - 6}
                  stroke={poleStable ? STABLE : UNSTABLE} strokeWidth={2.4} />
          </g>
        )}

        {/* axes */}
        <line x1={pad.l} y1={pad.t + plotH} x2={pad.l + plotW} y2={pad.t + plotH} stroke="#475569" />
        <line x1={pad.l} y1={pad.t} x2={pad.l} y2={pad.t + plotH} stroke="#475569" />
        <text x={pad.l + plotW / 2} y={H - 16} fill={MUTED} fontSize={9.5} textAnchor="middle">
          Re(s) = σ — growth rate [1/s]
        </text>
        <text x={pad.l + plotW / 2} y={H - 5} fill={MUTED} fontSize={8} textAnchor="middle">
          ← decaying · growing →
        </text>
        <text x={14} y={pad.t + plotH / 2} fill={MUTED} fontSize={9.5} textAnchor="middle"
              transform={`rotate(-90, 14, ${pad.t + plotH / 2})`}>
          Im(s) = ω [rad/s]
        </text>
        <text x={W - 12} y={pad.t + plotH / 2} fill={MUTED} fontSize={8} textAnchor="middle"
              opacity={0.8} transform={`rotate(-90, ${W - 12}, ${pad.t + plotH / 2})`}>
          f = ω/2π [Hz]
        </text>
      </svg>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-secondary)] -mt-1 mb-2">
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-0.5 rounded" style={{ background: DESIGN }} /> locus (η_inj sweep)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-bold" style={{ color: poleStable ? STABLE : UNSTABLE }}>✕</span> design point
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block w-5 h-0.5 rounded" style={{ background: UNSTABLE }} /> σ = 0 boundary
        </span>
      </div>

      {havePole && (
        <table className="w-full text-[11px] mb-2">
          <tbody>
            <tr>
              <td className="text-[var(--color-text-secondary)] py-0.5">eigenvalue s = σ + jω</td>
              <td className="text-right font-mono" style={{ color: poleStable ? STABLE : UNSTABLE }}>
                {fmt(poleSigma, 2)} {poleOmega >= 0 ? '+' : '−'} {fmt(Math.abs(poleOmega), 1)}j s⁻¹
              </td>
            </tr>
            <tr>
              <td className="text-[var(--color-text-secondary)] py-0.5">frequency ω/2π</td>
              <td className="text-right font-mono text-[var(--color-text-primary)]">
                {fmt(poleOmega / (2 * Math.PI), 1)} Hz
              </td>
            </tr>
            <tr>
              <td className="text-[var(--color-text-secondary)] py-0.5">damping ratio ζ = −σ/|s|</td>
              <td className="text-right font-mono text-[var(--color-text-primary)]">
                {typeof poleZeta === 'number' ? fmt(poleZeta, 4) : '—'}
              </td>
            </tr>
            <tr>
              <td className="text-[var(--color-text-secondary)] py-0.5">
                {poleStable ? 'decays by 1/e in' : 'grows by e in'}
              </td>
              <td className="text-right font-mono text-[var(--color-text-primary)]">
                {Number.isFinite(eFoldMs) ? `${eFoldMs.toFixed(0)} ms` : '—'}
              </td>
            </tr>
            {critical && Number.isFinite(critical.eta) && (
              <tr>
                <td className="text-[var(--color-text-secondary)] py-0.5">
                  crosses σ = 0 at η_inj
                </td>
                <td className="text-right font-mono text-[var(--color-text-primary)]">
                  {fmt(critical.eta, 3)} ({fmt(critical.f_hz, 0)} Hz)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      <p className="text-[10px] text-[var(--color-text-secondary)] leading-snug">
        Every point on the blue branch is a <span className="text-[var(--color-text-primary)]">root of
        the chug characteristic equation</span> 1 + L(s) = 0 at one injector stiffness; the arrow points
        toward stiffer injectors. The ✕ is this design. σ is the growth rate — negative means a chug
        oscillation dies out, positive means it builds. ω is how fast it oscillates while it does.
        {critical && Number.isFinite(critical.eta) ? (
          <>
            {' '}The branch crosses into the left half-plane at{' '}
            <span className="text-[var(--color-text-primary)]">η_inj = {fmt(critical.eta, 3)}</span>,
            so that is the injector ΔP/Pc this engine has to beat.
          </>
        ) : null}
      </p>
      <p className="text-[9.5px] text-[var(--color-text-secondary)] mt-1 leading-snug opacity-80">
        The sweep moves both propellant streams to the same η_inj, while the ✕ is solved at each
        stream&apos;s own η — so the ✕ sits near the branch rather than exactly on it whenever the two
        injector stiffnesses differ.
      </p>
    </VizCard>
  );
}
