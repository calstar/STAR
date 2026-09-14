import { useState, useEffect, useCallback } from 'react';
import { getInjectorSchema } from '../api/client';
import type { EngineConfig } from '../api/client';
import { useConfigChanged } from '../lib/configBus';
import { useReadOnly } from '@stardesign-ui';
import type { DesignRequirements as DesignRequirementsType, FrozenParameters } from '../api/client';

/** Default Design Requirements used until API/config loads. */
/** Must match configs/default.yaml design_requirements until API/config loads. */
export const DEFAULT_DESIGN_REQUIREMENTS: DesignRequirementsType = {
  target_thrust: 8000.0,
  target_apogee: 3048.0,
  optimal_of_ratio: 2.8,
  target_burn_time: 5.8,
  max_lox_tank_pressure_psi: 700.0,
  max_fuel_tank_pressure_psi: 700.0,
  W_TANK_EQUAL: 0.0,
  max_engine_length: 0.4,
  max_chamber_outer_diameter: 0.2032,
  layer1_chamber_od_increment_in: 0,
  max_nozzle_exit_diameter: 0.2032,
  min_Lstar: 0.76,
  max_Lstar: 1.5,
  min_stability_score: 0.58,
  require_stable_state: false,
  stability_margin_handicap: 0.0,
  min_stability_margin: 1.05,
  chugging_margin_min: 0.2,
  acoustic_margin_min: 0.1,
  feed_stability_min: 0.15,
  copv_free_volume_L: 4.5,
};

interface DesignRequirementsProps {
  requirements: DesignRequirementsType;
  onRequirementsChange: (next: DesignRequirementsType) => void;
  onSave: () => void;
  /** Live config, for the propellant's CEA table range under the O/F target. */
  config?: EngineConfig | null;
}

/** [lo, hi] of the loaded propellant's CEA mixture-ratio table, or null when unknown. */
function ceaMrRange(config?: EngineConfig | null): [number, number] | null {
  const cea = (config?.combustion as { cea?: { MR_range?: unknown } } | undefined)?.cea;
  const r = cea?.MR_range;
  if (Array.isArray(r) && r.length === 2 && Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1]))) {
    return [Number(r[0]), Number(r[1])];
  }
  return null;
}

// Metadata for every injector-specific frozen field (both families). The frozen-injector UI renders
// ONLY the fields the backend says apply to the current injector type (INJECTOR_PARITY_PLAN W5), so
// switching to doublet shows doublet freezes — not pintle ones.
const FROZEN_INJECTOR_META: Record<string, { label: string; def: number; min: number; max: number; step: number; int?: boolean }> = {
  d_pintle_tip_mm: { label: 'Pintle Tip Ø [mm]', def: 25, min: 1, max: 500, step: 1 },
  h_gap_mm: { label: 'Gap Height [mm]', def: 1.0, min: 0.05, max: 20, step: 0.1 },
  n_orifices: { label: '# LOX Orifices', def: 16, min: 1, max: 400, step: 1, int: true },
  d_orifice_mm: { label: 'Orifice Ø [mm]', def: 2.5, min: 0.1, max: 30, step: 0.1 },
  n_doublets: { label: '# Doublets', def: 20, min: 1, max: 400, step: 1, int: true },
  d_jet_O_mm: { label: 'LOX Jet Ø [mm]', def: 2.0, min: 0.1, max: 30, step: 0.1 },
  d_jet_F_mm: { label: 'Fuel Jet Ø [mm]', def: 2.0, min: 0.1, max: 30, step: 0.1 },
  impingement_angle_O_deg: { label: 'LOX Imp. Angle [°]', def: 50, min: 1, max: 90, step: 1 },
  impingement_angle_F_deg: { label: 'Fuel Imp. Angle [°]', def: 60, min: 1, max: 90, step: 1 },
  spacing_O_mm: { label: 'LOX Spacing [mm]', def: 6, min: 0.5, max: 200, step: 0.5 },
  spacing_F_mm: { label: 'Fuel Spacing [mm]', def: 6, min: 0.5, max: 200, step: 0.5 },
};

