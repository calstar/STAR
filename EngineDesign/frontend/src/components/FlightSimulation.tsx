import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
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
  optimizeFlightAltitude,
  checkRocketPy,
  updateConfig,
  type EngineConfig,
  type FlightSimRequest,
  type FlightSimResponse,
  type FlightOptimizeResponse,
  type FlightEnvironmentConfig,
  type FlightRocketConfig,
  type FlightFinsConfig,
  type TimeSeriesData,
  type TimeSeriesSummary,
} from '../api/client';
import { useReadOnly } from '@stardesign-ui';
import { useDesignSlice } from '../lib/designState';
import {
  loadTimeSeriesResults,
  TIMESERIES_UPDATED_EVENT,
} from '../utils/timeseriesSession';

interface FlightSimulationProps {
  config: EngineConfig | null;
  isVisible?: boolean;
  onConfigUpdated?: (config: EngineConfig) => void;
}

// Session storage handled via timeseriesSession utility (shared with TimeSeriesMode)

function readTimeSeriesFromSession(): { data: TimeSeriesData; summary: TimeSeriesSummary | null; timestamp: number | null } | null {
  const stored = loadTimeSeriesResults();
  if (!stored) return null;
  return { data: stored.data, summary: stored.summary, timestamp: stored.timestamp };
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
  // Every numeric field on this tab renders through here, and they all feed
  // Save Configuration, which writes the config.
  const readOnly = useReadOnly();
  return (
    <div>
      <label className="block text-sm text-[var(--color-text-secondary)] mb-1">{label}</label>
      <div className="relative">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          step={step}
          disabled={disabled || readOnly}
          className="w-full px-3 py-2 pr-12 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors disabled:opacity-50"
        />
        {unit && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)] text-sm">
            {unit}
          </span>
        )}
      </div>
      {help && <p className="text-xs text-[var(--color-text-muted)] mt-1">{help}</p>}
    </div>
  );
}

// Metric card component
function MetricCard({
  label,
  value,
  unit,
  subValue,
  color = 'blue',
}: {
  label: string;
  value: string;
  unit: string;
  subValue?: string;
  color?: 'blue' | 'green' | 'purple' | 'orange';
}) {
  const colorClasses = {
    blue: 'from-blue-500/20 to-blue-600/10 border-blue-500/30',
    green: 'from-green-500/20 to-green-600/10 border-green-500/30',
    purple: 'from-purple-500/20 to-purple-600/10 border-purple-500/30',
    orange: 'from-orange-500/20 to-orange-600/10 border-orange-500/30',
  };

  return (
    <div className={`p-4 rounded-xl bg-gradient-to-br ${colorClasses[color]} border`}>
      <p className="text-sm text-[var(--color-text-secondary)]">{label}</p>
      <p className="text-2xl font-bold text-[var(--color-text-primary)] mt-1">
        {value} <span className="text-base font-normal text-[var(--color-text-secondary)]">{unit}</span>
      </p>
      {subValue && <p className="text-sm text-[var(--color-text-muted)] mt-1">{subValue}</p>}
    </div>
  );
}

