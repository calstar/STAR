import { useState, useCallback, useMemo } from 'react';
import { updateConfig } from '../api/client';
import type { EngineConfig } from '../api/client';

interface ConfigEditorProps {
  config: EngineConfig | null;
  onConfigUpdated: (config: EngineConfig) => void;
}

// Section metadata for better labels and descriptions
const SECTION_META: Record<string, { label: string; icon: string; description: string }> = {
  fluids: { label: 'Fluids', icon: '💧', description: 'Oxidizer and fuel properties' },
  injector: { label: 'Injector', icon: '🔧', description: 'Pintle injector geometry' },
  feed_system: { label: 'Feed System', icon: '⚡', description: 'Propellant feed configuration' },
  regen_cooling: { label: 'Regenerative Cooling', icon: '❄️', description: 'Cooling channel parameters' },
  film_cooling: { label: 'Film Cooling', icon: '🌊', description: 'Film cooling settings' },
  ablative_cooling: { label: 'Ablative Cooling', icon: '🔥', description: 'Ablative material properties' },
  graphite_insert: { label: 'Graphite Insert', icon: '⬛', description: 'Throat insert configuration' },
  stainless_steel_case: { label: 'Steel Case', icon: '🔩', description: 'Case material properties' },
  discharge: { label: 'Discharge Coefficients', icon: '📊', description: 'Cd models for oxidizer/fuel' },
  spray: { label: 'Spray Modeling', icon: '💨', description: 'Atomization and spray parameters' },
  combustion: { label: 'Combustion', icon: '🔥', description: 'CEA and efficiency models' },
  chamber_geometry: { label: 'Chamber Geometry (Unified)', icon: '🎯', description: 'Unified chamber and nozzle design parameters' },
  chamber: { label: 'Chamber', icon: '🎯', description: 'Combustion chamber geometry' },
  nozzle: { label: 'Nozzle', icon: '🚀', description: 'Nozzle expansion parameters' },
  solver: { label: 'Solver', icon: '⚙️', description: 'Numerical solver settings' },
  lox_tank: { label: 'LOX Tank', icon: '🛢️', description: 'Oxidizer tank geometry' },
  fuel_tank: { label: 'Fuel Tank', icon: '⛽', description: 'Fuel tank geometry' },
  press_tank: { label: 'Pressurization Tank', icon: '🎈', description: 'Pressurant system' },
  rocket: { label: 'Rocket', icon: '🚀', description: 'Vehicle mass and geometry' },
  environment: { label: 'Environment', icon: '🌍', description: 'Launch site conditions' },
  thrust: { label: 'Thrust Profile', icon: '📈', description: 'Burn duration settings' },
};

