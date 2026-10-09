import type React from 'react';
import type { StabilityRichPayload, StabilityOverrides } from './types';
import { StabilityDiagnostics } from './StabilityDiagnostics';
import { StabilityGlossary } from './StabilityGlossary';
import { ChugStabilityMap } from './ChugStabilityMap';
import { ChugRootLocus } from './ChugRootLocus';
import { AcousticDampingBars } from './AcousticDampingBars';
import { PhaseClock } from './PhaseClock';
import { Info } from '../Hint';
import { useViewState } from '../../lib/viewState';

interface Props {
  data: StabilityRichPayload | null | undefined;
  interactive?: boolean;
  overrides?: StabilityOverrides;
  onOverridesChange?: (o: StabilityOverrides) => void;
  onReevaluate?: () => void;
  isLoading?: boolean;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs text-[var(--color-text-secondary)]">
      <span className="flex justify-between mb-1">
        <span>{label}</span>
        <span className="text-[var(--color-text-primary)] font-mono">{value.toFixed(3)}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500"
      />
    </label>
  );
}

/** A quiet row that opens onto its content; remembered per label. */
function Disclosure({ label, note, children }: { label: string; note?: string; children: React.ReactNode }) {
  const [open, setOpen] = useViewState<boolean>(`stability.disclosure.${label}`, false);
  return (
    <div className="border-t border-[var(--color-border)]">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
              className="flex w-full items-center gap-3 py-3 text-left">
        <span className="text-sm text-[var(--color-text-primary)]">{label}</span>
        {note && <span className="text-xs text-[var(--color-text-muted)]">{note}</span>}
        <svg className={`ml-auto h-4 w-4 text-[var(--color-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      </button>
      {open && <div className="pb-4">{children}</div>}
    </div>
  );
}

export function StabilityPanel({
  data,
  interactive = false,
  overrides = {},
  onOverridesChange,
  onReevaluate,
  isLoading,
}: Props) {
  if (!data) {
    return (
      <div className="p-6 rounded-xl border border-dashed border-[var(--color-border)] text-center text-[var(--color-text-secondary)] text-sm">
        Run an evaluation to load the rich stability panel.
      </div>
    );
  }

  const eta = overrides.eta_inj_O ?? data.assumptions.eta_inj_O;
  const etaF = overrides.eta_inj_F ?? data.assumptions.eta_inj_F;
  const smd = overrides.smd_um ?? data.assumptions.smd_O_um;
  const smdF = overrides.smd_F_um ?? data.assumptions.smd_F_um ?? data.assumptions.smd_O_um;
  const nameO = data.assumptions.fluid_O ?? 'oxidizer';
  const nameF = data.assumptions.fluid_F ?? 'fuel';
  const rateLimiting = data.vaporization?.rate_limiting_stream ?? data.assumptions.rate_limiting_stream;
  // Slider ranges follow the design's own spray, not a fixed 30-120 um window: an ethanol doublet
  // atomizes near 180 um and would sit off the end of a methane-shaped slider.
  const smdRange = (v: number): [number, number] => [
    Math.max(5, Math.round(v * 0.35)),
    Math.round(Math.max(v * 1.8, 60)),
  ];
  const [smdMin, smdMax] = smdRange(data.assumptions.smd_O_um);
  const [smdFMin, smdFMax] = smdRange(data.assumptions.smd_F_um ?? data.assumptions.smd_O_um);
  const nVal = overrides.n_interaction ?? data.assumptions.n;
  const chi = overrides.chi_acoustic ?? data.assumptions.chi_acoustic;
  const lagModel = overrides.time_lag_model ?? data.assumptions.time_lag_model ?? 'leonardi_dtl';
  const convModel = overrides.convection_model ?? data.assumptions.convection_model ?? 'none';

  const setOverride = (patch: Partial<StabilityOverrides>) => {
    onOverridesChange?.({ ...overrides, ...patch });
  };

  return (
    <div className="space-y-5">
      <StabilityDiagnostics data={data} />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <ChugRootLocus data={data} />
        <ChugStabilityMap data={data} etaInjOverride={eta} />
      </div>

      <Disclosure label="Acoustic modes" note="report only: the damping is uncalibrated">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          <AcousticDampingBars data={data} />
          <PhaseClock data={data} />
        </div>
      </Disclosure>

      {interactive && onOverridesChange && (
        <Disclosure label="What if" note="move the inputs and re-run the stability model">
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <SliderRow label={`ΔP/Pc ${nameO}`} value={eta} min={0.05} max={0.60} step={0.01} onChange={(v) => setOverride({ eta_inj_O: v })} />
              <SliderRow label={`ΔP/Pc ${nameF}`} value={etaF} min={0.05} max={0.60} step={0.01} onChange={(v) => setOverride({ eta_inj_F: v })} />
              <SliderRow label="n, interaction index" value={nVal} min={0.3} max={0.8} step={0.05} onChange={(v) => setOverride({ n_interaction: v })} />
              <SliderRow label={`D32 ${nameO} [µm]${rateLimiting === 'O' ? ' ★' : ''}`} value={smd} min={smdMin} max={smdMax} step={1}
                         onChange={(v) => setOverride({ smd_um: v })} />
              <SliderRow label={`D32 ${nameF} [µm]${rateLimiting === 'F' ? ' ★' : ''}`} value={smdF} min={smdFMin} max={smdFMax} step={1}
                         onChange={(v) => setOverride({ smd_F_um: v })} />
              <SliderRow label="χ, sensitive fraction" value={chi} min={0.05} max={0.35} step={0.01} onChange={(v) => setOverride({ chi_acoustic: v })} />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block text-xs text-[var(--color-text-secondary)]">
                <span className="mb-1 flex items-center gap-2">Lag model
                  <Info align="left" text="The double time lag with no convective correction reproduced the GH2/LOX rig's 66 Hz and its stability boundary about six times closer than the d²-law, and does not need the hot-gas conductivity." />
                </span>
                <select value={lagModel}
                        onChange={(e) => setOverride({ time_lag_model: e.target.value as 'leonardi_dtl' | 'd2_law' })}
                        className="w-full px-2 py-1.5 rounded-md bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)]">
                  <option value="leonardi_dtl">Double time lag (Leonardi 2017)</option>
                  <option value="d2_law">d²-law droplet lifetime</option>
                </select>
              </label>
              <label className="block text-xs text-[var(--color-text-secondary)]">
                <span className="block mb-1">Convective speed-up on τ_vap</span>
                <select value={convModel} disabled={lagModel !== 'leonardi_dtl'}
                        onChange={(e) => setOverride({ convection_model: e.target.value as 'none' | 'leonardi_eq8' | 'ranz_marshall' })}
                        className="w-full px-2 py-1.5 rounded-md bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] disabled:opacity-50">
                  <option value="none">None (default)</option>
                  <option value="leonardi_eq8">Leonardi eq. 8</option>
                  <option value="ranz_marshall">Ranz–Marshall</option>
                </select>
              </label>
            </div>
            <div className="flex items-center gap-3">
              {onReevaluate && (
                <button type="button" onClick={onReevaluate} disabled={isLoading}
                        className="rounded-md bg-[var(--color-accent)] px-4 py-1.5 text-sm text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-50">
                  {isLoading ? 'Re-running' : 'Re-run with these'}
                </button>
              )}
              <Info align="left" text={<>★ marks the stream whose lag sets the chug and acoustic verdicts; atomizing the other finer buys nothing. n and χ are combustion-response constants, not propellant data, and χ is the largest single uncertainty here: sweep them.</>} />
            </div>
          </div>
        </Disclosure>
      )}

      <StabilityGlossary />
    </div>
  );
}
