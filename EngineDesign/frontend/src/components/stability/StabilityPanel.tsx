import type { StabilityRichPayload, StabilityOverrides } from './types';
import { StabilityDiagnostics } from './StabilityDiagnostics';
import { StabilityGlossary } from './StabilityGlossary';
import { ChugStabilityMap } from './ChugStabilityMap';
import { AcousticDampingBars } from './AcousticDampingBars';
import { PhaseClock } from './PhaseClock';
import { VaporizationProfile } from './VaporizationProfile';
import { StabilityRadar } from './StabilityRadar';
import { marginColor } from './shared';

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
  const smd = overrides.smd_um ?? data.assumptions.smd_O_um;
  const nVal = overrides.n_interaction ?? data.assumptions.n;
  const chi = overrides.chi_acoustic ?? data.assumptions.chi_acoustic;

  const setOverride = (patch: Partial<StabilityOverrides>) => {
    onOverridesChange?.({ ...overrides, ...patch });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">Combustion stability</h3>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Rich analysis —{' '}
            <span style={{ color: marginColor(data.summary.min_margin, data.summary.gate_margin_threshold) }}>
              {data.summary.state}
            </span>
          </p>
        </div>
        {interactive && onReevaluate && (
          <button
            type="button"
            onClick={onReevaluate}
            disabled={isLoading}
            className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
          >
            {isLoading ? 'Updating…' : 'Apply sensitivity sliders'}
          </button>
        )}
      </div>

      {interactive && onOverridesChange && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <SliderRow label="η_inj (O)" value={eta} min={0.15} max={0.45} step={0.01} onChange={(v) => setOverride({ eta_inj_O: v })} />
          <SliderRow label="SMD [µm]" value={smd} min={30} max={120} step={1} onChange={(v) => setOverride({ smd_um: v })} />
          <SliderRow label="n" value={nVal} min={0.3} max={0.8} step={0.05} onChange={(v) => setOverride({ n_interaction: v })} />
          <SliderRow label="χ" value={chi} min={0.05} max={0.35} step={0.01} onChange={(v) => setOverride({ chi_acoustic: v })} />
        </div>
      )}

      <StabilityDiagnostics data={data} />

      <StabilityGlossary />

      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        <StabilityRadar data={data} />
        <ChugStabilityMap data={data} etaInjOverride={eta} />
        <AcousticDampingBars data={data} />
        <PhaseClock data={data} />
        <VaporizationProfile data={data} />
      </div>

      <p className="text-xs text-[var(--color-text-secondary)]">
        Tank pressure vs time isn&apos;t shown here — it depends on the feed configuration
        (blowdown vs dome-regulated) and needs a real solve. Run the{' '}
        <span className="text-[var(--color-text-primary)] font-medium">Time-Series</span> tab for
        the actual pressure history.
      </p>
    </div>
  );
}