// Human-readable field labels
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  density: 'Density (kg/m³)',
  viscosity: 'Dynamic Viscosity (Pa·s)',
  surface_tension: 'Surface Tension (N/m)',
  vapor_pressure: 'Vapor Pressure (Pa)',
  specific_heat: 'Specific Heat (J/kg·K)',
  thermal_conductivity: 'Thermal Conductivity (W/m·K)',
  temperature: 'Temperature (K)',
  n_orifices: 'Number of Orifices',
  d_orifice: 'Orifice Diameter (m)',
  theta_orifice: 'Orifice Angle (°)',
  A_entry: 'Entry Area (m²)',
  d_hydraulic: 'Hydraulic Diameter (m)',
  d_pintle_tip: 'Pintle Tip Diameter (m)',
  d_reservoir_inner: 'Reservoir Inner Diameter (m)',
  h_gap: 'Gap Height (m)',
  d_inlet: 'Inlet Diameter (m)',
  A_hydraulic: 'Hydraulic Area (m²)',
  K0: 'Loss Coefficient K₀',
  K1: 'Loss Coefficient K₁',
  phi_type: 'Flow Type',
  enabled: 'Enabled',
  n_channels: 'Number of Channels',
  channel_width: 'Channel Width (m)',
  channel_height: 'Channel Height (m)',
  channel_length: 'Channel Length (m)',
  roughness: 'Surface Roughness (m)',
  wall_thickness: 'Wall Thickness (m)',
  wall_thermal_conductivity: 'Wall Thermal Conductivity (W/m·K)',
  chamber_inner_diameter: 'Chamber Inner Diameter (m)',
  n_segments: 'Number of Segments',
  mass_fraction: 'Mass Fraction',
  effectiveness_ref: 'Reference Effectiveness',
  decay_length: 'Decay Length (m)',
  slot_height: 'Slot Height (m)',
  material_density: 'Material Density (kg/m³)',
  heat_of_ablation: 'Heat of Ablation (J/kg)',
  initial_thickness: 'Initial Thickness (m)',
  surface_temperature_limit: 'Surface Temp Limit (K)',
  coverage_fraction: 'Coverage Fraction',
  pyrolysis_temperature: 'Pyrolysis Temperature (K)',
  blowing_efficiency: 'Blowing Efficiency',
  Cd_inf: 'Cd (∞ Re)',
  a_Re: 'Reynolds Number Coefficient',
  Cd_min: 'Minimum Cd',
  P_ref: 'Reference Pressure (Pa)',
  T_ref: 'Reference Temperature (K)',
  volume: 'Volume (m³)',
  A_throat: 'Throat Area (m²)',
  length: 'Total Chamber Length (m)',
  length_cylindrical: 'Cylindrical Length (m)',
  length_contraction: 'Contraction Length (m)',
  Lstar: 'L* (m)',
  design_pressure: 'Design Pressure (Pa)',
  design_thrust: 'Design Thrust (N)',
  design_MR: 'Design Mixture Ratio',
  A_exit: 'Exit Area (m²)',
  expansion_ratio: 'Expansion Ratio',
  exit_diameter: 'Exit Diameter (m)',
  Cf: 'Thrust Coefficient (Cf)',
  efficiency: 'Efficiency',
  method: 'Solver Method',
  tolerance: 'Tolerance',
  max_iterations: 'Max Iterations',
  burn_time: 'Burn Time (s)',
  latitude: 'Latitude (°)',
  longitude: 'Longitude (°)',
  elevation: 'Elevation (m)',
  airframe_mass: 'Airframe Mass (kg)',
  engine_mass: 'Engine Mass (kg)',
  rocket_length: 'Rocket Length (m)',
  radius: 'Radius (m)',
  ox_name: 'Oxidizer Name',
  fuel_name: 'Fuel Name',
  cache_file: 'Cache File',
  n_points: 'Grid Points',
  // LOX Tank
  lox_h: 'LOX Tank Height (m)',
  lox_radius: 'LOX Tank Radius (m)',
  ox_tank_pos: 'LOX Tank Position (m)',
  // Fuel Tank
  rp1_h: 'RP-1 Tank Height (m)',
  rp1_radius: 'RP-1 Tank Radius (m)',
  fuel_tank_pos: 'Fuel Tank Position (m)',
  // Pressurant Tank
  press_h: 'Pressurant Tank Height (m)',
  press_radius: 'Pressurant Tank Radius (m)',
  pres_tank_pos: 'Pressurant Tank Position (m)',
  dry_mass: 'Dry Mass (kg)',
  initial_gas_mass: 'Initial Gas Mass (kg)',
  free_volume_L: 'Free Volume (L)',
  // Rocket
  mass: 'Mass (kg)',
  cm_wo_motor: 'CM Without Motor (m)',
  copv_dry_mass: 'COPV Dry Mass (kg)',
  lox_tank_structure_mass: 'LOX Tank Structure Mass (kg)',
  fuel_tank_structure_mass: 'Fuel Tank Structure Mass (kg)',
  propulsion_dry_mass: 'Propulsion Dry Mass (kg)',
  propulsion_cm_offset: 'Propulsion CM Offset (m)',
  engine_cm_offset: 'Engine CM Offset (m)',
  motor_position: 'Motor Position (m)',
  inertia: 'Inertia (kg·m²)',
  // Fins
  fins: 'Fins',
  no_fins: 'Number of Fins',
  root_chord: 'Root Chord (m)',
  tip_chord: 'Tip Chord (m)',
  fin_span: 'Fin Span (m)',
  fin_position: 'Fin Position (m)',
  // Environment
  date: 'Date',
};

