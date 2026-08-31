import { useState } from 'react';

interface Entry {
  sym: string;
  name: string;
  meaning: string;
}

const GROUPS: { title: string; entries: Entry[] }[] = [
  {
    title: 'Growth & margins',
    entries: [
      {
        sym: 'α',
        name: 'growth rate [1/s]',
        meaning:
          'how fast an oscillation grows (α>0, unstable) or decays (α<0, stable). Larger |α| = faster.',
      },
      {
        sym: 'σ, ω',
        name: 'chug pole',
        meaning:
          'σ = growth rate [1/s] (same sign rule as α); ω = oscillation rate [rad/s], with ω = 2π·f.',
      },
      {
        sym: 'ζ',
        name: 'damping ratio',
        meaning: 'how damped the chug pole is. ζ>0 decays; larger = more damped.',
      },
      {
        sym: 'margin',
        name: 'gate margin',
        meaning:
          'the growth rate remapped to a pass/fail scale. ≥ 1.05 clears the gate; higher = safer.',
      },
    ],
  },
  {
    title: 'Levers you can change (the sliders)',
    entries: [
      {
        sym: 'η_inj',
        name: 'injector stiffness = ΔP_inj / Pc',
        meaning: '↑ a stiffer injector decouples the feed from the chamber → more stable.',
      },
      {
        sym: 'SMD',
        name: 'droplet diameter [µm]',
        meaning: '↓ a finer spray vaporizes faster → shorter lag → more stable.',
      },
      {
        sym: 'n',
        name: 'interaction index',
        meaning: 'combustion-response gain. ↑ n = stronger heat-release feedback → less stable.',
      },
      {
        sym: 'χ',
        name: 'sensitive fraction',
        meaning: 'fraction of the vaporization lag that drives the acoustic response (τ_sens = χ·τ_vap).',
      },
      {
        sym: 'L*',
        name: 'characteristic length [m]',
        meaning:
          'chamber volume ÷ throat area; sets residence time. Too short hurts chug, too long adds mass.',
      },
    ],
  },
  {
    title: 'Lags & lengths',
    entries: [
      {
        sym: 'τ_conv',
        name: 'vaporization lag [ms]',
        meaning: 'time for a droplet to vaporize and convect. Shorter = more stable.',
      },
      {
        sym: 'τ_sens',
        name: 'sensitive lag [ms]',
        meaning: 'χ·τ_vap - the lag that sets the Rayleigh phase ωτ.',
      },
      {
        sym: 'τ / θ_c',
        name: 'normalized lag',
        meaning: 'combustion lag ÷ chamber residence time (the chug map y-axis). Lower = more stable.',
      },
      {
        sym: 'ωτ',
        name: 'phase angle',
        meaning: 'phase between heat release and pressure. Near π = worst case (Rayleigh driving).',
      },
      {
        sym: 'L_vap / L_ch',
        name: 'vaporization vs chamber length',
        meaning: 'L_vap < L_ch means droplets finish burning before the nozzle (good).',
      },
    ],
  },
];

/**
 * Collapsible symbol glossary for the stability panel. The individual cards stay uncluttered;
 * this is the one place that defines every parameter and which direction is "better".
 */
export function StabilityGlossary() {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((s) => !s)}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
      >
        <span>
          New to these charts? <span className="text-[var(--color-text-primary)]">What α, η_inj, τ… mean</span>{' '}
          - symbol glossary
        </span>
        <span className="font-mono text-sm">{open ? '−' : '+'}</span>
      </button>

      {open && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-[var(--color-border)] border-t border-[var(--color-border)]">
          {GROUPS.map((g) => (
            <div key={g.title} className="bg-[var(--color-bg-secondary)] p-4">
              <h5 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2.5">
                {g.title}
              </h5>
              <dl className="space-y-2">
                {g.entries.map((e) => (
                  <div key={e.sym}>
                    <dt className="text-xs">
                      <span className="font-mono text-[var(--color-text-primary)]">{e.sym}</span>{' '}
                      <span className="text-[var(--color-text-secondary)]">- {e.name}</span>
                    </dt>
                    <dd className="text-[11px] text-[var(--color-text-secondary)] leading-snug mt-0.5 opacity-90">
                      {e.meaning}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