export function DesignRequirements({
  requirements,
  onRequirementsChange,
  onSave,
  config,
}: DesignRequirementsProps) {
  const readOnly = useReadOnly();
  const mrRange = ceaMrRange(config);
  const ofOutsideTable = mrRange !== null && Number.isFinite(requirements.optimal_of_ratio)
    && (requirements.optimal_of_ratio < mrRange[0] || requirements.optimal_of_ratio > mrRange[1]);
  // Which injector-specific frozen fields to show — fetched from the backend authority so the UI
  // matches the live injector type (no hardcoded pintle assumptions).
  const [injectorFrozenFields, setInjectorFrozenFields] = useState<string[]>([]);
  const refreshInjectorSchema = useCallback(() => {
    getInjectorSchema().then((res) => {
      if (res.data) {
        setInjectorFrozenFields(res.data.frozen_param_fields.filter((f) => f in FROZEN_INJECTOR_META));
      }
    });
  }, []);
  useEffect(() => { refreshInjectorSchema(); }, [refreshInjectorSchema]);
  // Re-fetch when the injector type changes at the top, so the frozen-param controls switch with it.
  useConfigChanged(refreshInjectorSchema);

  const handleSave = () => {
    onSave();
  };

  const updateField = (field: keyof DesignRequirementsType, value: number | boolean | string | null) => {
    // Pass `null` (not `undefined`) to clear an optional target — `undefined` is dropped by
    // JSON.stringify so the backend would never see the cleared key (same reasoning as
    // updateFrozenParam below).
    onRequirementsChange({ ...requirements, [field]: value });
  };

  const updateFrozenParam = (field: keyof FrozenParameters, value: number | undefined) => {
    // Send an explicit `null` (not `undefined`) when clearing a pin. `undefined` is dropped by
    // JSON.stringify, so the backend would never see the key and could not remove a pin that
    // originated from the loaded YAML — leaving the parameter silently frozen. `null` lets the
    // backend merge logic pop it, so unchecking the box actually un-freezes the parameter.
    onRequirementsChange({
      ...requirements,
      frozen_parameters: {
        ...requirements.frozen_parameters,
        [field]: value === undefined ? null : value,
      },
    });
  };

  // Helper to check if a parameter is frozen
  const isFrozen = (field: keyof FrozenParameters): boolean => {
    return requirements.frozen_parameters?.[field] !== undefined && requirements.frozen_parameters?.[field] !== null;
  };

  // Helper to get frozen value or empty string for display
  const getFrozenValue = (field: keyof FrozenParameters): string => {
    const val = requirements.frozen_parameters?.[field];
    return val !== undefined && val !== null ? String(val) : '';
  };

  return (
    // A <fieldset disabled> rather than 33 individual `disabled` props. The
    // browser disables every descendant control natively, so a field added here
    // later cannot quietly escape the checkout -- which is the failure mode this
    // panel had. Everything in it writes config.design_requirements via
    // POST /api/optimizer/design-requirements.
    <fieldset disabled={readOnly} className="space-y-6 min-w-0">
      {/* Header */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">Design Requirements</h2>
        <p className="text-sm text-[var(--color-text-secondary)]">
          Configure your rocket and specify engine design targets. The optimizer will solve for propellant masses and engine geometry.
        </p>
      </div>

      {/* Performance Targets */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Performance Targets</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Target Peak Thrust [N]
            </label>
            <input
              type="number"
              value={requirements.target_thrust}
              onChange={(e) => updateField('target_thrust', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              step="100"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Peak thrust during burn. Engine will be sized to achieve this.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Target Chamber Pressure [psi] <span className="text-[var(--color-text-secondary)] font-normal">(optional)</span>
            </label>
            <input
              type="number"
              value={requirements.target_chamber_pressure_psi ?? ''}
              placeholder="leave blank to let Pc float"
              onChange={(e) => updateField('target_chamber_pressure_psi', e.target.value === '' ? null : parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              step="25"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              Operating chamber pressure you want. When set, Layer 1 sizes the <b>throat</b> to hit the thrust target and drives tank pressure to this Pc - instead of pushing Pc higher for thrust. Leave blank to let the optimizer choose Pc freely.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Target Apogee [m AGL]
            </label>
            <input
              type="number"
              value={requirements.target_apogee || 3048}
              onChange={(e) => updateField('target_apogee', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              step="100"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Target altitude above ground level. Optimizer will solve for propellant masses.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Optimal O/F Ratio
            </label>
            <input
              type="number"
              value={requirements.optimal_of_ratio}
              onChange={(e) => updateField('optimal_of_ratio', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.1"
              step="0.1"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              Target oxidizer-to-fuel mixture ratio from CEA or mission analysis. Layer 1 rescales impinging seed jets to this MR at run start; the optimizer still adjusts jet diameters.
            </p>
            {mrRange && (
              <p className={`text-xs mt-1 ${ofOutsideTable ? 'text-red-400' : 'text-[var(--color-text-muted)]'}`}>
                CEA table for {(config?.propellant_preset as string | undefined) ?? 'this propellant'}: {mrRange[0]}–{mrRange[1]}
                {ofOutsideTable ? ' — outside the table; Layer 1 will refuse to run' : ''}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Target Burn Time [s]
            </label>
            <input
              type="number"
              value={requirements.target_burn_time}
              onChange={(e) => updateField('target_burn_time', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.1"
              step="0.5"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Design burn time. Flight sim will truncate if propellant depletes earlier.</p>
          </div>
        </div>
      </div>

      {/* Tank Pressures */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Tank Pressures</h3>
        <div className="mb-4 flex items-center gap-3">
          <input
            type="checkbox"
            id="match_tank_pressures"
            checked={!!requirements.W_TANK_EQUAL}
            onChange={(e) => {
              const matched = e.target.checked;
              onRequirementsChange({
                ...requirements,
                W_TANK_EQUAL: matched ? 800.0 : 0.0,
                max_fuel_tank_pressure_psi: matched ? requirements.max_lox_tank_pressure_psi : requirements.max_fuel_tank_pressure_psi,
              });
            }}
            className="w-4 h-4 accent-blue-500"
          />
          <label htmlFor="match_tank_pressures" className="text-sm font-medium text-[var(--color-text-primary)] cursor-pointer">
            Match propellant tank pressures
          </label>
          <span className="text-xs text-[var(--color-text-secondary)]">
            Optimizer drives LOX and fuel tanks to the same pressure (independent of momentum-ratio matching).
          </span>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Max LOX Tank Pressure [psi]
            </label>
            <input
              type="number"
              value={requirements.max_lox_tank_pressure_psi}
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                onRequirementsChange({
                  ...requirements,
                  max_lox_tank_pressure_psi: val,
                  max_fuel_tank_pressure_psi: requirements.W_TANK_EQUAL ? val : requirements.max_fuel_tank_pressure_psi,
                });
              }}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="1"
              step="25"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Maximum operating pressure in LOX tank.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Max Fuel Tank Pressure [psi]
            </label>
            <input
              type="number"
              value={requirements.max_fuel_tank_pressure_psi}
              onChange={(e) => updateField('max_fuel_tank_pressure_psi', parseFloat(e.target.value))}
              disabled={!!requirements.W_TANK_EQUAL}
              className={`w-full px-3 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                requirements.W_TANK_EQUAL
                  ? 'bg-[var(--color-bg-secondary)] border-[var(--color-border)] text-[var(--color-text-secondary)] cursor-not-allowed opacity-50'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-primary)]'
              }`}
              min="1"
              step="25"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">
              {requirements.W_TANK_EQUAL ? 'Locked to LOX tank pressure.' : 'Maximum operating pressure in fuel tank.'}
            </p>
          </div>
        </div>
      </div>

      {/* Geometry Constraints */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Geometry Constraints</h3>
        {/* Stock-size snapping. Ablative sleeve / chamber tube / case come in fixed sizes, so a
            continuous optimum like 4.2" is not purchasable. Snapping INSIDE the search means the
            returned design is already buildable, instead of being rounded afterwards (which moves
            contraction ratio, L* and wall thickness off the optimum). */}
        <div className="mb-4 flex items-center gap-3">
          <input
            type="checkbox"
            id="chamber_od_stock_increments"
            checked={!!requirements.layer1_chamber_od_increment_in}
            onChange={(e) =>
              updateField('layer1_chamber_od_increment_in', e.target.checked ? 0.5 : 0)
            }
            className="w-4 h-4 accent-blue-500"
          />
          <label htmlFor="chamber_od_stock_increments" className="text-sm font-medium text-[var(--color-text-primary)] cursor-pointer">
            Chamber OD in stock sizes only
          </label>
          <span className="text-xs text-[var(--color-text-secondary)]">Search in 0.5&quot; steps.</span>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <label htmlFor="imp_ld_target" className="text-sm font-medium text-[var(--color-text-primary)]">
            Jets meet at
          </label>
          <input
            id="imp_ld_target"
            type="number"
            value={requirements.layer1_impingement_Ld_target ?? 4}
            onChange={(e) => updateField('layer1_impingement_Ld_target', parseFloat(e.target.value))}
            className="w-24 px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
            min="1"
            max="15"
            step="0.5"
          />
          <span className="text-sm text-[var(--color-text-secondary)]">jet diameters from the injector face</span>
        </div>

        <div className="mb-4 flex items-center gap-3">
          <input
            type="checkbox"
            id="integer_jet_angles"
            checked={requirements.layer1_integer_jet_angles !== false}
            onChange={(e) => updateField('layer1_integer_jet_angles', e.target.checked)}
            className="w-4 h-4 accent-blue-500"
          />
          <label htmlFor="integer_jet_angles" className="text-sm font-medium text-[var(--color-text-primary)] cursor-pointer">
            Whole-degree jet angles (doublet injectors)
          </label>

        </div>

        {/* Derived (solved) design variables. Both default ON: they are determined by
            requirements the user already gave, so solving them is exact and frees the
            optimizer to spend its effort on the choices that are genuinely free. They stay
            switchable because a fixed-hardware or off-design study needs to search them. */}
        <div className="mb-4 rounded-lg border border-[var(--color-border)] p-3">
          <div className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
            Solve instead of search
          </div>
          <div className="flex items-center gap-3 mb-2">
            <input
              type="checkbox"
              id="derive_expansion_ratio"
              checked={requirements.layer1_derive_expansion_ratio !== false}
              onChange={(e) => updateField('layer1_derive_expansion_ratio', e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            <label htmlFor="derive_expansion_ratio" className="text-sm text-[var(--color-text-primary)] cursor-pointer">
              Expansion ratio — expand exactly to ambient
            </label>

          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="derive_throat_from_thrust"
              checked={requirements.layer1_derive_throat_from_thrust !== false}
              onChange={(e) => updateField('layer1_derive_throat_from_thrust', e.target.checked)}
              className="w-4 h-4 accent-blue-500"
            />
            <label htmlFor="derive_throat_from_thrust" className="text-sm text-[var(--color-text-primary)] cursor-pointer">
              Throat area — size it to hit the thrust target exactly
            </label>

          </div>
        </div>
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Max Engine Length [m]
            </label>
            <input
              type="number"
              value={requirements.max_engine_length}
              onChange={(e) => updateField('max_engine_length', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.01"
              step="0.05"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Maximum total engine length (chamber + nozzle). Must fit in vehicle.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Max Chamber OD [m]
            </label>
            <input
              type="number"
              value={requirements.max_chamber_outer_diameter}
              onChange={(e) => updateField('max_chamber_outer_diameter', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.01"
              step="0.01"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Maximum chamber outer diameter (including wall thickness and cooling jacket).</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Max Nozzle Exit Diameter [m]
            </label>
            <input
              type="number"
              value={requirements.max_nozzle_exit_diameter}
              onChange={(e) => updateField('max_nozzle_exit_diameter', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.01"
              step="0.01"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Maximum nozzle exit outer diameter. Constrains expansion ratio.</p>
          </div>
        </div>
      </div>

      {/* L* Constraints */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">L* (Characteristic Length) Constraints</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Minimum L* [m]
            </label>
            <input
              type="number"
              value={requirements.min_Lstar}
              onChange={(e) => updateField('min_Lstar', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.05"
              step="0.05"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Minimum characteristic length. Lower = smaller chamber but less complete combustion. Typical: 0.7-1.0m for LOX/hydrocarbon.</p>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Maximum L* [m]
            </label>
            <input
              type="number"
              value={requirements.max_Lstar}
              onChange={(e) => updateField('max_Lstar', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.05"
              step="0.05"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Maximum characteristic length. Higher = better combustion but heavier/longer chamber. Typical: 1.0-2.0m for LOX/hydrocarbon.</p>
          </div>
        </div>
      </div>

      {/* Stability Requirements */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Stability Requirements</h3>

        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 mb-4">
          <p className="text-sm text-blue-400">
            Score maps the limiting gate margin (chug gain margin, worst acoustic mode) onto 0–1.
            A design is <strong>stable</strong> when every margin is at least 1.05 and no mode is driven,
            <strong> marginal</strong> above 0.95, <strong>unstable</strong> below.
          </p>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
              Minimum Stability Score
            </label>
            <input
              type="number"
              value={requirements.min_stability_score}
              onChange={(e) => updateField('min_stability_score', parseFloat(e.target.value))}
              className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
              min="0.0"
              max="1.0"
              step="0.05"
            />
            <p className="text-xs text-[var(--color-text-secondary)] mt-1">Minimum stability score (0–1) the optimizer must reach; the score is 0.44 at the marginal boundary and 1.0 when every margin is 1.3 or better.</p>
          </div>

          <div className="flex items-center">
            <input
              type="checkbox"
              checked={requirements.require_stable_state}
              onChange={(e) => updateField('require_stable_state', e.target.checked)}
              className="w-4 h-4 text-blue-600 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded focus:ring-blue-500"
            />
            <label className="ml-2 text-sm text-[var(--color-text-primary)]">
              Require 'Stable' State (not just 'Marginal')
            </label>
          </div>

          {/* Legacy Margins */}
          <details className="mt-4">
            <summary className="cursor-pointer text-sm font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
              Individual Stability Margins (for detailed tracking)
            </summary>
            <div className="mt-4 space-y-3 pl-4 border-l-2 border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">These are used for detailed feedback but the optimizer primarily uses stability_score above.</p>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
                    Min Overall Stability Margin (legacy)
                  </label>
                  <input
                    type="number"
                    value={requirements.min_stability_margin}
                    onChange={(e) => updateField('min_stability_margin', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="1.0"
                    max="5.0"
                    step="0.1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
                    Chugging Margin (min)
                  </label>
                  <input
                    type="number"
                    value={requirements.chugging_margin_min}
                    onChange={(e) => updateField('chugging_margin_min', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0.0"
                    max="10.0"
                    step="0.1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
                    Acoustic Margin (min)
                  </label>
                  <input
                    type="number"
                    value={requirements.acoustic_margin_min}
                    onChange={(e) => updateField('acoustic_margin_min', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0.0"
                    max="10.0"
                    step="0.1"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-[var(--color-text-secondary)] mb-1">
                    Feed System Margin (min)
                  </label>
                  <input
                    type="number"
                    value={requirements.feed_stability_min}
                    onChange={(e) => updateField('feed_stability_min', parseFloat(e.target.value))}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-blue-500"
                    min="0.0"
                    max="10.0"
                    step="0.1"
                  />
                </div>
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* Frozen Parameters - Collapsible Dropdown */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <details>
          <summary className="cursor-pointer text-lg font-semibold text-[var(--color-text-primary)] flex items-center gap-2">
            Frozen Parameters (Optional)
          </summary>

          <div className="mt-4 space-y-4">
            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
              <p className="text-sm text-blue-300">
                <strong>Freeze optimization parameters:</strong> When enabled, these values will be fixed during Layer 1 optimization
                instead of being optimized. Leave empty to let the optimizer find the best value.
              </p>
            </div>

            {/* Chamber Geometry */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] border-b border-[var(--color-border)] pb-1">
                Chamber Geometry
              </h4>
              <div className="grid grid-cols-2 gap-4">
                {/* A_throat_mm2 */}
                <div className={`p-3 rounded-lg border ${isFrozen('A_throat_mm2') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      Throat Area [mm²]
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('A_throat_mm2')}
                      onChange={(e) => updateFrozenParam('A_throat_mm2', e.target.checked ? 1000 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('A_throat_mm2')}
                    onChange={(e) => updateFrozenParam('A_throat_mm2', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('A_throat_mm2')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="500"
                    max="3000"
                    step="10"
                    placeholder="e.g. 1000"
                  />
                </div>

                {/* Lstar_mm */}
                <div className={`p-3 rounded-lg border ${isFrozen('Lstar_mm') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      L* (Char. Length) [mm]
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('Lstar_mm')}
                      onChange={(e) => updateFrozenParam('Lstar_mm', e.target.checked ? 1000 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('Lstar_mm')}
                    onChange={(e) => updateFrozenParam('Lstar_mm', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('Lstar_mm')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="800"
                    max="1500"
                    step="10"
                    placeholder="e.g. 1000"
                  />
                </div>

                {/* expansion_ratio */}
                <div className={`p-3 rounded-lg border ${isFrozen('expansion_ratio') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      Expansion Ratio
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('expansion_ratio')}
                      onChange={(e) => updateFrozenParam('expansion_ratio', e.target.checked ? 5.0 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('expansion_ratio')}
                    onChange={(e) => updateFrozenParam('expansion_ratio', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('expansion_ratio')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="2"
                    max="15"
                    step="0.1"
                    placeholder="e.g. 5.0"
                  />
                </div>

                {/* D_chamber_outer_mm */}
                <div className={`p-3 rounded-lg border ${isFrozen('D_chamber_outer_mm') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      Chamber OD [mm]
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('D_chamber_outer_mm')}
                      onChange={(e) => updateFrozenParam('D_chamber_outer_mm', e.target.checked ? 120 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('D_chamber_outer_mm')}
                    onChange={(e) => updateFrozenParam('D_chamber_outer_mm', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('D_chamber_outer_mm')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="60"
                    max="250"
                    step="5"
                    placeholder="e.g. 120"
                  />
                </div>
              </div>
            </div>

            {/* Injector Geometry */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] border-b border-[var(--color-border)] pb-1">
                Injector Geometry
              </h4>
              <div className="grid grid-cols-2 gap-4">
                {/* Injector-specific frozen params, rendered per the live injector type (backend
                    authority via /api/config/injector_schema). Pintle shows pintle fields, doublet
                    shows doublet fields — no cross-type leakage. */}
                {injectorFrozenFields.length === 0 && (
                  <p className="col-span-2 text-xs text-[var(--color-text-secondary)] italic">
                    No freezable injector parameters for this injector type.
                  </p>
                )}
                {injectorFrozenFields.map((field) => {
                  const meta = FROZEN_INJECTOR_META[field];
                  const key = field as keyof FrozenParameters;
                  return (
                    <div key={field} className={`p-3 rounded-lg border ${isFrozen(key) ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-[var(--color-text-secondary)]">{meta.label}</label>
                        <input
                          type="checkbox"
                          checked={isFrozen(key)}
                          onChange={(e) => updateFrozenParam(key, e.target.checked ? meta.def : undefined)}
                          className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                        />
                      </div>
                      <input
                        type="number"
                        value={getFrozenValue(key)}
                        onChange={(e) => updateFrozenParam(key, e.target.value ? (meta.int ? parseInt(e.target.value) : parseFloat(e.target.value)) : undefined)}
                        disabled={!isFrozen(key)}
                        className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                        min={meta.min}
                        max={meta.max}
                        step={meta.step}
                        placeholder={`e.g. ${meta.def}`}
                      />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Initial Tank Pressures */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] border-b border-[var(--color-border)] pb-1">
                Initial Tank Pressures
              </h4>
              <div className="grid grid-cols-2 gap-4">
                {/* P_O_start_psi */}
                <div className={`p-3 rounded-lg border ${isFrozen('P_O_start_psi') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      LOX Tank P₀ [psi]
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('P_O_start_psi')}
                      onChange={(e) => updateFrozenParam('P_O_start_psi', e.target.checked ? 500 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('P_O_start_psi')}
                    onChange={(e) => updateFrozenParam('P_O_start_psi', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('P_O_start_psi')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="200"
                    max="800"
                    step="25"
                    placeholder="e.g. 500"
                  />
                </div>

                {/* P_F_start_psi */}
                <div className={`p-3 rounded-lg border ${isFrozen('P_F_start_psi') ? 'border-amber-500/50 bg-amber-500/10' : 'border-[var(--color-border)]'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-sm font-medium text-[var(--color-text-secondary)]">
                      Fuel Tank P₀ [psi]
                    </label>
                    <input
                      type="checkbox"
                      checked={isFrozen('P_F_start_psi')}
                      onChange={(e) => updateFrozenParam('P_F_start_psi', e.target.checked ? 600 : undefined)}
                      className="w-4 h-4 text-amber-500 bg-[var(--color-bg-primary)] border-[var(--color-border)] rounded"
                    />
                  </div>
                  <input
                    type="number"
                    value={getFrozenValue('P_F_start_psi')}
                    onChange={(e) => updateFrozenParam('P_F_start_psi', e.target.value ? parseFloat(e.target.value) : undefined)}
                    disabled={!isFrozen('P_F_start_psi')}
                    className="w-full px-3 py-2 bg-[var(--color-bg-primary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text-primary)] focus:outline-none focus:ring-2 focus:ring-amber-500 disabled:opacity-50"
                    min="200"
                    max="900"
                    step="25"
                    placeholder="e.g. 600"
                  />
                </div>
              </div>
            </div>

            {/* Summary of frozen parameters */}
            {requirements.frozen_parameters && Object.values(requirements.frozen_parameters).some(v => v !== undefined && v !== null) && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
                <p className="text-sm text-amber-300">
                  <strong>Frozen:</strong>{' '}
                  {Object.entries(requirements.frozen_parameters)
                    .filter(([, v]) => v !== undefined && v !== null)
                    .map(([k, v]) => `${k.replace(/_mm2?$|_psi$/g, '')}=${v}`)
                    .join(', ')}
                </p>
              </div>
            )}
          </div>
        </details>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
        >
          Save Design Requirements
        </button>
      </div>

      {/* Summary */}
      <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-6">
        <h3 className="text-lg font-semibold text-green-400 mb-4">Design Summary</h3>
        <div className="grid grid-cols-4 gap-4">
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Target Thrust</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.target_thrust.toFixed(0)} N</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Target Apogee</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{(requirements.target_apogee || 0).toFixed(0)} m</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Optimal O/F</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.optimal_of_ratio.toFixed(2)}</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Burn Time</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.target_burn_time.toFixed(1)} s</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Max LOX Pressure</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.max_lox_tank_pressure_psi.toFixed(0)} psi</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Max Fuel Pressure</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.max_fuel_tank_pressure_psi.toFixed(0)} psi</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">L* Range</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{requirements.min_Lstar.toFixed(2)} - {requirements.max_Lstar.toFixed(2)} m</p>
          </div>
          <div>
            <p className="text-xs text-[var(--color-text-secondary)]">Max Engine Length</p>
            <p className="text-lg font-bold text-[var(--color-text-primary)]">{(requirements.max_engine_length * 1000).toFixed(0)} mm</p>
          </div>
        </div>
      </div>
    </fieldset>
  );
}

