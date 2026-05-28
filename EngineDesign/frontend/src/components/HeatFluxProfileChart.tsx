import { useEffect, useMemo, useRef, useState } from 'react';
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
import type { TimeSeriesData, TimeSeriesSummary } from '../api/client';

interface HeatFluxProfileChartProps {
  data: TimeSeriesData;
  /** Used to cap playback at burnout (shutdown time or scheduled burn length). */
  summary?: TimeSeriesSummary;
}

interface ProfileDataPoint {
  position: number;
  [key: string]: number;
}

interface AblativeDataPoint {
  position: number;
  q_incident?: number;
  q_net?: number;
  q_conv?: number;
  q_rad?: number;
}

function formatValue(value: number | null | undefined, decimals: number = 2): string {
  if (value == null) return '—';
  return value.toFixed(decimals);
}

// Generate a color palette for time slices
function getTimeSliceColor(index: number, total: number): string {
  // Use a gradient from blue (early) to red (late)
  const hue = 240 - (index / Math.max(total - 1, 1)) * 180; // 240 (blue) to 60 (yellow-orange)
  return `hsl(${hue}, 70%, 50%)`;
}

/** Last index with a non-empty incident profile aligned to the axial grid (finite q at least once). */
function pickAblativeProfileTimeIndex(
  axialLen: number,
  incidentProfiles: number[][] | undefined,
  preferredIndices: number[],
  nTimes: number,
): number {
  const usable = (idx: number): boolean => {
    const prof = incidentProfiles?.[idx];
    if (!prof || prof.length === 0) return false;
    if (axialLen > 0 && prof.length !== axialLen) return false;
    return prof.some((q) => Number.isFinite(q));
  };

  for (let i = preferredIndices.length - 1; i >= 0; i--) {
    const idx = preferredIndices[i];
    if (usable(idx)) return idx;
  }
  for (let idx = nTimes - 1; idx >= 0; idx--) {
    if (usable(idx)) return idx;
  }
  if (preferredIndices.length > 0) return preferredIndices[preferredIndices.length - 1];
  return Math.max(0, nTimes - 1);
}

