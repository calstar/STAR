import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import {
  runFlightSimulation,
  checkRocketPy,
  type FlightSimRequest,
  type FlightSimResponse,
  type FlightEnvironmentConfig,
  type FlightRocketConfig,
  type FlightTankConfig,
  type TimeSeriesData,
  type DesignRequirements,
} from '../api/client';

interface Layer4OptimizationProps {
  requirements: DesignRequirements | null;
}

// Session storage key
const TIMESERIES_RESULTS_KEY = 'timeseries_results';

interface StoredTimeSeriesResults {
  data: TimeSeriesData;
  timestamp: number;
}

function loadTimeSeriesFromSession(): TimeSeriesData | null {
  try {
    const stored = sessionStorage.getItem(TIMESERIES_RESULTS_KEY);
    if (!stored) return null;
    const parsed: StoredTimeSeriesResults = JSON.parse(stored);
    return parsed.data;
  } catch {
    return null;
  }
}

// Fluid densities (kg/m³)
const LOX_DENSITY = 1141; // Liquid oxygen at boiling point
const RP1_DENSITY = 820;  // RP-1 kerosene

// Fill factor - conservative to account for RocketPy's internal density calculations
const FILL_FACTOR = 0.85; // 85% fill factor

// Calculate cylindrical tank volume (m³)
function calculateTankVolume(height: number, radius: number): number {
  return Math.PI * radius * radius * height;
}

// Calculate max propellant mass for a tank (kg)
function calculateMaxPropellantMass(tank: FlightTankConfig, density: number): number {
  const volume = calculateTankVolume(tank.height, tank.radius);
  return volume * density * FILL_FACTOR;
}

// Generate time-series arrays from manual parameters
function generateThrustCurve(
  thrust_N: number,
  burn_time_s: number,
  mdot_O_kg_s: number,
  mdot_F_kg_s: number,
  n_points: number = 100
): {
  time: number[];
  thrust: number[];
  mdot_O: number[];
  mdot_F: number[];
} {
  const time: number[] = [];
  const thrust: number[] = [];
  const mdot_O: number[] = [];
  const mdot_F: number[] = [];

  for (let i = 0; i < n_points; i++) {
    const t = (i / (n_points - 1)) * burn_time_s;
    time.push(t);
    // Constant thrust profile (can be modified for more complex profiles)
    thrust.push(thrust_N);
    mdot_O.push(mdot_O_kg_s);
    mdot_F.push(mdot_F_kg_s);
  }

  return { time, thrust, mdot_O, mdot_F };
}

// Helper component for result cards
function ResultCard({
  label,
  value,
  unit,
  decimals = 2,
  color = 'cyan',
}: {
  label: string;
  value: number | string | undefined;
  unit?: string;
  decimals?: number;
  color?: string;
}) {
  const colorClasses: Record<string, string> = {
    cyan: 'bg-cyan-500/10 border-cyan-500/30',
    green: 'bg-green-500/10 border-green-500/30',
    blue: 'bg-blue-500/10 border-blue-500/30',
    purple: 'bg-purple-500/10 border-purple-500/30',
    orange: 'bg-orange-500/10 border-orange-500/30',
    red: 'bg-red-500/10 border-red-500/30',
    yellow: 'bg-yellow-500/10 border-yellow-500/30',
  };

  const textColorClasses: Record<string, string> = {
    cyan: 'text-cyan-400',
    green: 'text-green-400',
    blue: 'text-blue-400',
    purple: 'text-purple-400',
    orange: 'text-orange-400',
    red: 'text-red-400',
    yellow: 'text-yellow-400',
  };

  const displayValue = typeof value === 'number'
    ? value.toFixed(decimals)
    : value !== undefined && value !== null
      ? String(value)
      : '-';

  return (
    <div className={`rounded-lg p-3 border ${colorClasses[color] || colorClasses.cyan}`}>
      <p className="text-xs text-[var(--color-text-secondary)] mb-1">{label}</p>
      <p className={`text-lg font-bold ${textColorClasses[color] || textColorClasses.cyan}`}>
        {displayValue}
        {unit && <span className="text-sm font-normal text-[var(--color-text-secondary)] ml-1">{unit}</span>}
      </p>
    </div>
  );
}

