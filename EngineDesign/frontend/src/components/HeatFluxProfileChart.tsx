import React, { useMemo, useState } from 'react';
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
import type { TimeSeriesData } from '../api/client';

interface HeatFluxProfileChartProps {
  data: TimeSeriesData;
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

export function HeatFluxProfileChart({ data }: HeatFluxProfileChartProps) {
  const [selectedTimeIndices, setSelectedTimeIndices] = useState<number[]>([]);

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
    ablative_throat_index,
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
    if (!hasAblativeHeatFluxData || !ablative_axial_positions_m) return [];

    // Use the last time index by default (steady state), or selected index
    const timeIdx = activeIndices.length > 0 ? activeIndices[activeIndices.length - 1] : (time?.length ? time.length - 1 : 0);

    return ablative_axial_positions_m.map((pos, posIdx) => {
      const point: AblativeDataPoint = {
        // Backend already provides throat-centered coords, just convert m to mm
        position: pos * 1000,
      };

      const incidentProfile = ablative_q_incident_profiles_w_m2?.[timeIdx];
      const netProfile = ablative_q_net_profiles_w_m2?.[timeIdx];
      const convProfile = ablative_q_conv_profiles_w_m2?.[timeIdx];
      const radProfile = ablative_q_rad_profiles_w_m2?.[timeIdx];

      if (incidentProfile && incidentProfile[posIdx] !== undefined) {
        point.q_incident = incidentProfile[posIdx] / 1e6; // Convert to MW/m²
      }
      if (netProfile && netProfile[posIdx] !== undefined) {
        point.q_net = netProfile[posIdx] / 1e6;
      }
      if (convProfile && convProfile[posIdx] !== undefined) {
        point.q_conv = convProfile[posIdx] / 1e6;
      }
      if (radProfile && radProfile[posIdx] !== undefined) {
        point.q_rad = radProfile[posIdx] / 1e6;
      }

      return point;
    });
  }, [hasAblativeHeatFluxData, ablative_axial_positions_m, ablative_q_incident_profiles_w_m2, 
      ablative_q_net_profiles_w_m2, ablative_q_conv_profiles_w_m2, ablative_q_rad_profiles_w_m2, 
      activeIndices, time]);

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
          {ablative_q_incident_profiles_w_m2?.length > 0 && (
            <>, first profile length = {ablative_q_incident_profiles_w_m2[0]?.length ?? 'undefined'}</>
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
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              Ablative Cooling: Heat Flux vs Axial Position
            </h4>
            <div className="text-xs text-[var(--color-text-secondary)]">
              t = {time?.[activeIndices.length > 0 ? activeIndices[activeIndices.length - 1] : (time?.length ? time.length - 1 : 0)]?.toFixed(2)}s
            </div>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)] mb-4">
            Incident heat flux (conv + rad) and net heat flux after blowing relief. 
            x = 0 at throat, negative towards injector (matches chamber geometry plot).
          </p>

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