/** Simulation time (s) at end of burn: early shutdown, else scheduled burn, else last sample. */
function effectiveBurnOutTimeS(time: number[] | undefined, summary?: TimeSeriesSummary): number {
  if (!time?.length) return 0;
  const tLast = time[time.length - 1];
  const tFirst = time[0];
  const shutdown = summary?.shutdown_event?.time_s;
  if (shutdown != null && Number.isFinite(shutdown)) {
    return Math.min(Math.max(shutdown, tFirst), tLast);
  }
  const scheduled = summary?.burn_time_s;
  if (scheduled != null && Number.isFinite(scheduled)) {
    return Math.min(Math.max(scheduled, tFirst), tLast);
  }
  return tLast;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Bracket sim time t for linear interpolation between stored time samples. */
function timeToInterpParams(t: number, timeArr: number[]): { i0: number; i1: number; frac: number } {
  const n = timeArr.length;
  if (n === 0) return { i0: 0, i1: 0, frac: 0 };
  if (n === 1) return { i0: 0, i1: 0, frac: 0 };
  if (t <= timeArr[0]) return { i0: 0, i1: 0, frac: 0 };
  if (t >= timeArr[n - 1]) return { i0: n - 1, i1: n - 1, frac: 0 };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timeArr[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = timeArr[lo];
  const t1 = timeArr[lo + 1];
  const frac = (t - t0) / (t1 - t0);
  return { i0: lo, i1: lo + 1, frac };
}

function lerpProfileMW(
  pa: number[] | undefined,
  pb: number[] | undefined,
  posIdx: number,
  frac: number,
): number | undefined {
  const a = pa?.[posIdx];
  const b = pb?.[posIdx];
  const fa = a !== undefined && Number.isFinite(a);
  const fb = b !== undefined && Number.isFinite(b);
  if (!fa && !fb) return undefined;
  if (!fa) return fb !== undefined ? b! / 1e6 : undefined;
  if (!fb) return a! / 1e6;
  return lerp(a!, b!, frac) / 1e6;
}

/**
 * Y extent in MW/m² for fixed axis while scrubbing.
 * Uses a high percentile for the top of scale so a single bogus spike (bad timestep, rad T⁴ blow-up,
 * etc. in W/m²) does not stretch the axis to billions while the rest of the burn is ~10² MW/m².
 */
function ablativeFluxYExtentMW(
  tBurnoutS: number,
  timeArr: number[],
  incidentProfiles?: number[][],
  netProfiles?: number[][],
  convProfiles?: number[][],
  radProfiles?: number[][],
): [number, number] {
  const samplesMw: number[] = [];
  const scanProfile = (p: number[] | undefined) => {
    if (!p) return;
    for (const w of p) {
      if (!Number.isFinite(w)) continue;
      samplesMw.push(w / 1e6);
    }
  };
  for (let i = 0; i < timeArr.length; i++) {
    if (timeArr[i] > tBurnoutS + 1e-12) break;
    scanProfile(incidentProfiles?.[i]);
    scanProfile(netProfiles?.[i]);
    scanProfile(convProfiles?.[i]);
    scanProfile(radProfiles?.[i]);
  }
  if (samplesMw.length === 0) return [0, 1];
  const sorted = [...samplesMw].sort((a, b) => a - b);
  const minMw = sorted[0];
  // 99.9th percentile index: drop the worst ~0.1% of samples (spikes). n < 5: use true max.
  const hiIdx =
    sorted.length < 5
      ? sorted.length - 1
      : Math.min(sorted.length - 1, Math.floor(0.999 * (sorted.length - 1)));
  const maxMw = sorted[hiIdx];
  if (!Number.isFinite(maxMw)) return [0, 1];
  const ymax = maxMw > 0 ? maxMw * 1.1 : 1;
  const ymin = Number.isFinite(minMw) ? Math.min(0, minMw) : 0;
  return [ymin, ymax];
}

/** 50% of real time: 0.5 s simulation per 1 s wall clock. */
const ABLATIVE_PLAYBACK_SIM_PER_WALL_S = 0.5;

export function HeatFluxProfileChart({ data, summary }: HeatFluxProfileChartProps) {
  const [selectedTimeIndices, setSelectedTimeIndices] = useState<number[]>([]);
  const [ablativeSimTime, setAblativeSimTime] = useState(0);
  const [ablativePlaying, setAblativePlaying] = useState(false);
  const ablativeRafRef = useRef<number>(0);
  const ablativeLastWallRef = useRef<number | null>(null);

  // Extract heat flux profile data (regen cooling)
  const {
    axial_positions_m,
    heat_flux_profiles_w_m2,
    wall_temp_profiles_k,
    time,
    // Ablative cooling profiles
    ablative_axial_positions_m,
    ablative_q_incident_profiles_w_m2,
    ablative_q_conv_profiles_w_m2,
    ablative_q_rad_profiles_w_m2,
    ablative_q_net_profiles_w_m2,
  } = data;

  // Check if we have regen heat flux profile data
  const hasRegenHeatFluxData = useMemo(() => {
    return (
      axial_positions_m &&
      axial_positions_m.length > 0 &&
      heat_flux_profiles_w_m2 &&
      heat_flux_profiles_w_m2.length > 0 &&
      heat_flux_profiles_w_m2.some(profile => profile && profile.length > 0)
    );
  }, [axial_positions_m, heat_flux_profiles_w_m2]);

  // Check if we have ablative heat flux profile data
  const hasAblativeHeatFluxData = useMemo(() => {
    return (
      ablative_axial_positions_m &&
      ablative_axial_positions_m.length > 0 &&
      ablative_q_incident_profiles_w_m2 &&
      ablative_q_incident_profiles_w_m2.length > 0 &&
      ablative_q_incident_profiles_w_m2.some(profile => profile && profile.length > 0)
    );
  }, [ablative_axial_positions_m, ablative_q_incident_profiles_w_m2]);

  // Use regen if available, otherwise ablative
  const hasHeatFluxData = hasRegenHeatFluxData || hasAblativeHeatFluxData;

  // Calculate default time indices (evenly spaced, max 5)
  const defaultTimeIndices = useMemo(() => {
    if (!time || time.length === 0) return [];
    const numSlices = Math.min(5, time.length);
    const indices: number[] = [];
    for (let i = 0; i < numSlices; i++) {
      indices.push(Math.floor((i / (numSlices - 1 || 1)) * (time.length - 1)));
    }
    return indices;
  }, [time]);

  // Use selected indices or default
  const activeIndices = selectedTimeIndices.length > 0 ? selectedTimeIndices : defaultTimeIndices;

  const nTimes = time?.length ?? 0;

  const tBurnoutS = useMemo(
    () => effectiveBurnOutTimeS(time, summary),
    [time, summary],
  );

  // Reset ablative sim time when a new time series is loaded (not when regen slice toggles change).
  const ablativeSeriesKey = useMemo(
    () => `${nTimes}:${ablative_q_incident_profiles_w_m2?.length ?? 0}`,
    [nTimes, ablative_q_incident_profiles_w_m2?.length],
  );

  useEffect(() => {
    if (!hasAblativeHeatFluxData || !ablative_axial_positions_m?.length || nTimes <= 0 || !time?.length) return;
    const idx = pickAblativeProfileTimeIndex(
      ablative_axial_positions_m.length,
      ablative_q_incident_profiles_w_m2,
      [],
      nTimes,
    );
    const tInit = Math.min(Math.max(time[idx] ?? 0, 0), tBurnoutS);
    setAblativeSimTime(tInit);
    setAblativePlaying(false);
  }, [ablativeSeriesKey, hasAblativeHeatFluxData, ablative_axial_positions_m, ablative_q_incident_profiles_w_m2, nTimes, time, tBurnoutS]);

  useEffect(() => {
    if (!ablativePlaying || tBurnoutS <= 0 || !time?.length) {
      ablativeLastWallRef.current = null;
      return;
    }
    const tick = (now: number) => {
      if (ablativeLastWallRef.current === null) ablativeLastWallRef.current = now;
      const dtWall = (now - ablativeLastWallRef.current) / 1000;
      ablativeLastWallRef.current = now;
      setAblativeSimTime((prev) => {
        let next = prev + ABLATIVE_PLAYBACK_SIM_PER_WALL_S * dtWall;
        if (next >= tBurnoutS) next = 0;
        return next;
      });
      ablativeRafRef.current = requestAnimationFrame(tick);
    };
    ablativeRafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(ablativeRafRef.current);
      ablativeLastWallRef.current = null;
    };
  }, [ablativePlaying, tBurnoutS]);

  // Transform data for recharts - regen heat flux profiles
  const heatFluxChartData: ProfileDataPoint[] = useMemo(() => {
    if (!hasRegenHeatFluxData || !axial_positions_m) return [];

    return axial_positions_m.map((pos, posIdx) => {
      const point: ProfileDataPoint = {
        position: pos * 1000, // Convert m to mm for display
      };

      activeIndices.forEach((timeIdx) => {
        const profile = heat_flux_profiles_w_m2?.[timeIdx];
        if (profile && profile[posIdx] !== undefined) {
          // Convert W/m² to MW/m² for better readability
          point[`t_${timeIdx}`] = profile[posIdx] / 1e6;
        }
      });

      return point;
    });
  }, [hasRegenHeatFluxData, axial_positions_m, heat_flux_profiles_w_m2, activeIndices]);

  // Transform data for recharts - ablative heat flux profiles (incident vs net)
  // Backend already outputs throat-centered coordinates: x=0 at throat, negative=chamber, positive=nozzle
  const ablativeChartData: AblativeDataPoint[] = useMemo(() => {
    if (!hasAblativeHeatFluxData || !ablative_axial_positions_m || !time?.length) return [];

    const simT = Math.min(Math.max(ablativeSimTime, 0), tBurnoutS);
    const { i0, i1, frac } = timeToInterpParams(simT, time);

    return ablative_axial_positions_m.map((pos, posIdx) => {
      const point: AblativeDataPoint = {
        // Backend already provides throat-centered coords, just convert m to mm
        position: pos * 1000,
      };

      const qI = lerpProfileMW(
        ablative_q_incident_profiles_w_m2?.[i0],
        ablative_q_incident_profiles_w_m2?.[i1],
        posIdx,
        frac,
      );
      const qN = lerpProfileMW(
        ablative_q_net_profiles_w_m2?.[i0],
        ablative_q_net_profiles_w_m2?.[i1],
        posIdx,
        frac,
      );
      const qC = lerpProfileMW(
        ablative_q_conv_profiles_w_m2?.[i0],
        ablative_q_conv_profiles_w_m2?.[i1],
        posIdx,
        frac,
      );
      const qR = lerpProfileMW(
        ablative_q_rad_profiles_w_m2?.[i0],
        ablative_q_rad_profiles_w_m2?.[i1],
        posIdx,
        frac,
      );
      if (qI !== undefined) point.q_incident = qI;
      if (qN !== undefined) point.q_net = qN;
      if (qC !== undefined) point.q_conv = qC;
      if (qR !== undefined) point.q_rad = qR;

      return point;
    });
  }, [
    hasAblativeHeatFluxData,
    ablative_axial_positions_m,
    ablative_q_incident_profiles_w_m2,
    ablative_q_net_profiles_w_m2,
    ablative_q_conv_profiles_w_m2,
    ablative_q_rad_profiles_w_m2,
    ablativeSimTime,
    tBurnoutS,
    time,
  ]);

  const ablativeYAxisDomain = useMemo((): [number, number] => {
    if (!hasAblativeHeatFluxData || !time?.length) return [0, 1];
    return ablativeFluxYExtentMW(
      tBurnoutS,
      time,
      ablative_q_incident_profiles_w_m2,
      ablative_q_net_profiles_w_m2,
      ablative_q_conv_profiles_w_m2,
      ablative_q_rad_profiles_w_m2,
    );
  }, [
    hasAblativeHeatFluxData,
    time,
    tBurnoutS,
    ablative_q_incident_profiles_w_m2,
    ablative_q_net_profiles_w_m2,
    ablative_q_conv_profiles_w_m2,
    ablative_q_rad_profiles_w_m2,
    ablativeSeriesKey,
  ]);

  // Throat position is now at x=0 (after coordinate transformation)
  const throatPositionMm = 0;

  // Transform data for recharts - wall temperature profiles
  const wallTempChartData: ProfileDataPoint[] = useMemo(() => {
    if (!axial_positions_m || !wall_temp_profiles_k) return [];

    return axial_positions_m.map((pos, posIdx) => {
      const point: ProfileDataPoint = {
        position: pos * 1000, // Convert m to mm for display
      };

      activeIndices.forEach((timeIdx) => {
        const profile = wall_temp_profiles_k?.[timeIdx];
        if (profile && profile[posIdx] !== undefined) {
          point[`t_${timeIdx}`] = profile[posIdx];
        }
      });

      return point;
    });
  }, [axial_positions_m, wall_temp_profiles_k, activeIndices]);

  const hasWallTempData = wallTempChartData.length > 0 && 
    wallTempChartData.some(p => Object.keys(p).length > 1);

  // Custom tooltip for heat flux
  const heatFluxTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
            x = {formatValue(label, 1)} mm
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, idx: number) => (
              <p key={idx} className="text-xs" style={{ color: entry.color }}>
                {entry.name}: {formatValue(entry.value, 3)} MW/m²
              </p>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  // Custom tooltip for wall temperature
  const wallTempTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
            x = {formatValue(label, 1)} mm
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, idx: number) => (
              <p key={idx} className="text-xs" style={{ color: entry.color }}>
                {entry.name}: {formatValue(entry.value, 0)} K
              </p>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  // Toggle time index selection
  const toggleTimeIndex = (idx: number) => {
    setSelectedTimeIndices(prev => {
      if (prev.includes(idx)) {
        return prev.filter(i => i !== idx);
      } else {
        return [...prev, idx].sort((a, b) => a - b);
      }
    });
  };

  // Custom tooltip for ablative heat flux
  const ablativeTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
            x = {formatValue(label, 1)} mm
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, idx: number) => (
              <p key={idx} className="text-xs" style={{ color: entry.color }}>
                {entry.name}: {formatValue(entry.value, 3)} MW/m²
              </p>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  if (!hasHeatFluxData) {
    // Show diagnostic message when no heat flux data is available
    return (
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-2">
          Heat Flux Profile
        </h4>
        <p className="text-xs text-[var(--color-text-secondary)]">
          No heat flux profile data available. This requires either:
        </p>
        <ul className="text-xs text-[var(--color-text-secondary)] list-disc ml-4 mt-1">
          <li>Regen cooling enabled with segment data</li>
          <li>Ablative cooling enabled (segment_x, segment_q_incident data)</li>
        </ul>
        <p className="text-xs text-[var(--color-text-tertiary)] mt-2">
          Debug: ablative_axial_positions_m = {ablative_axial_positions_m?.length ?? 'undefined'}, 
          ablative_q_incident_profiles = {ablative_q_incident_profiles_w_m2?.length ?? 'undefined'}
          {(ablative_q_incident_profiles_w_m2?.length ?? 0) > 0 && (
            <>, first profile length = {ablative_q_incident_profiles_w_m2?.[0]?.length ?? 'undefined'}</>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Regen Heat Flux vs Axial Position (if regen data available) */}
      {hasRegenHeatFluxData && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Regen Cooling: Heat Flux vs Axial Position
            </h4>
            <div className="text-xs text-[var(--color-text-secondary)]">
              {activeIndices.length} time slice{activeIndices.length !== 1 ? 's' : ''} shown
            </div>
          </div>

          {/* Time slice selector */}
          <div className="mb-4 flex flex-wrap gap-1">
            <span className="text-xs text-[var(--color-text-secondary)] mr-2 self-center">
              Time slices:
            </span>
            {defaultTimeIndices.map((idx) => (
              <button
                key={idx}
                onClick={() => toggleTimeIndex(idx)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  activeIndices.includes(idx)
                    ? 'bg-blue-500/20 text-blue-400 border border-blue-500/50'
                    : 'bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:border-blue-500/50'
                }`}
              >
                t={time?.[idx]?.toFixed(2)}s
              </button>
            ))}
            <button
              onClick={() => setSelectedTimeIndices([])}
              className="px-2 py-1 text-xs rounded bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] border border-[var(--color-border)] hover:border-blue-500/50 ml-2"
            >
              Reset
            </button>
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={heatFluxChartData} margin={{ top: 5, right: 30, left: 20, bottom: 25 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="position"
                type="number"
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ 
                  value: 'Axial Position (mm)', 
                  position: 'insideBottom', 
                  offset: -15, 
                  fill: 'var(--color-text-secondary)',
                  fontSize: 11
                }}
              />
              <YAxis
                stroke="#f97316"
                tick={{ fill: '#f97316', fontSize: 11 }}
                label={{ 
                  value: 'Heat Flux (MW/m²)', 
                  angle: -90, 
                  position: 'insideLeft', 
                  fill: '#f97316',
                  fontSize: 11
                }}
              />
              <Tooltip content={heatFluxTooltip} />
              <Legend 
                wrapperStyle={{ paddingTop: '10px' }}
                formatter={(value) => {
                  const match = value.match(/t_(\d+)/);
                  if (match && time) {
                    const idx = parseInt(match[1]);
                    return `t=${time[idx]?.toFixed(2)}s`;
                  }
                  return value;
                }}
              />
              {activeIndices.map((timeIdx, i) => (
                <Line
                  key={`t_${timeIdx}`}
                  type="monotone"
                  dataKey={`t_${timeIdx}`}
                  name={`t_${timeIdx}`}
                  stroke={getTimeSliceColor(i, activeIndices.length)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Wall Temperature vs Axial Position (regen) */}
      {hasWallTempData && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Regen Cooling: Wall Temperature vs Axial Position
          </h4>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={wallTempChartData} margin={{ top: 5, right: 30, left: 20, bottom: 25 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="position"
                type="number"
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ 
                  value: 'Axial Position (mm)', 
                  position: 'insideBottom', 
                  offset: -15, 
                  fill: 'var(--color-text-secondary)',
                  fontSize: 11
                }}
              />
              <YAxis
                stroke="#ef4444"
                tick={{ fill: '#ef4444', fontSize: 11 }}
                label={{ 
                  value: 'Wall Temperature (K)', 
                  angle: -90, 
                  position: 'insideLeft', 
                  fill: '#ef4444',
                  fontSize: 11
                }}
              />
              <Tooltip content={wallTempTooltip} />
              <Legend 
                wrapperStyle={{ paddingTop: '10px' }}
                formatter={(value) => {
                  const match = value.match(/t_(\d+)/);
                  if (match && time) {
                    const idx = parseInt(match[1]);
                    return `t=${time[idx]?.toFixed(2)}s`;
                  }
                  return value;
                }}
              />
              {activeIndices.map((timeIdx, i) => (
                <Line
                  key={`t_${timeIdx}`}
                  type="monotone"
                  dataKey={`t_${timeIdx}`}
                  name={`t_${timeIdx}`}
                  stroke={getTimeSliceColor(i, activeIndices.length)}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Ablative Heat Flux vs Axial Position (incident vs net) */}
      {hasAblativeHeatFluxData && ablativeChartData.length > 0 && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Ablative Cooling: Heat Flux vs Axial Position
            </h4>
            <div className="text-xs text-[var(--color-text-secondary)] tabular-nums text-right">
              t = {formatValue(Math.min(Math.max(ablativeSimTime, 0), tBurnoutS), 3)}s · 0–{formatValue(tBurnoutS, 2)}s
            </div>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mb-2">
            Incident heat flux (conv + rad) and net heat flux after blowing relief. 
            x = 0 at throat, negative towards injector (matches chamber geometry plot).
          </p>
          <p className="text-xs text-[var(--color-text-tertiary)] mb-4">
            50% real-time playback (0.5 s simulated per 1 s clock), looping 0–{formatValue(tBurnoutS, 2)} s burnout.
          </p>

          <div className="flex flex-wrap items-center gap-3 mb-4">
            <button
              type="button"
              aria-label={ablativePlaying ? 'Pause animation' : 'Play animation'}
              onClick={() => setAblativePlaying((p) => !p)}
              disabled={tBurnoutS <= 0 || nTimes <= 1}
              className="inline-flex items-center justify-center min-w-[2.5rem] h-9 px-3 rounded-lg text-xs font-medium border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] hover:border-blue-500/50 disabled:opacity-40 disabled:pointer-events-none transition-colors"
            >
              {ablativePlaying ? 'Pause' : 'Play'}
            </button>
            <div className="flex-1 min-w-[12rem] flex flex-col gap-1">
              <label htmlFor="ablative-time-slider" className="sr-only">
                Simulation time for ablative heat flux profile (0 to burnout)
              </label>
              <input
                id="ablative-time-slider"
                type="range"
                min={0}
                max={tBurnoutS}
                step="any"
                value={Math.min(Math.max(ablativeSimTime, 0), tBurnoutS)}
                onChange={(e) => {
                  setAblativePlaying(false);
                  setAblativeSimTime(Number(e.target.value));
                }}
                className="w-full h-2 rounded-full appearance-none cursor-pointer accent-blue-500 bg-[var(--color-bg-primary)] border border-[var(--color-border)]"
              />
            </div>
          </div>

          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={ablativeChartData} margin={{ top: 5, right: 30, left: 20, bottom: 25 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="position"
                type="number"
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ 
                  value: 'Axial Position (mm) — 0 = Throat, negative = Injector', 
                  position: 'insideBottom', 
                  offset: -15, 
                  fill: 'var(--color-text-secondary)',
                  fontSize: 10
                }}
              />
              <YAxis
                type="number"
                domain={ablativeYAxisDomain}
                allowDataOverflow
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ 
                  value: 'Heat Flux (MW/m²)', 
                  angle: -90, 
                  position: 'insideLeft', 
                  fill: 'var(--color-text-secondary)',
                  fontSize: 11
                }}
              />
              {/* Throat reference line */}
              {throatPositionMm !== null && (
                <ReferenceLine 
                  x={throatPositionMm} 
                  stroke="#ef4444" 
                  strokeDasharray="5 5" 
                  label={{ 
                    value: 'Throat', 
                    position: 'top', 
                    fill: '#ef4444',
                    fontSize: 10
                  }} 
                />
              )}
              <Tooltip content={ablativeTooltip} />
              <Legend wrapperStyle={{ paddingTop: '10px' }} />
              <Line
                type="monotone"
                dataKey="q_incident"
                name="Incident (conv+rad)"
                stroke="#f97316"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="q_net"
                name="Net (after relief)"
                stroke="#22c55e"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="q_conv"
                name="Convective"
                stroke="#3b82f6"
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="q_rad"
                name="Radiative"
                stroke="#a855f7"
                strokeWidth={1}
                strokeDasharray="3 3"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