export function FlightSimulation({ config, isVisible = true, onConfigUpdated }: FlightSimulationProps) {
  // RocketPy availability
  const [rocketPyAvailable, setRocketPyAvailable] = useState<boolean | null>(null);
  const [rocketPyMessage, setRocketPyMessage] = useState<string>('');

  // Propellant configuration
  const [loxMass, setLoxMass] = useState('18.0');
  const [fuelMass, setFuelMass] = useState('4.0');

  // Environment configuration - default to tomorrow's date
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const [latitude, setLatitude] = useState('35.0');
  const [longitude, setLongitude] = useState('-117.0');
  const [elevation, setElevation] = useState('0.0');
  const [launchYear, setLaunchYear] = useState(String(tomorrow.getFullYear()));
  const [launchMonth, setLaunchMonth] = useState(String(tomorrow.getMonth() + 1));
  const [launchDay, setLaunchDay] = useState(String(tomorrow.getDate()));
  const [launchHour, setLaunchHour] = useState('12');
  const [atmosphereModel, setAtmosphereModel] = useState<'standard_atmosphere' | 'forecast'>('standard_atmosphere');

  // Rocket configuration
  const [airframeMass, setAirframeMass] = useState('78.72');
  const [engineMass, setEngineMass] = useState('8.0');
  const [loxTankMass, setLoxTankMass] = useState('5.0');
  const [fuelTankMass, setFuelTankMass] = useState('3.0');
  const [rocketRadius, setRocketRadius] = useState('0.1015');
  const [rocketLength, setRocketLength] = useState('3.5');
  const [motorPosition, setMotorPosition] = useState('0.0');
  const [inertiaX, setInertiaX] = useState('8.0');
  const [inertiaY, setInertiaY] = useState('8.0');
  const [inertiaZ, setInertiaZ] = useState('0.5');
  const [autoInertia, setAutoInertia] = useState(false);
  const [noseFineness, setNoseFineness] = useState('4.5');
  const [avionicsLength, setAvionicsLength] = useState('4.0');

  // Fins configuration
  const [finCount, setFinCount] = useState('3');
  const [rootChord, setRootChord] = useState('0.2');
  const [tipChord, setTipChord] = useState('0.1');
  const [finSpan, setFinSpan] = useState('0.3');
  const [finPosition, setFinPosition] = useState('0.1');

  // Results
  const [results, setResults] = useState<FlightSimResponse | null>(null);
  const [optimizeResults, setOptimizeResults] = useState<FlightOptimizeResponse | null>(null);
  const [flightMode, setFlightMode] = useState<'manual' | 'optimize'>('manual');
  const [targetApogeeM, setTargetApogeeM] = useState('3048');
  const [apogeeToleranceM, setApogeeToleranceM] = useState('15');

  // The fields Save Configuration does NOT write. Everything else on this tab
  // round-trips through config.rocket / config.environment on an explicit save;
  // these seven have no config field at all, so they were lost on reload.
  useDesignSlice('flight', {
    atmosphereModel: [atmosphereModel, setAtmosphereModel],
    autoInertia: [autoInertia, setAutoInertia],
    noseFineness: [noseFineness, setNoseFineness],
    avionicsLength: [avionicsLength, setAvionicsLength],
    flightMode: [flightMode, setFlightMode],
    targetApogeeM: [targetApogeeM, setTargetApogeeM],
    apogeeToleranceM: [apogeeToleranceM, setApogeeToleranceM],
  });
  const [isLoading, setIsLoading] = useState(false);
  // Only Save Configuration writes the design (updateConfig); running the
  // flight sim just reads it, so the Run button stays live while read only.
  const readOnly = useReadOnly();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastPropellantConfigKey = useRef<string | null>(null);

  // Time-series data from session (refreshed on tab focus + timeseries-updated event)
  const [timeSeriesBundle, setTimeSeriesBundle] = useState(() => readTimeSeriesFromSession());
  const timeSeriesData = timeSeriesBundle?.data ?? null;
  const timeSeriesSummary = timeSeriesBundle?.summary ?? null;
  const timeSeriesTimestamp = timeSeriesBundle?.timestamp ?? null;
  const hasTimeSeriesData = timeSeriesData !== null && timeSeriesData.time.length > 0;

  const reloadTimeSeries = useCallback(() => {
    setTimeSeriesBundle(readTimeSeriesFromSession());
  }, []);

  useEffect(() => {
    reloadTimeSeries();
    const onUpdate = () => reloadTimeSeries();
    window.addEventListener(TIMESERIES_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(TIMESERIES_UPDATED_EVENT, onUpdate);
  }, [reloadTimeSeries]);

  useEffect(() => {
    if (isVisible) {
      reloadTimeSeries();
    }
  }, [isVisible, reloadTimeSeries]);

  // Check RocketPy availability on mount
  useEffect(() => {
    async function check() {
      const result = await checkRocketPy();
      if (result.data) {
        setRocketPyAvailable(result.data.available);
        setRocketPyMessage(result.data.message);
      } else {
        setRocketPyAvailable(false);
        setRocketPyMessage('Failed to check RocketPy availability');
      }
    }
    check();
  }, []);

  // Load config values when config changes
  useEffect(() => {
    if (!config) return;

    // Environment - load from config but always use tomorrow's date
    const env = config.environment as Record<string, unknown> | undefined;
    if (env) {
      if (typeof env.latitude === 'number') setLatitude(String(env.latitude));
      if (typeof env.longitude === 'number') setLongitude(String(env.longitude));
      if (typeof env.elevation === 'number') setElevation(String(env.elevation));
      // Date always defaults to tomorrow (set in initial state), don't load from config
    }

    // Propellant masses — only reset sliders when config tank masses change (new upload / save)
    const loxTank = config.lox_tank as Record<string, unknown> | undefined;
    const fuelTank = config.fuel_tank as Record<string, unknown> | undefined;
    const propKey = `${loxTank?.mass ?? ''}|${fuelTank?.mass ?? ''}`;
    if (lastPropellantConfigKey.current !== propKey) {
      lastPropellantConfigKey.current = propKey;
      if (loxTank && typeof loxTank.mass === 'number') setLoxMass(String(loxTank.mass));
      if (fuelTank && typeof fuelTank.mass === 'number') setFuelMass(String(fuelTank.mass));
    }

    const dr = config.design_requirements as Record<string, unknown> | undefined;
    if (dr && typeof dr.target_apogee === 'number') {
      setTargetApogeeM(String(dr.target_apogee));
    }

    // Rocket configuration
    const rocket = config.rocket as Record<string, unknown> | undefined;
    if (rocket) {
      if (typeof rocket.airframe_mass === 'number') setAirframeMass(String(rocket.airframe_mass));
      if (typeof rocket.engine_mass === 'number') setEngineMass(String(rocket.engine_mass));
      if (typeof rocket.lox_tank_structure_mass === 'number') setLoxTankMass(String(rocket.lox_tank_structure_mass));
      if (typeof rocket.fuel_tank_structure_mass === 'number') setFuelTankMass(String(rocket.fuel_tank_structure_mass));
      if (typeof rocket.radius === 'number') setRocketRadius(String(rocket.radius));
      if (typeof rocket.rocket_length === 'number') setRocketLength(String(rocket.rocket_length));
      if (typeof rocket.motor_position === 'number') setMotorPosition(String(rocket.motor_position));

      const inertia = rocket.inertia as number[] | undefined;
      if (Array.isArray(inertia) && inertia.length >= 3) {
        setInertiaX(String(inertia[0]));
        setInertiaY(String(inertia[1]));
        setInertiaZ(String(inertia[2]));
      }

      const fins = rocket.fins as Record<string, unknown> | undefined;
      if (fins) {
        if (typeof fins.no_fins === 'number') setFinCount(String(fins.no_fins));
        if (typeof fins.root_chord === 'number') setRootChord(String(fins.root_chord));
        if (typeof fins.tip_chord === 'number') setTipChord(String(fins.tip_chord));
        if (typeof fins.fin_span === 'number') setFinSpan(String(fins.fin_span));
        if (typeof fins.fin_position === 'number') setFinPosition(String(fins.fin_position));
      }
    }
  }, [config]);

  // Auto-estimate inertia when enabled
  useEffect(() => {
    if (autoInertia) {
      const mDry = parseFloat(airframeMass) + parseFloat(engineMass) + parseFloat(loxTankMass) + parseFloat(fuelTankMass);
      const r = parseFloat(rocketRadius);
      const L = parseFloat(rocketLength);

      if (!isNaN(mDry) && !isNaN(r) && !isNaN(L) && mDry > 0 && r > 0 && L > 0) {
        // Solid cylinder approximation
        const ixx = (1 / 12) * mDry * (3 * r * r + L * L);
        const iyy = ixx;
        const izz = 0.5 * mDry * r * r;

        setInertiaX(ixx.toFixed(3));
        setInertiaY(iyy.toFixed(3));
        setInertiaZ(izz.toFixed(4));
      }
    }
  }, [autoInertia, airframeMass, engineMass, loxTankMass, fuelTankMass, rocketRadius, rocketLength]);

  // Calculate propulsion dry mass
  const propulsionDryMass = useMemo(() => {
    const engine = parseFloat(engineMass) || 0;
    const loxTank = parseFloat(loxTankMass) || 0;
    const fuelTank = parseFloat(fuelTankMass) || 0;
    return engine + loxTank + fuelTank;
  }, [engineMass, loxTankMass, fuelTankMass]);

  // Calculate total dry mass
  const totalDryMass = useMemo(() => {
    const airframe = parseFloat(airframeMass) || 0;
    return airframe + propulsionDryMass;
  }, [airframeMass, propulsionDryMass]);

  // Build shared flight request from current UI state + time-series data
  const buildFlightRequest = useCallback(
    (activeTimeSeries: TimeSeriesData, lox: number, fuel: number): FlightSimRequest => {
      const environment: FlightEnvironmentConfig = {
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        elevation: parseFloat(elevation),
        date: [parseInt(launchYear), parseInt(launchMonth), parseInt(launchDay), parseInt(launchHour)],
        atmosphere_model: atmosphereModel,
      };

      const fins: FlightFinsConfig = {
        no_fins: parseInt(finCount),
        root_chord: parseFloat(rootChord),
        tip_chord: parseFloat(tipChord),
        fin_span: parseFloat(finSpan),
        fin_position: parseFloat(finPosition),
      };

      const rocket: FlightRocketConfig = {
        airframe_mass: parseFloat(airframeMass),
        engine_mass: parseFloat(engineMass),
        lox_tank_structure_mass: parseFloat(loxTankMass),
        fuel_tank_structure_mass: parseFloat(fuelTankMass),
        radius: parseFloat(rocketRadius),
        rocket_length: parseFloat(rocketLength),
        motor_position: parseFloat(motorPosition),
        inertia: [parseFloat(inertiaX), parseFloat(inertiaY), parseFloat(inertiaZ)],
        fins,
        nose_fineness_ratio: parseFloat(noseFineness),
        avionics_payload_length_m: parseFloat(avionicsLength),
      };

      const thrustN = activeTimeSeries.thrust_kN.map((t) => t * 1000);

      return {
        time_array: activeTimeSeries.time,
        thrust_array: thrustN,
        mdot_O_array: activeTimeSeries.mdot_O_kg_s,
        mdot_F_array: activeTimeSeries.mdot_F_kg_s,
        lox_mass_kg: lox,
        fuel_mass_kg: fuel,
        environment,
        rocket,
      };
    },
    [
      latitude,
      longitude,
      elevation,
      launchYear,
      launchMonth,
      launchDay,
      launchHour,
      atmosphereModel,
      finCount,
      rootChord,
      tipChord,
      finSpan,
      finPosition,
      airframeMass,
      engineMass,
      loxTankMass,
      fuelTankMass,
      rocketRadius,
      rocketLength,
      motorPosition,
      inertiaX,
      inertiaY,
      inertiaZ,
      noseFineness,
      avionicsLength,
    ]
  );

  // Run manual simulation
  const handleSimulate = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setOptimizeResults(null);

    try {
      const freshBundle = readTimeSeriesFromSession();
      if (!freshBundle?.data) {
        setError('No time-series data available. Run a time-series analysis first.');
        setIsLoading(false);
        return;
      }
      setTimeSeriesBundle(freshBundle);

      const request = buildFlightRequest(
        freshBundle.data,
        parseFloat(loxMass),
        parseFloat(fuelMass)
      );

      const result = await runFlightSimulation(request);

      if (result.error) {
        setError(result.error);
        setResults(null);
      } else if (result.data) {
        setResults(result.data);
        if (result.data.error) {
          setError(result.data.error);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Simulation failed');
      setResults(null);
    } finally {
      setIsLoading(false);
    }
  }, [buildFlightRequest, loxMass, fuelMass]);

  // Find minimum-fuel burn time for target apogee
  const handleOptimize = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setResults(null);

    try {
      const freshBundle = readTimeSeriesFromSession();
      if (!freshBundle?.data) {
        setError('No time-series data available. Run a time-series analysis first.');
        setIsLoading(false);
        return;
      }
      setTimeSeriesBundle(freshBundle);

      const baseRequest = buildFlightRequest(
        freshBundle.data,
        parseFloat(loxMass),
        parseFloat(fuelMass)
      );

      const result = await optimizeFlightAltitude({
        ...baseRequest,
        target_apogee_m: parseFloat(targetApogeeM),
        apogee_tolerance_m: parseFloat(apogeeToleranceM),
      });

      if (result.error) {
        setError(result.error);
        setOptimizeResults(null);
      } else if (result.data) {
        setOptimizeResults(result.data);
        if (result.data.success && result.data.flight) {
          setResults(result.data.flight);
          setLoxMass(result.data.optimal_lox_kg.toFixed(2));
          setFuelMass(result.data.optimal_fuel_kg.toFixed(2));
        }
        if (!result.data.success && result.data.infeasible_reason) {
          setError(result.data.infeasible_reason);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Optimization failed');
      setOptimizeResults(null);
    } finally {
      setIsLoading(false);
    }
  }, [buildFlightRequest, loxMass, fuelMass, targetApogeeM, apogeeToleranceM]);

  // Save config back to yaml
  const handleSaveConfig = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      // Build partial config tree
      const updates: Partial<EngineConfig> = {
        lox_tank: {
          ...(config?.lox_tank as Record<string, unknown> || {}),
          mass: parseFloat(loxMass),
        },
        fuel_tank: {
          ...(config?.fuel_tank as Record<string, unknown> || {}),
          mass: parseFloat(fuelMass),
        },
        environment: {
          ...(config?.environment as Record<string, unknown> || {}),
          latitude: parseFloat(latitude),
          longitude: parseFloat(longitude),
          elevation: parseFloat(elevation),
          date: [parseInt(launchYear), parseInt(launchMonth), parseInt(launchDay), parseInt(launchHour)],
        },
        rocket: {
          ...(config?.rocket as Record<string, unknown> || {}),
          airframe_mass: parseFloat(airframeMass),
          engine_mass: parseFloat(engineMass),
          lox_tank_structure_mass: parseFloat(loxTankMass),
          fuel_tank_structure_mass: parseFloat(fuelTankMass),
          radius: parseFloat(rocketRadius),
          rocket_length: parseFloat(rocketLength),
          motor_position: parseFloat(motorPosition),
          inertia: [parseFloat(inertiaX), parseFloat(inertiaY), parseFloat(inertiaZ)],
          fins: {
            no_fins: parseInt(finCount),
            root_chord: parseFloat(rootChord),
            tip_chord: parseFloat(tipChord),
            fin_span: parseFloat(finSpan),
            fin_position: parseFloat(finPosition),
          },
        },
      };

      const result = await updateConfig(updates);
      if (result.error) {
        setError(result.error);
      } else if (result.data?.config && onConfigUpdated) {
        onConfigUpdated(result.data.config);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config');
    } finally {
      setIsSaving(false);
    }
  }, [
    config, onConfigUpdated,
    loxMass, fuelMass,
    latitude, longitude, elevation, launchYear, launchMonth, launchDay, launchHour,
    airframeMass, engineMass, loxTankMass, fuelTankMass,
    rocketRadius, rocketLength, motorPosition,
    inertiaX, inertiaY, inertiaZ,
    finCount, rootChord, tipChord, finSpan, finPosition
  ]);


  // Chart data
  const trajectoryData = useMemo(() => {
    if (!results?.trajectory) return [];
    const { time, altitude, velocity } = results.trajectory;
    return time.map((t, i) => ({
      time: t,
      altitude: altitude[i],
      velocity: velocity[i],
    }));
  }, [results]);

  // Get truncation cutoff time from results (if truncated)
  const truncationCutoffTime = useMemo(() => {
    if (results?.truncation?.truncated && results.truncation.cutoff_time != null) {
      return results.truncation.cutoff_time;
    }
    return null;
  }, [results]);

  // Thrust curve chart data (from results or timeseries, respecting truncation)
  const thrustCurveData = useMemo(() => {
    // Get cutoff directly from results to avoid dependency timing issues
    const cutoff = (results?.truncation?.truncated && results?.truncation?.cutoff_time != null)
      ? results.truncation.cutoff_time
      : null;

    // Prefer thrust_curve from results if available
    if (results?.thrust_curve?.time && results.thrust_curve.thrust_N) {
      const { time, thrust_N } = results.thrust_curve;
      // Apply truncation filtering (backend returns full curve, not truncated)
      const data = time.map((t, i) => ({
        time: t,
        thrust_kN: thrust_N[i] / 1000, // Convert N to kN for display
      }));
      // Filter to truncation cutoff if applicable
      if (cutoff !== null) {
        return data.filter((point) => point.time <= cutoff);
      }
      return data;
    }
    // Fall back to time-series data, apply truncation if needed
    if (timeSeriesData?.time && timeSeriesData?.thrust_kN) {
      const data = timeSeriesData.time.map((t, i) => ({
        time: t,
        thrust_kN: timeSeriesData.thrust_kN[i],
      }));
      if (cutoff !== null) {
        return data.filter((point) => point.time <= cutoff);
      }
      return data;
    }
    return [];
  }, [results, timeSeriesData]);

  // Tank pressure chart data (from timeseries, respecting truncation)
  const tankPressureData = useMemo(() => {
    if (!timeSeriesData?.time || !timeSeriesData?.P_tank_O_psi || !timeSeriesData?.P_tank_F_psi) {
      return [];
    }
    // Get cutoff directly from results
    const cutoff = (results?.truncation?.truncated && results?.truncation?.cutoff_time != null)
      ? results.truncation.cutoff_time
      : null;

    const data = timeSeriesData.time.map((t, i) => ({
      time: t,
      lox_pressure: timeSeriesData.P_tank_O_psi[i],
      fuel_pressure: timeSeriesData.P_tank_F_psi[i],
    }));

    if (cutoff !== null) {
      return data.filter((point) => point.time <= cutoff);
    }
    return data;
  }, [timeSeriesData, results]);

  // Tank fill level data (calculated from mass flow integration)
  const tankFillData = useMemo(() => {
    if (!timeSeriesData?.time || !timeSeriesData?.mdot_O_kg_s || !timeSeriesData?.mdot_F_kg_s) {
      return [];
    }

    const initialLoxMass = parseFloat(loxMass) || 0;
    const initialFuelMass = parseFloat(fuelMass) || 0;

    if (initialLoxMass <= 0 || initialFuelMass <= 0) {
      return [];
    }

    // Get cutoff directly from results
    const cutoff = (results?.truncation?.truncated && results?.truncation?.cutoff_time != null)
      ? results.truncation.cutoff_time
      : null;

    const times = timeSeriesData.time;
    const mdotO = timeSeriesData.mdot_O_kg_s;
    const mdotF = timeSeriesData.mdot_F_kg_s;

    // Calculate cumulative mass consumed using trapezoidal integration
    const data: { time: number; lox_fill: number; fuel_fill: number; lox_mass: number; fuel_mass: number }[] = [];
    let cumulativeLoxMass = 0;
    let cumulativeFuelMass = 0;

    for (let i = 0; i < times.length; i++) {
      // Apply cutoff filter early
      if (cutoff !== null && times[i] > cutoff) {
        break;
      }

      if (i > 0) {
        const dt = times[i] - times[i - 1];
        // Trapezoidal integration: average of mdot at i-1 and i, times dt
        cumulativeLoxMass += ((mdotO[i - 1] + mdotO[i]) / 2) * dt;
        cumulativeFuelMass += ((mdotF[i - 1] + mdotF[i]) / 2) * dt;
      }

      const remainingLox = Math.max(0, initialLoxMass - cumulativeLoxMass);
      const remainingFuel = Math.max(0, initialFuelMass - cumulativeFuelMass);

      data.push({
        time: times[i],
        lox_fill: (remainingLox / initialLoxMass) * 100,
        fuel_fill: (remainingFuel / initialFuelMass) * 100,
        lox_mass: remainingLox,
        fuel_mass: remainingFuel,
      });
    }

    return data;
  }, [timeSeriesData, results, loxMass, fuelMass]);

  // No config loaded
  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <p>No config loaded</p>
          <p className="text-sm mt-1">Upload a YAML config file first</p>
        </div>
      </div>
    );
  }

  // RocketPy not available
  if (rocketPyAvailable === false) {
    return (
      <div className="p-6 rounded-xl bg-red-500/10 border border-red-500/30">
        <div className="flex items-start gap-4">
          <svg className="w-8 h-8 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
            />
          </svg>
          <div>
            <h3 className="text-lg font-semibold text-red-400">RocketPy Not Available</h3>
            <p className="text-[var(--color-text-secondary)] mt-1">{rocketPyMessage}</p>
            <code className="block mt-3 px-3 py-2 bg-[var(--color-bg-primary)] rounded text-sm text-[var(--color-text-muted)]">
              pip install rocketpy
            </code>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Flight Simulation</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              RocketPy-based trajectory simulation
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mb-4">
          <button
            onClick={handleSaveConfig}
            disabled={isSaving || readOnly}
            className="px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-hover)] text-[var(--color-text-primary)] border border-[var(--color-border)] rounded-lg disabled:opacity-50 transition-colors flex items-center gap-2"
          >
            {isSaving ? (
              <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
              </svg>
            )}
            Save Configuration
          </button>
        </div>

        {/* Time-series data status */}
        {hasTimeSeriesData ? (
          <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30 mb-4">
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <div className="text-sm text-purple-400">
                <p>
                  Time-series loaded: {timeSeriesData!.time.length} points,{' '}
                  {(timeSeriesData!.time[timeSeriesData!.time.length - 1] - timeSeriesData!.time[0]).toFixed(2)}s burn
                  {timeSeriesSummary?.total_impulse_kNs != null && (
                    <span>, {timeSeriesSummary.total_impulse_kNs.toFixed(1)} kN·s impulse</span>
                  )}
                </p>
                {(timeSeriesSummary?.lox_propellant_kg != null || timeSeriesSummary?.fuel_propellant_kg != null) && (
                  <p className="text-xs text-purple-300/80 mt-1">
                    Full burn needs ~{timeSeriesSummary?.lox_propellant_kg?.toFixed(2) ?? '?'} kg LOX, ~
                    {timeSeriesSummary?.fuel_propellant_kg?.toFixed(2) ?? '?'} kg fuel (∫mdot dt)
                  </p>
                )}
                {timeSeriesTimestamp != null && (
                  <p className="text-xs text-[var(--color-text-muted)] mt-0.5">
                    Updated {new Date(timeSeriesTimestamp).toLocaleTimeString()} - re-run time-series after changing burn profile
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/30 mb-4">
            <div className="flex items-start gap-3">
              <svg className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-yellow-400">No time-series data available</p>
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  Run a time-series analysis first to generate thrust and mass flow data for flight simulation.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Flight mode */}
        <div className="mb-4">
          <label className="block text-sm text-[var(--color-text-secondary)] mb-2">Flight sim mode</label>
          <div className="flex flex-wrap gap-2">
            <button
              disabled={readOnly}
              type="button"
              onClick={() => setFlightMode('manual')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                flightMode === 'manual'
                  ? 'bg-blue-600 text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              Manual iteration
            </button>
            <button
              disabled={readOnly}
              type="button"
              onClick={() => setFlightMode('optimize')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                flightMode === 'optimize'
                  ? 'bg-purple-600 text-white'
                  : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]'
              }`}
            >
              Optimize for altitude
            </button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mt-2">
            {flightMode === 'manual'
              ? 'Adjust LOX/fuel sliders and run flight sim. Use diagnostics to iterate toward a target apogee.'
              : 'Finds the shortest burn time (minimum fuel) on the loaded time-series curve that reaches your target apogee.'}
          </p>
        </div>

        {flightMode === 'optimize' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4 p-4 rounded-lg bg-purple-500/10 border border-purple-500/30">
            <InputField
              label="Target Apogee"
              value={targetApogeeM}
              onChange={setTargetApogeeM}
              unit="m"
              min={100}
              step={10}
              help={`${(parseFloat(targetApogeeM || '0') * 3.28084).toFixed(0)} ft - from design requirements by default`}
            />
            <InputField
              label="Apogee tolerance"
              value={apogeeToleranceM}
              onChange={setApogeeToleranceM}
              unit="m"
              min={0}
              step={5}
              help="Allowed undershoot below target (optimization accepts apogee ≥ target − tolerance)"
            />
          </div>
        )}

        {/* Propellant configuration */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <InputField
            label="Initial LOX Mass"
            value={loxMass}
            onChange={setLoxMass}
            unit="kg"
            min={0.1}
            step={0.1}
            disabled={flightMode === 'optimize'}
            help={
              flightMode === 'optimize'
                ? 'Set automatically after optimization (exact ∫mdot dt for optimal burn time)'
                : timeSeriesSummary?.lox_propellant_kg != null
                  ? `Full burn needs ~${timeSeriesSummary.lox_propellant_kg.toFixed(2)} kg (∫mdot dt)`
                  : 'Propellant only (not tank structure)'
            }
          />
          <InputField
            label="Initial Fuel Mass"
            value={fuelMass}
            onChange={setFuelMass}
            unit="kg"
            min={0.1}
            step={0.1}
            disabled={flightMode === 'optimize'}
            help={
              flightMode === 'optimize'
                ? 'Minimized by optimizer - shortest burn that hits target apogee'
                : timeSeriesSummary?.fuel_propellant_kg != null
                  ? `Full burn needs ~${timeSeriesSummary.fuel_propellant_kg.toFixed(2)} kg (∫mdot dt)`
                  : 'Propellant only (not tank structure)'
            }
          />
        </div>
      </div>

      {/* Configuration sections */}
      <div className="space-y-3">
        {/* Environment */}
        <CollapsibleSection
          title="Environment"
          icon={
            <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <InputField
              label="Latitude"
              value={latitude}
              onChange={setLatitude}
              unit="°"
              min={-90}
              max={90}
              step={0.1}
            />
            <InputField
              label="Longitude"
              value={longitude}
              onChange={setLongitude}
              unit="°"
              min={-180}
              max={180}
              step={0.1}
            />
            <InputField
              label="Elevation"
              value={elevation}
              onChange={setElevation}
              unit="m"
              min={-500}
              max={10000}
              step={1}
            />
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Launch Date</label>
              <div className="flex gap-1">
                <input
                  disabled={readOnly}
                  type="number"
                  value={launchYear}
                  onChange={(e) => setLaunchYear(e.target.value)}
                  placeholder="Year"
                  className="w-20 px-2 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm"
                />
                <input
                  disabled={readOnly}
                  type="number"
                  value={launchMonth}
                  onChange={(e) => setLaunchMonth(e.target.value)}
                  min={1}
                  max={12}
                  placeholder="M"
                  className="w-12 px-2 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm"
                />
                <input
                  disabled={readOnly}
                  type="number"
                  value={launchDay}
                  onChange={(e) => setLaunchDay(e.target.value)}
                  min={1}
                  max={31}
                  placeholder="D"
                  className="w-12 px-2 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm"
                />
                <input
                  disabled={readOnly}
                  type="number"
                  value={launchHour}
                  onChange={(e) => setLaunchHour(e.target.value)}
                  min={0}
                  max={23}
                  placeholder="H"
                  className="w-12 px-2 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-1">Atmosphere model</label>
              <select
                disabled={readOnly}
                value={atmosphereModel}
                onChange={(e) => setAtmosphereModel(e.target.value as 'standard_atmosphere' | 'forecast')}
                className="w-full px-2 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-sm"
              >
                <option value="standard_atmosphere">Standard atmosphere (ISA - offline, deterministic)</option>
                <option value="forecast">Live GFS forecast (needs internet & a near date)</option>
              </select>
              {atmosphereModel === 'forecast' && (
                <p className="text-xs text-amber-500 mt-1">
                  Forecast fetches real weather for the launch date/location; use a near-future date. Falls back to ISA if unavailable.
                </p>
              )}
            </div>
          </div>
        </CollapsibleSection>

        {/* Rocket */}
        <CollapsibleSection
          title="Rocket Configuration"
          icon={
            <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
              />
            </svg>
          }
        >
          <div className="space-y-4">
            {/* Mass breakdown */}
            <div>
              <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Dry Masses</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <InputField
                  label="Airframe"
                  value={airframeMass}
                  onChange={setAirframeMass}
                  unit="kg"
                  min={1}
                  step={0.1}
                  help="Body, fins, avionics"
                />
                <InputField
                  label="Engine + Plumbing"
                  value={engineMass}
                  onChange={setEngineMass}
                  unit="kg"
                  min={0.1}
                  step={0.1}
                />
                <InputField
                  label="LOX Tank"
                  value={loxTankMass}
                  onChange={setLoxTankMass}
                  unit="kg"
                  min={0.1}
                  step={0.1}
                  help="Empty tank structure"
                />
                <InputField
                  label="Fuel Tank"
                  value={fuelTankMass}
                  onChange={setFuelTankMass}
                  unit="kg"
                  min={0.1}
                  step={0.1}
                  help="Empty tank structure"
                />
              </div>
              <p className="text-xs text-[var(--color-text-muted)] mt-2">
                Propulsion dry: <span className="font-medium">{propulsionDryMass.toFixed(2)} kg</span> | Total dry:{' '}
                <span className="font-medium">{totalDryMass.toFixed(2)} kg</span>
              </p>
            </div>

            {/* Geometry */}
            <div>
              <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Geometry</h4>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <InputField
                  label="Rocket Radius"
                  value={rocketRadius}
                  onChange={setRocketRadius}
                  unit="m"
                  min={0.01}
                  step={0.001}
                />
                <InputField
                  label="Rocket Length"
                  value={rocketLength}
                  onChange={setRocketLength}
                  unit="m"
                  min={0.1}
                  step={0.1}
                />
                <InputField
                  label="Motor Position"
                  value={motorPosition}
                  onChange={setMotorPosition}
                  unit="m"
                  min={0}
                  step={0.1}
                  help="From tail to nozzle"
                />
                <InputField
                  label="Nose Fineness"
                  value={noseFineness}
                  onChange={setNoseFineness}
                  unit=":1"
                  min={1}
                  step={0.1}
                  help={`von Kármán nose length ÷ diameter. ~4.5:1 ≈ ${(parseFloat(noseFineness || '4.5') * 2 * parseFloat(rocketRadius || '0.1015')).toFixed(2)} m nose`}
                />
                <InputField
                  label="Avionics/Payload Length"
                  value={avionicsLength}
                  onChange={setAvionicsLength}
                  unit="m"
                  min={0}
                  step={0.1}
                  help="Section above propulsion, below the nose"
                />
              </div>
            </div>

            {/* Inertia */}
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h4 className="text-sm font-medium text-[var(--color-text-primary)]">Inertia (Airframe Only)</h4>
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input
                    disabled={readOnly}
                    type="checkbox"
                    checked={autoInertia}
                    onChange={(e) => setAutoInertia(e.target.checked)}
                    className="rounded"
                  />
                  Auto-estimate
                </label>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <InputField
                  label="Ixx"
                  value={inertiaX}
                  onChange={setInertiaX}
                  unit="kg·m²"
                  min={0.01}
                  step={0.01}
                  disabled={autoInertia}
                />
                <InputField
                  label="Iyy"
                  value={inertiaY}
                  onChange={setInertiaY}
                  unit="kg·m²"
                  min={0.01}
                  step={0.01}
                  disabled={autoInertia}
                />
                <InputField
                  label="Izz"
                  value={inertiaZ}
                  onChange={setInertiaZ}
                  unit="kg·m²"
                  min={0.001}
                  step={0.001}
                  disabled={autoInertia}
                />
              </div>
            </div>

            {/* Fins */}
            <div>
              <h4 className="text-sm font-medium text-[var(--color-text-primary)] mb-2">Fins</h4>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <InputField
                  label="Count"
                  value={finCount}
                  onChange={setFinCount}
                  unit=""
                  min={1}
                  max={8}
                  step={1}
                />
                <InputField
                  label="Root Chord"
                  value={rootChord}
                  onChange={setRootChord}
                  unit="m"
                  min={0.01}
                  step={0.01}
                />
                <InputField
                  label="Tip Chord"
                  value={tipChord}
                  onChange={setTipChord}
                  unit="m"
                  min={0.01}
                  step={0.01}
                />
                <InputField
                  label="Span"
                  value={finSpan}
                  onChange={setFinSpan}
                  unit="m"
                  min={0.01}
                  step={0.01}
                />
                <InputField
                  label="Position"
                  value={finPosition}
                  onChange={setFinPosition}
                  unit="m"
                  min={0}
                  step={0.01}
                  help="From tail"
                />
              </div>
            </div>
          </div>
        </CollapsibleSection>
      </div>

      {/* Simulate / Optimize button */}
      <button
        onClick={flightMode === 'optimize' ? handleOptimize : handleSimulate}
        disabled={isLoading || rocketPyAvailable === null || !hasTimeSeriesData}
        className={`w-full md:w-auto px-8 py-3 rounded-lg text-white font-semibold transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
          flightMode === 'optimize'
            ? 'bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700'
            : 'bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700'
        }`}
      >
        {isLoading ? (
          <>
            <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            {flightMode === 'optimize' ? 'Optimizing burn time & propellant...' : 'Running Simulation...'}
          </>
        ) : flightMode === 'optimize' ? (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            Optimize Burn Time & Fuel
          </>
        ) : (
          <>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13 10V3L4 14h7v7l9-11h-7z"
              />
            </svg>
            Run Flight Simulation
          </>
        )}
      </button>

      {/* Optimization summary */}
      {optimizeResults && flightMode === 'optimize' && (
        <div
          className={`p-4 rounded-xl border ${
            optimizeResults.success
              ? 'bg-purple-500/10 border-purple-500/30'
              : 'bg-yellow-500/10 border-yellow-500/30'
          }`}
        >
          <p className="font-medium text-[var(--color-text-primary)] mb-3">
            {optimizeResults.success ? 'Minimum-fuel solution' : 'Optimization infeasible'}
          </p>
          {optimizeResults.success ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <p className="text-[var(--color-text-secondary)]">Optimal burn time</p>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  {optimizeResults.optimal_burn_time_s.toFixed(2)} s
                </p>
              </div>
              <div>
                <p className="text-[var(--color-text-secondary)]">Fuel required</p>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  {optimizeResults.optimal_fuel_kg.toFixed(2)} kg
                </p>
              </div>
              <div>
                <p className="text-[var(--color-text-secondary)]">LOX required</p>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  {optimizeResults.optimal_lox_kg.toFixed(2)} kg
                </p>
              </div>
              <div>
                <p className="text-[var(--color-text-secondary)]">Achieved apogee</p>
                <p className="font-semibold text-[var(--color-text-primary)]">
                  {optimizeResults.achieved_apogee_m.toFixed(0)} m (
                  {(optimizeResults.achieved_apogee_m * 3.28084).toFixed(0)} ft)
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-yellow-400">{optimizeResults.infeasible_reason}</p>
          )}
          <p className="text-xs text-[var(--color-text-muted)] mt-3">
            Ran {optimizeResults.simulations_run} flight simulations. Switch to manual mode to tweak propellant or
            re-run time-series with a different burn profile, then optimize again.
          </p>
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400">
          <div className="flex items-start gap-3">
            <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
            <div>
              <p className="font-medium">Simulation Error</p>
              <p className="text-sm mt-1">{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* Results */}
      {results && results.status === 'success' && (
        <div className="space-y-6">
          {/* Key metrics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              label="Apogee (AGL)"
              value={results.apogee_m.toFixed(1)}
              unit="m"
              subValue={`${results.apogee_ft.toFixed(0)} ft`}
              color="blue"
            />
            <MetricCard
              label="Max Velocity"
              value={results.max_velocity_m_s.toFixed(1)}
              unit="m/s"
              subValue={`Mach ${(results.max_velocity_m_s / 343).toFixed(2)}`}
              color="green"
            />
            <MetricCard
              label="Flight Time"
              value={results.flight_time_s.toFixed(1)}
              unit="s"
              color="purple"
            />
            <MetricCard
              label="Total Dry Mass"
              value={totalDryMass.toFixed(1)}
              unit="kg"
              subValue={`+ ${(parseFloat(loxMass) + parseFloat(fuelMass)).toFixed(1)} kg propellant`}
              color="orange"
            />
          </div>

          {/* Propellant diagnostics */}
          {results.propellant && (
            <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">Propellant Diagnostics</h3>
                <span
                  className={`text-xs px-2 py-1 rounded-full font-medium ${
                    results.propellant.regime === 'full_burn'
                      ? 'bg-green-500/20 text-green-400'
                      : results.propellant.regime === 'excess_propellant'
                        ? 'bg-orange-500/20 text-orange-400'
                        : 'bg-yellow-500/20 text-yellow-400'
                  }`}
                >
                  {results.propellant.regime.replace(/_/g, ' ')}
                </span>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <div>
                  <p className="text-[var(--color-text-muted)]">Effective burn</p>
                  <p className="font-mono text-[var(--color-text-primary)]">
                    {results.propellant.effective_burn_time_s.toFixed(2)}s /{' '}
                    {results.propellant.timeseries_burn_time_s.toFixed(2)}s
                  </p>
                </div>
                <div>
                  <p className="text-[var(--color-text-muted)]">Impulse delivered</p>
                  <p className="font-mono text-[var(--color-text-primary)]">
                    {(results.propellant.total_impulse_Ns / 1000).toFixed(1)} kN·s
                  </p>
                </div>
                <div>
                  <p className="text-[var(--color-text-muted)]">LOX loaded / required</p>
                  <p className="font-mono text-[var(--color-text-primary)]">
                    {results.propellant.lox_effective_kg.toFixed(2)} / {results.propellant.lox_required_kg.toFixed(2)} kg
                  </p>
                </div>
                <div>
                  <p className="text-[var(--color-text-muted)]">Fuel loaded / required</p>
                  <p className="font-mono text-[var(--color-text-primary)]">
                    {results.propellant.fuel_effective_kg.toFixed(2)} / {results.propellant.fuel_required_kg.toFixed(2)} kg
                  </p>
                </div>
              </div>
              {(results.propellant.lox_tank_max_kg != null || results.propellant.fuel_tank_max_kg != null) && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Tank load limits
                  {results.propellant.propellant_tank_fill_factor != null && (
                    <span> ({(results.propellant.propellant_tank_fill_factor * 100).toFixed(0)}% fill from config)</span>
                  )}
                  : LOX max {results.propellant.lox_tank_max_kg?.toFixed(2) ?? '—'} kg, fuel max{' '}
                  {results.propellant.fuel_tank_max_kg?.toFixed(2) ?? '—'} kg. Override via{' '}
                  <code className="text-[var(--color-text-secondary)]">design_requirements.propellant_tank_fill_factor</code>,{' '}
                  <code className="text-[var(--color-text-secondary)]">fuel_tank_capacity_kg</code>, or tank geometry /
                  <code className="text-[var(--color-text-secondary)]"> tank_volume_m3</code>.
                </p>
              )}
              {results.propellant.target_apogee_m != null && (
                <p className="text-xs text-[var(--color-text-muted)]">
                  Design target apogee: {results.propellant.target_apogee_m.toFixed(0)} m (
                  {(results.propellant.target_apogee_m * 3.28084).toFixed(0)} ft) - actual{' '}
                  {results.apogee_m.toFixed(0)} m ({results.apogee_ft.toFixed(0)} ft)
                </p>
              )}
              {results.propellant.regime === 'truncated' && (
                <p className="text-xs text-yellow-400">
                  Increase propellant (up to required amounts) to extend burn and raise apogee.
                </p>
              )}
              {results.propellant.regime === 'excess_propellant' && (
                <p className="text-xs text-orange-400">
                  Loaded propellant exceeds burn requirement - trim toward required values to reduce dead weight.
                </p>
              )}
              {results.propellant.warnings.length > 0 && (
                <ul className="text-xs text-red-400 space-y-1 list-disc list-inside">
                  {results.propellant.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Truncation warning */}
          {results.truncation?.truncated && (
            <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
              <div className="flex items-center gap-2 text-yellow-400">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <span className="text-sm">
                  Burn truncated at {results.truncation.cutoff_time?.toFixed(3)}s
                  {results.truncation.reason && ` - ${results.truncation.reason}`}
                </span>
              </div>
            </div>
          )}

          {/* Trajectory charts */}
          {trajectoryData.length > 0 && (
            <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Flight Trajectory</h3>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Altitude vs Time */}
                <div>
                  <h4 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">Altitude vs Time</h4>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trajectoryData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                        <XAxis
                          dataKey="time"
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                          tickFormatter={(value) => Math.round(value).toString()}
                          label={{ value: 'Time (s)', position: 'bottom', fill: 'var(--color-text-secondary)' }}
                        />
                        <YAxis
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                          tickFormatter={(value) => Math.round(value).toString()}
                          label={{
                            value: 'Altitude (m)',
                            angle: -90,
                            position: 'insideLeft',
                            fill: 'var(--color-text-secondary)',
                          }}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-bg-secondary)',
                            border: '1px solid var(--color-border)',
                            borderRadius: '8px',
                          }}
                          labelStyle={{ color: 'var(--color-text-primary)' }}
                          formatter={(value: number) => [value.toFixed(1), 'Altitude (m)']}
                          labelFormatter={(label) => `Time: ${Number(label).toFixed(1)}s`}
                        />
                        <ReferenceLine y={results.apogee_m} stroke="#3b82f6" strokeDasharray="5 5" />
                        <Line
                          type="monotone"
                          dataKey="altitude"
                          stroke="#3b82f6"
                          strokeWidth={2}
                          dot={false}
                          name="Altitude"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                {/* Velocity vs Time */}
                <div>
                  <h4 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">Velocity vs Time</h4>
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={trajectoryData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                        <XAxis
                          dataKey="time"
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                          tickFormatter={(value) => Math.round(value).toString()}
                          label={{ value: 'Time (s)', position: 'bottom', fill: 'var(--color-text-secondary)' }}
                        />
                        <YAxis
                          stroke="var(--color-text-secondary)"
                          tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                          tickFormatter={(value) => Math.round(value).toString()}
                          label={{
                            value: 'Velocity (m/s)',
                            angle: -90,
                            position: 'insideLeft',
                            fill: 'var(--color-text-secondary)',
                          }}
                        />
                        <Tooltip
                          contentStyle={{
                            backgroundColor: 'var(--color-bg-secondary)',
                            border: '1px solid var(--color-border)',
                            borderRadius: '8px',
                          }}
                          labelStyle={{ color: 'var(--color-text-primary)' }}
                          formatter={(value: number) => [value.toFixed(1), 'Velocity (m/s)']}
                          labelFormatter={(label) => `Time: ${Number(label).toFixed(1)}s`}
                        />
                        <ReferenceLine y={0} stroke="var(--color-border)" />
                        <Line
                          type="monotone"
                          dataKey="velocity"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={false}
                          name="Velocity"
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Engine Performance Charts */}
          {(thrustCurveData.length > 0 || tankPressureData.length > 0 || tankFillData.length > 0) && (
            <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">Engine Performance</h3>
                {truncationCutoffTime && (
                  <span className="text-sm text-yellow-400 bg-yellow-500/10 px-2 py-1 rounded">
                    Truncated at {truncationCutoffTime.toFixed(3)}s
                    {results?.truncation?.reason && ` - ${results.truncation.reason}`}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Thrust Curve */}
                {thrustCurveData.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                      Thrust Curve {truncationCutoffTime && '(Truncated)'}
                    </h4>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={thrustCurveData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                          <XAxis
                            dataKey="time"
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            tickFormatter={(value) => value.toFixed(1)}
                            label={{ value: 'Time (s)', position: 'bottom', fill: 'var(--color-text-secondary)' }}
                          />
                          <YAxis
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            tickFormatter={(value) => value.toFixed(1)}
                            label={{
                              value: 'Thrust (kN)',
                              angle: -90,
                              position: 'insideLeft',
                              fill: 'var(--color-text-secondary)',
                            }}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: 'var(--color-bg-secondary)',
                              border: '1px solid var(--color-border)',
                              borderRadius: '8px',
                            }}
                            labelStyle={{ color: 'var(--color-text-primary)' }}
                            formatter={(value: number) => [value.toFixed(3), 'Thrust (kN)']}
                            labelFormatter={(label) => `Time: ${Number(label).toFixed(3)}s`}
                          />
                          <Line
                            type="monotone"
                            dataKey="thrust_kN"
                            stroke="#f97316"
                            strokeWidth={2}
                            dot={false}
                            name="Thrust"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Tank Pressure */}
                {tankPressureData.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                      Tank Pressures {truncationCutoffTime && '(Truncated)'}
                    </h4>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={tankPressureData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                          <XAxis
                            dataKey="time"
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            tickFormatter={(value) => value.toFixed(1)}
                            label={{ value: 'Time (s)', position: 'bottom', fill: 'var(--color-text-secondary)' }}
                          />
                          <YAxis
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            tickFormatter={(value) => Math.round(value).toString()}
                            label={{
                              value: 'Pressure (psi)',
                              angle: -90,
                              position: 'insideLeft',
                              fill: 'var(--color-text-secondary)',
                            }}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: 'var(--color-bg-secondary)',
                              border: '1px solid var(--color-border)',
                              borderRadius: '8px',
                            }}
                            labelStyle={{ color: 'var(--color-text-primary)' }}
                            formatter={(value: number, name: string) => [
                              value.toFixed(1),
                              name === 'lox_pressure' ? 'LOX Tank (psi)' : 'Fuel Tank (psi)',
                            ]}
                            labelFormatter={(label) => `Time: ${Number(label).toFixed(3)}s`}
                          />
                          <Legend
                            formatter={(value) => (value === 'lox_pressure' ? 'LOX Tank' : 'Fuel Tank')}
                          />
                          <Line
                            type="monotone"
                            dataKey="lox_pressure"
                            stroke="#06b6d4"
                            strokeWidth={2}
                            dot={false}
                            name="lox_pressure"
                          />
                          <Line
                            type="monotone"
                            dataKey="fuel_pressure"
                            stroke="#8b5cf6"
                            strokeWidth={2}
                            dot={false}
                            name="fuel_pressure"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}

                {/* Tank Fill Level */}
                {tankFillData.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-[var(--color-text-secondary)] mb-2">
                      Tank Fill Levels {truncationCutoffTime && '(Truncated)'}
                    </h4>
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={tankFillData}>
                          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                          <XAxis
                            dataKey="time"
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            tickFormatter={(value) => value.toFixed(1)}
                            label={{ value: 'Time (s)', position: 'bottom', fill: 'var(--color-text-secondary)' }}
                          />
                          <YAxis
                            stroke="var(--color-text-secondary)"
                            tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                            domain={[0, 100]}
                            tickFormatter={(value) => `${value}%`}
                            label={{
                              value: 'Fill Level (%)',
                              angle: -90,
                              position: 'insideLeft',
                              fill: 'var(--color-text-secondary)',
                            }}
                          />
                          <Tooltip
                            contentStyle={{
                              backgroundColor: 'var(--color-bg-secondary)',
                              border: '1px solid var(--color-border)',
                              borderRadius: '8px',
                            }}
                            labelStyle={{ color: 'var(--color-text-primary)' }}
                            formatter={(value: number, name: string, props) => {
                              const payload = props.payload;
                              if (name === 'lox_fill') {
                                return [`${value.toFixed(1)}% (${payload.lox_mass.toFixed(2)} kg)`, 'LOX Tank'];
                              }
                              return [`${value.toFixed(1)}% (${payload.fuel_mass.toFixed(2)} kg)`, 'Fuel Tank'];
                            }}
                            labelFormatter={(label) => `Time: ${Number(label).toFixed(3)}s`}
                          />
                          <Legend
                            formatter={(value) => (value === 'lox_fill' ? 'LOX Tank' : 'Fuel Tank')}
                          />
                          <ReferenceLine y={0} stroke="#ef4444" strokeDasharray="5 5" />
                          <Line
                            type="monotone"
                            dataKey="lox_fill"
                            stroke="#06b6d4"
                            strokeWidth={2}
                            dot={false}
                            name="lox_fill"
                          />
                          <Line
                            type="monotone"
                            dataKey="fuel_fill"
                            stroke="#8b5cf6"
                            strokeWidth={2}
                            dot={false}
                            name="fuel_fill"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Rocket Diagram */}
          {results.rocket_diagram && (
            <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
              <h3 className="text-lg font-semibold text-[var(--color-text-primary)] mb-4">Rocket Diagram</h3>
              <div className="flex justify-center">
                <img
                  src={`data:image/png;base64,${results.rocket_diagram}`}
                  alt="Rocket diagram generated by RocketPy"
                  className="max-w-full h-auto rounded-lg"
                  style={{ maxHeight: '600px' }}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