function getFieldLabel(key: string): string {
  return FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

interface InputFieldProps {
  label: string;
  value: unknown;
  onChange: (value: unknown) => void;
  path: string[];
}

function InputField({ label, value, onChange }: InputFieldProps) {
  const [localValue, setLocalValue] = useState<string>(
    value === null ? '' : String(value)
  );

  const handleBlur = () => {
    if (value === null && localValue === '') return;

    // Try to parse as number
    if (typeof value === 'number' || (!isNaN(Number(localValue)) && localValue !== '')) {
      const num = Number(localValue);
      if (!isNaN(num)) {
        onChange(num);
        return;
      }
    }

    // Handle boolean
    if (localValue.toLowerCase() === 'true') {
      onChange(true);
      return;
    }
    if (localValue.toLowerCase() === 'false') {
      onChange(false);
      return;
    }

    // Handle null
    if (localValue === '' || localValue.toLowerCase() === 'null') {
      onChange(null);
      return;
    }

    onChange(localValue);
  };

  // Special handling for boolean values
  if (typeof value === 'boolean') {
    return (
      <div className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors">
        <label className="text-sm text-[var(--color-text-secondary)]">{label}</label>
        <button
          onClick={() => onChange(!value)}
          className={`relative w-12 h-6 rounded-full transition-colors ${value ? 'bg-blue-500' : 'bg-gray-600'
            }`}
        >
          <span
            className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${value ? 'left-7' : 'left-1'
              }`}
          />
        </button>
      </div>
    );
  }

  // Number input
  if (typeof value === 'number') {
    return (
      <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors">
        <label className="text-sm text-[var(--color-text-secondary)] flex-1">{label}</label>
        <input
          type="text"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleBlur}
          className="w-32 px-3 py-1.5 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm text-right font-mono focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-colors"
        />
      </div>
    );
  }

  // String/null input
  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors">
      <label className="text-sm text-[var(--color-text-secondary)] flex-1">{label}</label>
      <input
        type="text"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={handleBlur}
        placeholder={value === null ? 'null' : ''}
        className={`w-40 px-3 py-1.5 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-colors ${value === null ? 'text-gray-500 italic' : 'text-[var(--color-text-primary)]'
          }`}
      />
    </div>
  );
}

interface ArrayFieldProps {
  label: string;
  value: unknown[];
  onChange: (value: unknown[]) => void;
}

function ArrayField({ label, value, onChange }: ArrayFieldProps) {
  const [localValues, setLocalValues] = useState<string[]>(
    value.map(v => String(v))
  );

  const handleItemChange = (index: number, newValue: string) => {
    const newValues = [...localValues];
    newValues[index] = newValue;
    setLocalValues(newValues);
  };

  const handleBlur = () => {
    const parsed = localValues.map(v => {
      const num = Number(v);
      return isNaN(num) ? v : num;
    });
    onChange(parsed);
  };

  return (
    <div className="py-2 px-3 rounded-lg hover:bg-[var(--color-bg-tertiary)] transition-colors">
      <label className="text-sm text-[var(--color-text-secondary)] block mb-2">{label}</label>
      <div className="flex flex-wrap gap-2">
        {localValues.map((item, index) => (
          <input
            key={index}
            type="text"
            value={item}
            onChange={(e) => handleItemChange(index, e.target.value)}
            onBlur={handleBlur}
            className="w-20 px-2 py-1 rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm text-center font-mono focus:border-blue-500 focus:outline-none transition-colors"
          />
        ))}
      </div>
    </div>
  );
}

interface SubSectionProps {
  title: string;
  data: Record<string, unknown>;
  path: string[];
  onEdit: (path: string[], value: unknown) => void;
  defaultExpanded?: boolean;
}

function SubSection({ title, data, path, onEdit, defaultExpanded = true }: SubSectionProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const renderField = (key: string, value: unknown) => {
    const fieldPath = [...path, key];

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return (
        <SubSection
          key={key}
          title={getFieldLabel(key)}
          data={value as Record<string, unknown>}
          path={fieldPath}
          onEdit={onEdit}
          defaultExpanded={false}
        />
      );
    }

    if (Array.isArray(value)) {
      return (
        <ArrayField
          key={key}
          label={getFieldLabel(key)}
          value={value}
          onChange={(newValue) => onEdit(fieldPath, newValue)}
        />
      );
    }

    return (
      <InputField
        key={key}
        label={getFieldLabel(key)}
        value={value}
        path={fieldPath}
        onChange={(newValue) => onEdit(fieldPath, newValue)}
      />
    );
  };

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden mb-2">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-primary)] transition-colors"
      >
        <span className="text-sm font-medium text-[var(--color-text-primary)]">{title}</span>
        <svg
          className={`w-4 h-4 text-[var(--color-text-secondary)] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isExpanded && (
        <div className="px-2 py-1 bg-[var(--color-bg-secondary)]">
          {Object.entries(data).map(([key, value]) => renderField(key, value))}
        </div>
      )}
    </div>
  );
}

interface SectionCardProps {
  sectionKey: string;
  data: Record<string, unknown> | null;
  onEdit: (path: string[], value: unknown) => void;
}

function SectionCard({ sectionKey, data, onEdit }: SectionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const meta = SECTION_META[sectionKey] || {
    label: sectionKey.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
    icon: '📄',
    description: '',
  };

  if (data === null || data === undefined) {
    return (
      <div className="bg-[var(--color-bg-tertiary)] rounded-xl p-4 opacity-50">
        <div className="flex items-center gap-3">
          <span className="text-xl">{meta.icon}</span>
          <div>
            <h4 className="font-medium text-[var(--color-text-primary)]">{meta.label}</h4>
            <p className="text-xs text-[var(--color-text-secondary)]">Not configured</p>
          </div>
        </div>
      </div>
    );
  }

  const fieldCount = Object.keys(data).length;

  const renderField = (key: string, value: unknown) => {
    const fieldPath = [sectionKey, key];

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return (
        <SubSection
          key={key}
          title={getFieldLabel(key)}
          data={value as Record<string, unknown>}
          path={fieldPath}
          onEdit={onEdit}
          defaultExpanded={true}
        />
      );
    }

    if (Array.isArray(value)) {
      return (
        <ArrayField
          key={key}
          label={getFieldLabel(key)}
          value={value}
          onChange={(newValue) => onEdit(fieldPath, newValue)}
        />
      );
    }

    return (
      <InputField
        key={key}
        label={getFieldLabel(key)}
        value={value}
        path={fieldPath}
        onChange={(newValue) => onEdit(fieldPath, newValue)}
      />
    );
  };

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl overflow-hidden transition-all duration-200">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-[var(--color-bg-tertiary)] transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">{meta.icon}</span>
          <div className="text-left">
            <h4 className="font-medium text-[var(--color-text-primary)]">{meta.label}</h4>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {meta.description} • {fieldCount} {fieldCount === 1 ? 'field' : 'fields'}
            </p>
          </div>
        </div>
        <svg
          className={`w-5 h-5 text-[var(--color-text-secondary)] transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 border-t border-[var(--color-border)]">
          <div className="pt-3 space-y-1">
            {Object.entries(data).map(([key, value]) => renderField(key, value))}
          </div>
        </div>
      )}
    </div>
  );
}

export function ConfigEditor({ config, onConfigUpdated }: ConfigEditorProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<Record<string, unknown>>({});
  const [searchQuery, setSearchQuery] = useState('');

  const handleEdit = useCallback((path: string[], value: unknown) => {
    const buildUpdate = (path: string[], value: unknown): Record<string, unknown> => {
      if (path.length === 0) return value as Record<string, unknown>;
      const [first, ...rest] = path;
      return { [first]: buildUpdate(rest, value) };
    };

    const update = buildUpdate(path, value);
    setPendingChanges(prev => {
      const merge = (a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> => {
        const result = { ...a };
        for (const [key, val] of Object.entries(b)) {
          if (typeof val === 'object' && val !== null && !Array.isArray(val) && typeof result[key] === 'object') {
            result[key] = merge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
          } else {
            result[key] = val;
          }
        }
        return result;
      };
      return merge(prev, update);
    });
  }, []);

  const handleSave = async () => {
    if (Object.keys(pendingChanges).length === 0) return;

    setIsSaving(true);
    setError(null);

    const result = await updateConfig(pendingChanges as Partial<EngineConfig>);

    setIsSaving(false);

    if (result.error) {
      setError(result.error);
    } else if (result.data) {
      onConfigUpdated(result.data.config);
      setPendingChanges({});
    }
  };

  const handleDiscard = () => {
    setPendingChanges({});
  };

  // Order sections logically
  const sectionOrder = [
    'fluids', 'injector', 'feed_system', 'discharge', 'spray',
    'combustion', 'chamber', 'nozzle',
    'regen_cooling', 'film_cooling', 'ablative_cooling', 'graphite_insert',
    'lox_tank', 'fuel_tank', 'press_tank', 'rocket',
    'solver', 'environment', 'thrust',
  ];

  const filteredSections = useMemo(() => {
    if (!config) return [];

    const sections = sectionOrder.filter(key => key in config);
    // Add any remaining sections not in the predefined order
    Object.keys(config).forEach(key => {
      if (!sections.includes(key)) sections.push(key);
    });

    if (!searchQuery) return sections;

    return sections.filter(key => {
      const meta = SECTION_META[key];
      const label = meta?.label || key;
      return label.toLowerCase().includes(searchQuery.toLowerCase()) ||
        key.toLowerCase().includes(searchQuery.toLowerCase());
    });
  }, [config, searchQuery]);

  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <p className="text-lg font-medium">No Configuration Loaded</p>
          <p className="text-sm mt-1 opacity-70">Upload a YAML config file to get started</p>
        </div>
      </div>
    );
  }

  const hasChanges = Object.keys(pendingChanges).length > 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header with search and save/discard buttons */}
      <div className="flex-shrink-0 p-4 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center justify-between gap-4 mb-3">
          <h3 className="font-semibold text-lg text-[var(--color-text-primary)]">Configuration Editor</h3>
          {hasChanges && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-yellow-400 flex items-center gap-1.5">
                <span className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                Unsaved changes
              </span>
              <button
                onClick={handleDiscard}
                className="px-3 py-1.5 text-sm rounded-lg border border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors text-[var(--color-text-secondary)]"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-4 py-1.5 text-sm rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 font-medium"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          )}
        </div>

        {/* Search bar */}
        <div className="relative">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-text-secondary)]"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search sections..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm placeholder-[var(--color-text-secondary)] focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500/50 transition-colors"
          />
        </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="m-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm flex items-center gap-2">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      {/* Section cards */}
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {filteredSections.map((key) => (
          <SectionCard
            key={key}
            sectionKey={key}
            data={config[key] as Record<string, unknown> | null}
            onEdit={handleEdit}
          />
        ))}

        {filteredSections.length === 0 && searchQuery && (
          <div className="text-center py-8 text-[var(--color-text-secondary)]">
            <p>No sections match "{searchQuery}"</p>
          </div>
        )}
      </div>
    </div>
  );
}
