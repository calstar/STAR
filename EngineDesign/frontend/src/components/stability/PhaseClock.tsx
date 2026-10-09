import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE, MUTED } from './shared';

/**
 * Where each acoustic mode sits in the combustion response's cycle.
 *
 * The damping budget (acoustic.py) books combustion driving as the part of Crocco's n–τ response
 * in phase with p′: n(1 − cos ωτ). It is never negative -- combustion never damps a mode in this
 * model -- zero at ωτ = 0 (mod 2π) and largest at ωτ = π. So the dial runs from "no driving" at
 * the top to "most driving" at the bottom, and each needle's share of its most possible driving is
 * (1 − cos ωτ)/2 -- the backend's driving / driving_max, read from it rather than recomputed.
 *
 * This card used to classify by sin ωτ, from before the model took the in-phase part; it put
 * modes the budget shows growing into a "damping" half.
 */
export function driveShare(p: { omega_tau: number; drive_share?: number }): number {
  return p.drive_share ?? (1 - Math.cos(p.omega_tau)) / 2;
}

export function PhaseClock({ data }: { data: StabilityRichPayload }) {
  const cx = 100;
  const cy = 92;
  const r = 68;

  const chi = data.assumptions.chi_acoustic;
  const n = data.assumptions.n;
  const tauConv = data.vaporization.tau_conv_s;
  const tauSens = data.vaporization.tau_sens_s ?? (tauConv != null ? chi * tauConv : undefined);

  const modeByName = new Map(data.acoustic.modes.map((m) => [m.name, m]));
  const rows = data.phase
    .map((p) => {
      const m = modeByName.get(p.mode);
      return { mode: p.mode, omegaTau: p.omega_tau, share: driveShare(p), freq: m?.freq_hz, alpha: m?.alpha,
               worst: m?.margin_worst_phase };
    })
    .sort((a, b) => (a.freq ?? 0) - (b.freq ?? 0));
  const drivenCount = rows.filter((r) => (r.alpha ?? -1) > 0).length;

  const [chiLo, chiHi] = data.sensitivity?.acoustic_alpha_vs_chi ?? [NaN, NaN];
  const [nLo, nHi] = data.sensitivity?.acoustic_alpha_vs_n ?? [NaN, NaN];
  const shade = (share: number) => (share > 0.5 ? UNSTABLE : share > 0.15 ? '#f59e0b' : STABLE);

  return (
    <VizCard
      title="Phase clock"
      subtitle="Top: no combustion driving. Bottom: the most any lag can give."
      info={<>
        {tauSens != null && tauConv != null && (
          <span className="block">ωτ = 2π·f·τ_sens, τ_sens = χ·τ_conv = {chi.toFixed(2)} × {(tauConv * 1e3).toFixed(1)} ms = {(tauSens * 1e3).toFixed(2)} ms; n = {n.toFixed(2)}. τ_conv is the slowest stream's whole chug lag.</span>
        )}
        <span className="block">ωτ is tens of radians, so a few percent on τ turns a needle a full circle: the needles show where this lag lands, not how the engine will behave. The worst-phase margin does not depend on τ.</span>
        {Number.isFinite(chiLo) && Number.isFinite(nLo) && (
          <span className="block">Worst-mode α spans {Math.min(chiLo, chiHi).toFixed(0)}…{Math.max(chiLo, chiHi).toFixed(0)} 1/s over χ 0.05–0.30, and {Math.min(nLo, nHi).toFixed(0)}…{Math.max(nLo, nHi).toFixed(0)} 1/s over n 0.3–0.6.</span>
        )}
        <span className="block">Rayleigh: heat release in phase with p′ pumps a mode. Crocco's n(1 − e^(−iωτ)) puts n(1 − cos ωτ) in phase, the same term as the damping budget's red bar.</span>
      </>}
    >
      <svg viewBox="0 0 200 175" className="w-full h-[155px]" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="phase-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={STABLE} stopOpacity={0.18} />
            <stop offset="100%" stopColor={UNSTABLE} stopOpacity={0.3} />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r} fill="url(#phase-grad)" stroke="#475569" />
        <text x={cx} y={cy - r + 12} fill={STABLE} fontSize={8} textAnchor="middle">ωτ = 0 · no driving</text>
        <text x={cx} y={cy + r - 5} fill={UNSTABLE} fontSize={8} textAnchor="middle">ωτ = π · most driving</text>
        {rows.map((p) => {
          // Angle from the top, clockwise: the needle's height is cos ωτ, so its depth below the
          // top is the driving share.
          const x2 = cx + r * 0.8 * Math.sin(p.omegaTau);
          const y2 = cy - r * 0.8 * Math.cos(p.omegaTau);
          const lx = cx + (r + 11) * Math.sin(p.omegaTau);
          const ly = cy - (r + 11) * Math.cos(p.omegaTau);
          return (
            <g key={p.mode}>
              <line x1={cx} y1={cy} x2={x2} y2={y2} stroke={shade(p.share)} strokeWidth={2} opacity={0.9} />
              <text x={lx} y={ly + 3} fill={MUTED} fontSize={8} textAnchor="middle">{p.mode}</text>
            </g>
          );
        })}
      </svg>

      <p className="text-xs mt-1" style={{ color: drivenCount > 0 ? UNSTABLE : STABLE }}>
        {drivenCount === 0
          ? 'At this lag, damping outweighs driving on every mode (every α < 0).'
          : `At this lag ${drivenCount} mode${drivenCount > 1 ? 's grow' : ' grows'} (α > 0).`}
        <span className="text-[var(--color-text-secondary)]"> Report only.</span>
      </p>

      <table className="w-full mt-2 text-[11px]">
        <thead>
          <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="font-medium text-left pb-1">mode</th>
            <th className="font-medium text-right pb-1">f [Hz]</th>
            <th className="font-medium text-right pb-1" title="ωτ modulo 2π">ωτ mod 2π</th>
            <th className="font-medium text-right pb-1" title="driving now / the most any lag can give = (1 − cos ωτ)/2">driving share</th>
            <th className="font-medium text-right pb-1">α [1/s]</th>
            <th className="font-medium text-right pb-1" title="damping / most driving any lag can give">worst-phase margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.mode}>
              <td className="py-0.5 font-mono text-[var(--color-text-primary)]">{r.mode}</td>
              <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">
                {r.freq != null && Number.isFinite(r.freq) ? r.freq.toFixed(0) : '—'}
              </td>
              <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">
                {(((r.omegaTau % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / Math.PI).toFixed(2)}π
              </td>
              <td className="py-0.5 text-right font-mono" style={{ color: shade(r.share) }}>{(100 * r.share).toFixed(0)}%</td>
              <td className="py-0.5 text-right font-mono" style={{ color: (r.alpha ?? -1) < 0 ? STABLE : UNSTABLE }}>
                {r.alpha != null && Number.isFinite(r.alpha) ? `${r.alpha > 0 ? '+' : ''}${r.alpha.toFixed(0)}` : '—'}
              </td>
              <td className="py-0.5 text-right font-mono" style={{ color: (r.worst ?? 0) >= 1 ? STABLE : '#f59e0b' }}>
                {r.worst != null && Number.isFinite(r.worst) ? r.worst.toFixed(2) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

    </VizCard>
  );
}