// Collapsible section component
function CollapsibleSection({
  title,
  icon,
  children,
  defaultExpanded = false,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
}) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="border border-[var(--color-border)] rounded-lg overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-4 py-3 flex items-center justify-between bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] transition-colors"
      >
        <div className="flex items-center gap-2">
          {icon}
          <span className="font-medium text-[var(--color-text-primary)]">{title}</span>
        </div>
        <svg
          className={`w-5 h-5 text-[var(--color-text-secondary)] transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isExpanded && <div className="p-4 bg-[var(--color-bg-secondary)]">{children}</div>}
    </div>
  );
}

// Input field component
function InputField({
  label,
  value,
  onChange,
  unit,
  help,
  min,
  max,
  step,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  unit?: string;
  help?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-sm font-medium text-[var(--color-text-secondary)]">
        {label}
        {unit && <span className="text-[var(--color-text-tertiary)] ml-1">[{unit}]</span>}
      </label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500 disabled:opacity-50"
      />
      {help && <p className="text-xs text-[var(--color-text-tertiary)]">{help}</p>}
    </div>
  );
}

// Helper to get tomorrow's date as tuple (for atmospheric data availability)
function getTomorrowDateTuple(): [number, number, number, number] {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [tomorrow.getFullYear(), tomorrow.getMonth() + 1, tomorrow.getDate(), 12];
}

type DataSource = 'manual' | 'timeseries';

export function Layer4Optimization({ requirements }: Layer4OptimizationProps) {
  // RocketPy availability
  const [rocketPyAvailable, setRocketPyAvailable] = useState<boolean | null>(null);
  const [rocketPyMessage, setRocketPyMessage] = useState<string>('');

  // Data source selection
  const [dataSource, setDataSource] = useState<DataSource>('manual');

  // Time series data from session (optional)
  const [timeSeriesData, setTimeSeriesData] = useState<TimeSeriesData | null>(null);

  // Manual engine parameters
  const [thrust, setThrust] = useState(7000); // N
  const [burnTime, setBurnTime] = useState(10); // s
  const [mdotO, setMdotO] = useState(2.0); // kg/s
  const [mdotF, setMdotF] = useState(0.87); // kg/s (for O/F ~2.3)

  // Environment config
  const [envConfig, setEnvConfig] = useState<FlightEnvironmentConfig>({
    latitude: 32.99,
    longitude: -106.97,
    elevation: 1401,
    date: getTomorrowDateTuple(),
  });

  // Rocket config
  const [rocketConfig, setRocketConfig] = useState<FlightRocketConfig>({
    airframe_mass: 50,
    engine_mass: 10,
    lox_tank_structure_mass: 3,
    fuel_tank_structure_mass: 2,
    radius: 0.1,
    rocket_length: 3.0,
    motor_position: 0.5,
    inertia: [10, 10, 0.5],
  });

  // Propellant masses
  const [loxMass, setLoxMass] = useState(20);
  const [fuelMass, setFuelMass] = useState(10);

  // Tank config
  const [loxTankConfig, setLoxTankConfig] = useState<FlightTankConfig>({
    mass: 20,
    height: 0.5,
    radius: 0.08,
    position: 1.5,
  });

  const [fuelTankConfig, setFuelTankConfig] = useState<FlightTankConfig>({
    mass: 10,
    height: 0.3,
    radius: 0.08,
    position: 0.8,
  });

  // Results
  const [results, setResults] = useState<FlightSimResponse | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check RocketPy availability on mount
  useEffect(() => {
    checkRocketPy().then((response) => {
      setRocketPyAvailable(response.data?.available ?? false);
      setRocketPyMessage(response.data?.message ?? '');
    });
  }, []);

  // Load time series data from session
  useEffect(() => {
    const data = loadTimeSeriesFromSession();
    setTimeSeriesData(data);
  }, []);

  // Update from requirements when available
  useEffect(() => {
    if (requirements) {
      // Update thrust and burn time from requirements
      if (requirements.target_thrust) {
        setThrust(requirements.target_thrust);
      }
      if (requirements.target_burn_time) {
        setBurnTime(requirements.target_burn_time);
      }
      // Calculate mdot from thrust and O/F ratio
      if (requirements.target_thrust && requirements.optimal_of_ratio) {
        // Approximate: F = mdot_total * Ve, assume Ve ~ 2500 m/s for LOX/RP-1
        const Ve_approx = 2500;
        const mdot_total = requirements.target_thrust / Ve_approx;
        const OF = requirements.optimal_of_ratio;
        setMdotO(mdot_total * OF / (1 + OF));
        setMdotF(mdot_total / (1 + OF));
      }
      // Update tank masses from requirements if available
      if (requirements.lox_tank_capacity_kg) {
        setLoxMass(requirements.lox_tank_capacity_kg);
        setLoxTankConfig(prev => ({ ...prev, mass: requirements.lox_tank_capacity_kg! }));
      }
      if (requirements.fuel_tank_capacity_kg) {
        setFuelMass(requirements.fuel_tank_capacity_kg);
        setFuelTankConfig(prev => ({ ...prev, mass: requirements.fuel_tank_capacity_kg! }));
      }
    }
  }, [requirements]);

  // Check if we have time-series data
  const hasTimeSeriesData = timeSeriesData !== null && 
    timeSeriesData.time && timeSeriesData.time.length > 0 &&
    timeSeriesData.thrust_kN && timeSeriesData.thrust_kN.length > 0;

  // Calculate tank capacities based on geometry
  const loxTankCapacity = useMemo(() => ({
    volume: calculateTankVolume(loxTankConfig.height, loxTankConfig.radius),
    maxMass: calculateMaxPropellantMass(loxTankConfig, LOX_DENSITY),
  }), [loxTankConfig.height, loxTankConfig.radius]);

  const fuelTankCapacity = useMemo(() => ({
    volume: calculateTankVolume(fuelTankConfig.height, fuelTankConfig.radius),
    maxMass: calculateMaxPropellantMass(fuelTankConfig, RP1_DENSITY),
  }), [fuelTankConfig.height, fuelTankConfig.radius]);

  // Check if propellant masses exceed tank capacity
  const loxOverfilled = loxMass > loxTankCapacity.maxMass;
  const fuelOverfilled = fuelMass > fuelTankCapacity.maxMass;

  // Track mass adjustments made during simulation
  const [massAdjustments, setMassAdjustments] = useState<{
    loxOriginal?: number;
    loxAdjusted?: number;
    fuelOriginal?: number;
    fuelAdjusted?: number;
  } | null>(null);

  // Run flight simulation
  const runSimulation = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    setResults(null);
    setMassAdjustments(null);

    try {
      let time_array: number[];
      let thrust_array: number[];
      let mdot_O_array: number[];
      let mdot_F_array: number[];

      if (dataSource === 'timeseries' && hasTimeSeriesData && timeSeriesData) {
        // Use time-series data
        time_array = timeSeriesData.time;
        thrust_array = timeSeriesData.thrust_kN.map(t => t * 1000); // kN to N
        mdot_O_array = timeSeriesData.mdot_O_kg_s || timeSeriesData.time.map(() => mdotO);
        mdot_F_array = timeSeriesData.mdot_F_kg_s || timeSeriesData.time.map(() => mdotF);
      } else {
        // Generate from manual parameters
        const generated = generateThrustCurve(thrust, burnTime, mdotO, mdotF, 100);
        time_array = generated.time;
        thrust_array = generated.thrust;
        mdot_O_array = generated.mdot_O;
        mdot_F_array = generated.mdot_F;
      }

      // Auto-cap propellant masses to tank capacity to prevent overfill errors
      let effectiveLoxMass = loxMass;
      let effectiveFuelMass = fuelMass;
      const adjustments: typeof massAdjustments = {};

      if (loxMass > loxTankCapacity.maxMass) {
        adjustments.loxOriginal = loxMass;
        adjustments.loxAdjusted = loxTankCapacity.maxMass;
        effectiveLoxMass = loxTankCapacity.maxMass;
      }

      if (fuelMass > fuelTankCapacity.maxMass) {
        adjustments.fuelOriginal = fuelMass;
        adjustments.fuelAdjusted = fuelTankCapacity.maxMass;
        effectiveFuelMass = fuelTankCapacity.maxMass;
      }

      if (Object.keys(adjustments).length > 0) {
        setMassAdjustments(adjustments);
      }

      // Build request with capped masses
      const request: FlightSimRequest = {
        time_array,
        thrust_array,
        mdot_O_array,
        mdot_F_array,
        lox_mass_kg: effectiveLoxMass,
        fuel_mass_kg: effectiveFuelMass,
        lox_tank: loxTankConfig,
        fuel_tank: fuelTankConfig,
        environment: envConfig,
        rocket: rocketConfig,
      };

      const response = await runFlightSimulation(request);

      if (response.error) {
        setError(response.error);
      } else if (response.data) {
        setResults(response.data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsRunning(false);
    }
  }, [dataSource, hasTimeSeriesData, timeSeriesData, thrust, burnTime, mdotO, mdotF, loxMass, fuelMass, loxTankConfig, fuelTankConfig, envConfig, rocketConfig, loxTankCapacity.maxMass, fuelTankCapacity.maxMass]);

  // Prepare chart data
  const altitudeChartData = useMemo(() => {
    if (!results?.trajectory?.time || !results?.trajectory?.altitude) return [];
    return results.trajectory.time.map((t, i) => ({
      time: t,
      altitude: results.trajectory!.altitude[i],
    }));
  }, [results]);

  const velocityChartData = useMemo(() => {
    if (!results?.trajectory?.time || !results?.trajectory?.velocity) return [];
    return results.trajectory.time.map((t, i) => ({
      time: t,
      velocity: results.trajectory!.velocity[i],
    }));
  }, [results]);

  const targetApogee = requirements?.target_apogee ?? 3048;

  // Helper to format date tuple for display
  const formatDateForInput = (dateTuple: [number, number, number, number]): string => {
    const [year, month, day] = dateTuple;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };

  // Helper to parse date input to tuple
  const parseDateInput = (dateStr: string): [number, number, number, number] => {
    const [year, month, day] = dateStr.split('-').map(Number);
    return [year, month, day, 12];
  };

  // Calculate derived values for display
  const totalMdot = mdotO + mdotF;
  const ofRatio = mdotF > 0 ? mdotO / mdotF : 0;
  const estimatedIsp = thrust / (totalMdot * 9.81);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h2 className="text-2xl font-bold text-[var(--color-text-primary)] mb-2">✈️ Layer 4: Flight Simulation</h2>
        <p className="text-[var(--color-text-secondary)]">
          Run trajectory simulation using RocketPy to validate apogee and flight performance.
          Configure engine parameters directly or use data from Time-Series Analysis.
        </p>
      </div>

      {/* RocketPy Status */}
      {rocketPyAvailable === false && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 font-semibold">❌ RocketPy is not available</p>
          <p className="text-red-400/80 text-sm mt-1">
            {rocketPyMessage || 'Install RocketPy to enable flight simulation:'} <code className="bg-red-500/20 px-1 rounded">pip install rocketpy</code>
          </p>
        </div>
      )}

      {rocketPyAvailable === true && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-4">
          <p className="text-green-400 font-semibold">✅ RocketPy is available</p>
        </div>
      )}

      {/* Data Source Selection */}
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">📊 Data Source</h3>
        
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="dataSource"
              value="manual"
              checked={dataSource === 'manual'}
              onChange={() => setDataSource('manual')}
              className="w-4 h-4 text-cyan-500"
            />
            <span className="text-[var(--color-text-primary)]">Manual Parameters</span>
            <span className="text-xs text-[var(--color-text-tertiary)]">(enter thrust, burn time, mass flows)</span>
          </label>
          <label className={`flex items-center gap-2 ${hasTimeSeriesData ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}>
            <input
              type="radio"
              name="dataSource"
              value="timeseries"
              checked={dataSource === 'timeseries'}
              onChange={() => setDataSource('timeseries')}
              disabled={!hasTimeSeriesData}
              className="w-4 h-4 text-cyan-500"
            />
            <span className="text-[var(--color-text-primary)]">Time-Series Data</span>
            {hasTimeSeriesData ? (
              <span className="text-xs text-green-400">({timeSeriesData?.time?.length} points available)</span>
            ) : (
              <span className="text-xs text-yellow-400">(run Time-Series Analysis first)</span>
            )}
          </label>
        </div>
      </div>

      {/* Configuration Sections */}
      <div className="space-y-4">
        {/* Engine Parameters (only shown for manual mode) */}
        {dataSource === 'manual' && (
          <CollapsibleSection title="Engine Parameters" icon={<span>🔥</span>} defaultExpanded={true}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <InputField
                label="Thrust"
                value={thrust.toString()}
                onChange={(v) => setThrust(parseFloat(v) || 0)}
                unit="N"
                help="Engine thrust (constant profile)"
              />
              <InputField
                label="Burn Time"
                value={burnTime.toString()}
                onChange={(v) => setBurnTime(parseFloat(v) || 0)}
                unit="s"
                help="Total burn duration"
              />
              <InputField
                label="LOX Mass Flow"
                value={mdotO.toString()}
                onChange={(v) => setMdotO(parseFloat(v) || 0)}
                unit="kg/s"
                help="Oxidizer mass flow rate"
              />
              <InputField
                label="Fuel Mass Flow"
                value={mdotF.toString()}
                onChange={(v) => setMdotF(parseFloat(v) || 0)}
                unit="kg/s"
                help="Fuel mass flow rate"
              />
            </div>
            
            {/* Derived values */}
            <div className="mt-4 grid grid-cols-3 gap-4">
              <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
                <p className="text-xs text-[var(--color-text-secondary)]">O/F Ratio</p>
                <p className="text-lg font-semibold text-cyan-400">{ofRatio.toFixed(2)}</p>
              </div>
              <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
                <p className="text-xs text-[var(--color-text-secondary)]">Total mdot</p>
                <p className="text-lg font-semibold text-cyan-400">{totalMdot.toFixed(2)} kg/s</p>
              </div>
              <div className="bg-[var(--color-bg-tertiary)] rounded-lg p-3">
                <p className="text-xs text-[var(--color-text-secondary)]">Est. Isp</p>
                <p className="text-lg font-semibold text-cyan-400">{estimatedIsp.toFixed(0)} s</p>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Propellant Masses */}
        <CollapsibleSection title="Propellant Configuration" icon={<span>⛽</span>} defaultExpanded={true}>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <InputField
                label="LOX Mass"
                value={loxMass.toString()}
                onChange={(v) => setLoxMass(parseFloat(v) || 0)}
                unit="kg"
                help="Liquid oxygen propellant mass"
              />
              {/* Tank capacity info */}
              <div className={`mt-2 text-xs p-2 rounded ${loxOverfilled ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-[var(--color-bg-tertiary)]'}`}>
                <p className="text-[var(--color-text-tertiary)]">
                  Tank: {(loxTankCapacity.volume * 1000).toFixed(1)}L ({loxTankCapacity.volume.toFixed(4)} m³)
                </p>
                <p className={loxOverfilled ? 'text-yellow-400 font-medium' : 'text-[var(--color-text-tertiary)]'}>
                  Max capacity: {loxTankCapacity.maxMass.toFixed(1)} kg (85% fill)
                </p>
                {loxOverfilled && (
                  <p className="text-yellow-400 mt-1">
                    ⚠️ Overfilled by {(loxMass - loxTankCapacity.maxMass).toFixed(1)} kg — will be auto-capped
                  </p>
                )}
              </div>
            </div>
            <div>
              <InputField
                label="Fuel Mass"
                value={fuelMass.toString()}
                onChange={(v) => setFuelMass(parseFloat(v) || 0)}
                unit="kg"
                help="RP-1 fuel propellant mass"
              />
              {/* Tank capacity info */}
              <div className={`mt-2 text-xs p-2 rounded ${fuelOverfilled ? 'bg-yellow-500/10 border border-yellow-500/30' : 'bg-[var(--color-bg-tertiary)]'}`}>
                <p className="text-[var(--color-text-tertiary)]">
                  Tank: {(fuelTankCapacity.volume * 1000).toFixed(1)}L ({fuelTankCapacity.volume.toFixed(4)} m³)
                </p>
                <p className={fuelOverfilled ? 'text-yellow-400 font-medium' : 'text-[var(--color-text-tertiary)]'}>
                  Max capacity: {fuelTankCapacity.maxMass.toFixed(1)} kg (85% fill)
                </p>
                {fuelOverfilled && (
                  <p className="text-yellow-400 mt-1">
                    ⚠️ Overfilled by {(fuelMass - fuelTankCapacity.maxMass).toFixed(1)} kg — will be auto-capped
                  </p>
                )}
              </div>
            </div>
          </div>
          
          {/* Propellant consumption estimate */}
          {dataSource === 'manual' && (
            <div className="mt-4 bg-[var(--color-bg-tertiary)] rounded-lg p-3">
              <p className="text-sm text-[var(--color-text-secondary)]">
                At current flow rates, burn will consume{' '}
                <span className="text-cyan-400 font-semibold">{(mdotO * burnTime).toFixed(1)} kg LOX</span> and{' '}
                <span className="text-cyan-400 font-semibold">{(mdotF * burnTime).toFixed(1)} kg fuel</span>.
                {mdotO * burnTime > loxMass && <span className="text-red-400 ml-2">⚠️ LOX will run out!</span>}
                {mdotF * burnTime > fuelMass && <span className="text-red-400 ml-2">⚠️ Fuel will run out!</span>}
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* Environment */}
        <CollapsibleSection title="Environment" icon={<span>🌍</span>} defaultExpanded={false}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InputField
              label="Latitude"
              value={envConfig.latitude.toString()}
              onChange={(v) => setEnvConfig(prev => ({ ...prev, latitude: parseFloat(v) || 0 }))}
              unit="°"
            />
            <InputField
              label="Longitude"
              value={envConfig.longitude.toString()}
              onChange={(v) => setEnvConfig(prev => ({ ...prev, longitude: parseFloat(v) || 0 }))}
              unit="°"
            />
            <InputField
              label="Elevation"
              value={envConfig.elevation.toString()}
              onChange={(v) => setEnvConfig(prev => ({ ...prev, elevation: parseFloat(v) || 0 }))}
              unit="m"
            />
            <div className="space-y-1">
              <label className="block text-sm font-medium text-[var(--color-text-secondary)]">Date</label>
              <input
                type="date"
                value={formatDateForInput(envConfig.date)}
                onChange={(e) => setEnvConfig(prev => ({ ...prev, date: parseDateInput(e.target.value) }))}
                className="w-full px-3 py-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              />
              <p className="text-xs text-[var(--color-text-tertiary)]">Must be within forecast range (tomorrow or later)</p>
            </div>
          </div>
        </CollapsibleSection>

        {/* Rocket */}
        <CollapsibleSection title="Rocket Configuration" icon={<span>🚀</span>} defaultExpanded={false}>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <InputField
              label="Airframe Mass"
              value={rocketConfig.airframe_mass.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, airframe_mass: parseFloat(v) || 0 }))}
              unit="kg"
            />
            <InputField
              label="Engine Mass"
              value={rocketConfig.engine_mass.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, engine_mass: parseFloat(v) || 0 }))}
              unit="kg"
            />
            <InputField
              label="LOX Tank Structure Mass"
              value={rocketConfig.lox_tank_structure_mass.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, lox_tank_structure_mass: parseFloat(v) || 0 }))}
              unit="kg"
            />
            <InputField
              label="Fuel Tank Structure Mass"
              value={rocketConfig.fuel_tank_structure_mass.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, fuel_tank_structure_mass: parseFloat(v) || 0 }))}
              unit="kg"
            />
            <InputField
              label="Radius"
              value={rocketConfig.radius.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, radius: parseFloat(v) || 0 }))}
              unit="m"
            />
            <InputField
              label="Rocket Length"
              value={rocketConfig.rocket_length.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, rocket_length: parseFloat(v) || 0 }))}
              unit="m"
            />
            <InputField
              label="Motor Position"
              value={rocketConfig.motor_position.toString()}
              onChange={(v) => setRocketConfig(prev => ({ ...prev, motor_position: parseFloat(v) || 0 }))}
              unit="m"
            />
          </div>
        </CollapsibleSection>

        {/* Tanks */}
        <CollapsibleSection title="Tank Geometry" icon={<span>🛢️</span>} defaultExpanded={false}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <h4 className="font-medium text-[var(--color-text-primary)] mb-3">LOX Tank</h4>
              <div className="grid grid-cols-2 gap-3">
                <InputField
                  label="Height"
                  value={loxTankConfig.height.toString()}
                  onChange={(v) => setLoxTankConfig(prev => ({ ...prev, height: parseFloat(v) || 0 }))}
                  unit="m"
                />
                <InputField
                  label="Radius"
                  value={loxTankConfig.radius.toString()}
                  onChange={(v) => setLoxTankConfig(prev => ({ ...prev, radius: parseFloat(v) || 0 }))}
                  unit="m"
                />
                <InputField
                  label="Position"
                  value={loxTankConfig.position.toString()}
                  onChange={(v) => setLoxTankConfig(prev => ({ ...prev, position: parseFloat(v) || 0 }))}
                  unit="m"
                />
              </div>
            </div>
            <div>
              <h4 className="font-medium text-[var(--color-text-primary)] mb-3">Fuel Tank</h4>
              <div className="grid grid-cols-2 gap-3">
                <InputField
                  label="Height"
                  value={fuelTankConfig.height.toString()}
                  onChange={(v) => setFuelTankConfig(prev => ({ ...prev, height: parseFloat(v) || 0 }))}
                  unit="m"
                />
                <InputField
                  label="Radius"
                  value={fuelTankConfig.radius.toString()}
                  onChange={(v) => setFuelTankConfig(prev => ({ ...prev, radius: parseFloat(v) || 0 }))}
                  unit="m"
                />
                <InputField
                  label="Position"
                  value={fuelTankConfig.position.toString()}
                  onChange={(v) => setFuelTankConfig(prev => ({ ...prev, position: parseFloat(v) || 0 }))}
                  unit="m"
                />
              </div>
            </div>
          </div>
        </CollapsibleSection>
      </div>

      {/* Run Button */}
      <div className="flex justify-center">
        <button
          onClick={runSimulation}
          disabled={isRunning || !rocketPyAvailable}
          className="px-8 py-3 bg-cyan-600 hover:bg-cyan-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors flex items-center gap-2"
        >
          {isRunning ? (
            <>
              <svg className="animate-spin w-5 h-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Running Simulation...
            </>
          ) : (
            <>🚀 Run Flight Simulation</>
          )}
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4">
          <p className="text-red-400 font-semibold">❌ Error</p>
          <p className="text-red-400/80 text-sm mt-1">{error}</p>
        </div>
      )}

      {/* Mass Adjustment Notification */}
      {massAdjustments && (massAdjustments.loxAdjusted || massAdjustments.fuelAdjusted) && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-4">
          <p className="text-yellow-400 font-semibold">⚡ Propellant Masses Auto-Adjusted</p>
          <p className="text-yellow-400/80 text-sm mt-1">
            Propellant masses were capped to prevent tank overfill:
          </p>
          <ul className="text-yellow-400/80 text-sm mt-2 space-y-1">
            {massAdjustments.loxAdjusted && (
              <li>
                • LOX: {massAdjustments.loxOriginal?.toFixed(1)} kg → {massAdjustments.loxAdjusted.toFixed(1)} kg
                (reduced by {((massAdjustments.loxOriginal ?? 0) - massAdjustments.loxAdjusted).toFixed(1)} kg)
              </li>
            )}
            {massAdjustments.fuelAdjusted && (
              <li>
                • Fuel: {massAdjustments.fuelOriginal?.toFixed(1)} kg → {massAdjustments.fuelAdjusted.toFixed(1)} kg
                (reduced by {((massAdjustments.fuelOriginal ?? 0) - massAdjustments.fuelAdjusted).toFixed(1)} kg)
              </li>
            )}
          </ul>
          <p className="text-yellow-400/60 text-xs mt-2">
            💡 Increase tank height/radius in Tank Geometry to fit more propellant.
          </p>
        </div>
      )}

      {/* Results */}
      {results && (
        <div className="space-y-6">
          {/* Key Metrics */}
          <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
            <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">📊 Flight Results</h3>
            
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <ResultCard
                label="Apogee (AGL)"
                value={results.apogee_m}
                unit="m"
                decimals={0}
                color="cyan"
              />
              <ResultCard
                label="Target Apogee"
                value={targetApogee}
                unit="m"
                decimals={0}
                color="blue"
              />
              <ResultCard
                label="Max Velocity"
                value={results.max_velocity_m_s}
                unit="m/s"
                decimals={1}
                color="purple"
              />
              <ResultCard
                label="Apogee Error"
                value={results.apogee_m && targetApogee ? Math.abs(results.apogee_m - targetApogee) / targetApogee * 100 : undefined}
                unit="%"
                decimals={1}
                color={results.apogee_m && targetApogee && Math.abs(results.apogee_m - targetApogee) / targetApogee < 0.15 ? 'green' : 'orange'}
              />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-4">
              <ResultCard
                label="Flight Time"
                value={results.flight_time_s}
                unit="s"
                decimals={1}
                color="blue"
              />
              <ResultCard
                label="Apogee (ft)"
                value={results.apogee_ft}
                unit="ft"
                decimals={0}
                color="cyan"
              />
            </div>

            {results.truncation?.truncated && (
              <div className="mt-4 bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
                <p className="text-yellow-400 text-sm">
                  ⚠️ Burn truncated due to {results.truncation.reason} at {results.truncation.cutoff_time?.toFixed(2)}s
                </p>
              </div>
            )}

            {results.error && (
              <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                <p className="text-red-400 text-sm">⚠️ {results.error}</p>
              </div>
            )}
          </div>

          {/* Charts */}
          {altitudeChartData.length > 0 && (
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">📈 Altitude vs Time</h3>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={altitudeChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--color-text-secondary)"
                      label={{ value: 'Time (s)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      stroke="var(--color-text-secondary)"
                      label={{ value: 'Altitude (m)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--color-bg-tertiary)',
                        border: '1px solid var(--color-border)',
                        borderRadius: '8px',
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="altitude"
                      name="Altitude AGL"
                      stroke="#06b6d4"
                      strokeWidth={2}
                      dot={false}
                    />
                    <ReferenceLine y={targetApogee} stroke="#3b82f6" strokeDasharray="5 5" label="Target" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {velocityChartData.length > 0 && (
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">📈 Velocity vs Time</h3>
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={velocityChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis
                      dataKey="time"
                      stroke="var(--color-text-secondary)"
                      label={{ value: 'Time (s)', position: 'insideBottom', offset: -5 }}
                    />
                    <YAxis
                      stroke="var(--color-text-secondary)"
                      label={{ value: 'Velocity (m/s)', angle: -90, position: 'insideLeft' }}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: 'var(--color-bg-tertiary)',
                        border: '1px solid var(--color-border)',
                        borderRadius: '8px',
                      }}
                    />
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="velocity"
                      name="Vertical Velocity"
                      stroke="#a855f7"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Rocket Diagram */}
          {results.rocket_diagram && (
            <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl p-6">
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">🚀 Rocket Diagram</h3>
              <div className="flex justify-center">
                <img
                  src={`data:image/png;base64,${results.rocket_diagram}`}
                  alt="Rocket diagram"
                  className="max-w-full h-auto rounded-lg"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
