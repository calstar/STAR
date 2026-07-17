import type { StabilityRichPayload } from './types';
import { VizCard, STABLE, UNSTABLE, MUTED } from './shared';

/**
 * Combustion feeds energy to a mode when the driving term n·sin(ωτ_sens) > 0 — exactly the law the
 * acoustic damping budget uses (acoustic.py: drive ∝ n·sin(ω·τ_sens)). So "driving" ⇔ sin(ωτ) > 0
 * (ωτ ∈ (0, π) mod 2π), peaking at ωτ = π/2. Keeping this identical to the backend is what makes the
 * clock's phase column agree with the budget's α sign.
 */
function isDrivingPhase(omegaTau: number): boolean {
  return Math.sin(omegaTau) > 0;
}

export function PhaseClock({ data }: { data: StabilityRichPayload }) {
  const cx = 100;
  const cy = 92;
  const r = 68;

  const chi = data.assumptions.chi_acoustic;
  const n = data.assumptions.n;
  const tauVap = data.vaporization.tau_conv_s;
  const tauSens = data.vaporization.tau_sens_s ?? (tauVap != null ? chi * tauVap : undefined);

  // Join each phase needle to the mode's actual growth rate (α) so the dial is read against the
  // real damping budget, not just kinematics.
  const modeByName = new Map(data.acoustic.modes.map((m) => [m.name, m]));
  const rows = data.phase
    .map((p) => {
      const m = modeByName.get(p.mode);
      return {
        mode: p.mode,
        omegaTau: p.omega_tau,
        freq: m?.freq_hz,
        alpha: m?.alpha,
        driving: isDrivingPhase(p.omega_tau),
      };
    })
    .sort((a, b) => (a.freq ?? 0) - (b.freq ?? 0));

  const drivingCount = rows.filter((r) => r.driving).length;
  const drivenCount = rows.filter((r) => (r.alpha ?? -1) > 0).length;

  const [chiLo, chiHi] = data.sensitivity?.acoustic_alpha_vs_chi ?? [NaN, NaN];
  const [nLo, nHi] = data.sensitivity?.acoustic_alpha_vs_n ?? [NaN, NaN];

  // Explicit top/bottom rects clipped to circle — avoids SVG arc sweep flipping halves
  const topHalf = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy} L ${cx} ${cy} Z`;
  const botHalf = `M ${cx - r} ${cy} A ${r} ${r} 0 0 0 ${cx + r} ${cy} L ${cx} ${cy} Z`;

  return (
    <VizCard title="Phase clock" subtitle="Each needle = one mode's heat-release timing (ωτ); bottom red half = Rayleigh driving">
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
          // Angle = ωτ measured so the vertical offset is sin(ωτ): bottom (sin>0) = driving,
          // peak at ωτ = π/2; top (sin<0) = damping. Matches the backend's sin(ωτ) driving law.
          const ang = p.omega_tau;
          const driving = isDrivingPhase(p.omega_tau);
          const color = driving ? UNSTABLE : STABLE;
          const x2 = cx + r * 0.8 * Math.cos(ang);
          const y2 = cy + r * 0.8 * Math.sin(ang);
          const lx = cx + (r + 11) * Math.cos(ang);
          const ly = cy + (r + 11) * Math.sin(ang);
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

      {/* one-line verdict that reconciles phase with the actual growth rate */}
      <p className="text-xs mt-1" style={{ color: drivenCount > 0 ? UNSTABLE : STABLE }}>
        {drivingCount === 0
          ? 'All modes sit in the damping half — none timed to feed energy.'
          : `${drivingCount} mode${drivingCount > 1 ? 's' : ''} in the driving half, but ${
              drivenCount === 0 ? 'damping wins everywhere (every α < 0)' : `${drivenCount} actually grow${drivenCount > 1 ? '' : 's'} (α > 0)`
            }.`}
      </p>

      {/* per-mode table: phase region vs. the real growth rate */}
      <table className="w-full mt-2 text-[11px]">
        <thead>
          <tr className="text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
            <th className="font-medium text-left pb-1">mode</th>
            <th className="font-medium text-right pb-1">f [Hz]</th>
            <th className="font-medium text-right pb-1">ωτ</th>
            <th className="font-medium text-right pb-1">phase</th>
            <th className="font-medium text-right pb-1">α [1/s]</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const aColor = (r.alpha ?? -1) < 0 ? STABLE : UNSTABLE;
            return (
              <tr key={r.mode}>
                <td className="py-0.5 font-mono text-[var(--color-text-primary)]">{r.mode}</td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">
                  {r.freq != null && Number.isFinite(r.freq) ? r.freq.toFixed(0) : '—'}
                </td>
                <td className="py-0.5 text-right font-mono text-[var(--color-text-secondary)]">
                  {(r.omegaTau / Math.PI).toFixed(1)}π
                </td>
                <td className="py-0.5 text-right" style={{ color: r.driving ? UNSTABLE : STABLE }}>
                  {r.driving ? 'driving' : 'damping'}
                </td>
                <td className="py-0.5 text-right font-mono" style={{ color: aColor }}>
                  {r.alpha != null && Number.isFinite(r.alpha) ? `${r.alpha > 0 ? '+' : ''}${r.alpha.toFixed(0)}` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="border-t border-[var(--color-border)] mt-2 pt-2 space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
        {tauSens != null && tauVap != null && (
          <p className="font-mono text-[10px]">
            ωτ = 2π·f·τ<sub>sens</sub> &nbsp;·&nbsp; τ<sub>sens</sub> = χ·τ<sub>vap</sub> ={' '}
            {chi.toFixed(2)} × {(tauVap * 1e3).toFixed(1)} ms ={' '}
            <span className="text-[var(--color-text-primary)]">{(tauSens * 1e3).toFixed(1)} ms</span>
            {' · '}n={n.toFixed(2)}
          </p>
        )}
        {Number.isFinite(chiLo) && Number.isFinite(nLo) && (
          <p className="text-[10px] leading-snug">
            Worst-mode growth α runs{' '}
            <span className="font-mono">
              {Math.min(chiLo, chiHi).toFixed(0)}…{Math.max(chiLo, chiHi).toFixed(0)}
            </span>{' '}
            1/s as χ sweeps 0.05→0.30, and{' '}
            <span className="font-mono">
              {Math.min(nLo, nHi).toFixed(0)}…{Math.max(nLo, nHi).toFixed(0)}
            </span>{' '}
            1/s as n sweeps 0.3→0.6 — lower χ (finer atomization) and lower n rotate needles toward
            the damping half.
          </p>
        )}
        <p className="text-[10px] opacity-85 leading-snug">
          Rayleigh criterion: when heat release q′ lands in phase with the pressure wave p′
          (sin ωτ &gt; 0, bottom half) it pumps the mode; worst at ωτ ≈ π/2. This is the same
          n·sin(ωτ) term the damping budget uses, so the “phase” column here matches the sign of its
          red driving bar. A mode can sit in the driving half yet still show α &lt; 0 — that just
          means nozzle/viscous/two-phase damping outweighs the driving, not a disagreement.
        </p>
      </div>
    </VizCard>
  );
}
