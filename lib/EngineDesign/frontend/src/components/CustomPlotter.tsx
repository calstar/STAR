import { useState, useMemo, useCallback } from 'react';
import {
  ComposedChart,
  Line,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import type { TimeSeriesData, TimeSeriesSummary } from '../api/client';

// Session storage key (same as TimeSeriesMode)
const TIMESERIES_RESULTS_KEY = 'timeseries_results';

interface StoredResults {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
  timestamp: number;
}

// Available fields from TimeSeriesData with display names
const FIELD_CONFIG: Record<string, { label: string; unit: string; color: string }> = {
  time: { label: 'Time', unit: 's', color: '#94a3b8' },
  P_tank_O_psi: { label: 'LOX Tank Pressure', unit: 'psi', color: '#06b6d4' },
  P_tank_F_psi: { label: 'Fuel Tank Pressure', unit: 'psi', color: '#f97316' },
  Pc_psi: { label: 'Chamber Pressure', unit: 'psi', color: '#10b981' },
  thrust_kN: { label: 'Thrust', unit: 'kN', color: '#3b82f6' },
  Isp_s: { label: 'Specific Impulse', unit: 's', color: '#8b5cf6' },
  MR: { label: 'O/F Ratio', unit: '', color: '#eab308' },
  mdot_O_kg_s: { label: 'LOX Mass Flow', unit: 'kg/s', color: '#06b6d4' },
  mdot_F_kg_s: { label: 'Fuel Mass Flow', unit: 'kg/s', color: '#f97316' },
  mdot_total_kg_s: { label: 'Total Mass Flow', unit: 'kg/s', color: '#a855f7' },
  cstar_actual_m_s: { label: 'C* Actual', unit: 'm/s', color: '#ec4899' },
  gamma: { label: 'Gamma', unit: '', color: '#14b8a6' },
  Cd_O: { label: 'Cd Oxidizer', unit: '', color: '#06b6d4' },
  Cd_F: { label: 'Cd Fuel', unit: '', color: '#f97316' },
  delta_P_injector_O_psi: { label: 'LOX Injector ΔP', unit: 'psi', color: '#22d3d1' },
  delta_P_injector_F_psi: { label: 'Fuel Injector ΔP', unit: 'psi', color: '#fb923c' },
  Lstar_mm: { label: 'L*', unit: 'mm', color: '#a855f7' },
  copv_pressure_psi: { label: 'COPV Pressure', unit: 'psi', color: '#22c55e' },
  recession_rate_ablative_um_s: { label: 'Ablative Recession Rate', unit: 'µm/s', color: '#8b5cf6' },
  recession_rate_graphite_thermal_um_s: { label: 'Graphite Thermal Recession', unit: 'µm/s', color: '#ef4444' },
  recession_rate_graphite_oxidation_um_s: { label: 'Graphite Oxidation Recession', unit: 'µm/s', color: '#f59e0b' },
  recession_cumulative_ablative_mm: { label: 'Cumulative Ablative Recession', unit: 'mm', color: '#8b5cf6' },
  recession_cumulative_graphite_thermal_mm: { label: 'Cumulative Graphite Thermal', unit: 'mm', color: '#ef4444' },
  recession_cumulative_graphite_oxidation_mm: { label: 'Cumulative Graphite Oxidation', unit: 'mm', color: '#f59e0b' },
  V_chamber_m3: { label: 'Chamber Volume', unit: 'm³', color: '#ef4444' },
  A_throat_m2: { label: 'Throat Area', unit: 'm²', color: '#3b82f6' },
};

// Color palette for series
const SERIES_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#eab308', '#a855f7', '#22c55e', '#fb7185',
];

type PlotType = 'line' | 'scatter';
type ScaleType = 'linear' | 'log';

interface CustomPlotterProps {
  /** Whether the plotter tab is currently visible (for render optimizations). */
  isVisible?: boolean;
}

function loadResultsFromSession(): { data: TimeSeriesData; summary: TimeSeriesSummary } | null {
  try {
    const stored = sessionStorage.getItem(TIMESERIES_RESULTS_KEY);
    if (!stored) return null;
    const parsed: StoredResults = JSON.parse(stored);
    return { data: parsed.data, summary: parsed.summary };
  } catch {
    return null;
  }
}

function getAvailableFields(data: TimeSeriesData): string[] {
  const fields: string[] = [];
  for (const key of Object.keys(data)) {
    const value = (data as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'number') {
      fields.push(key);
    }
  }
  return fields;
}

function formatValue(value: number, decimals: number = 3): string {
  if (Math.abs(value) >= 1000) {
    return value.toFixed(1);
  } else if (Math.abs(value) >= 1) {
    return value.toFixed(decimals);
  } else if (Math.abs(value) >= 0.001) {
    return value.toFixed(4);
  } else {
    return value.toExponential(2);
  }
}

export function CustomPlotter({ isVisible = true }: CustomPlotterProps) {
  const results = useMemo(() => loadResultsFromSession(), [isVisible]);

  // Available fields
  const availableFields = useMemo(() => {
    if (!results) return [];
    return getAvailableFields(results.data);
  }, [results]);

  // Plot configuration state
  const [plotType, setPlotType] = useState<PlotType>('line');
  const [xAxis, setXAxis] = useState<string>('time');
  const [yAxes, setYAxes] = useState<string[]>(['thrust_kN']);
  const [useSecondaryAxis, setUseSecondaryAxis] = useState(false);
  const [primaryYAxes, setPrimaryYAxes] = useState<string[]>(['thrust_kN']);
  const [secondaryYAxes, setSecondaryYAxes] = useState<string[]>([]);
  const [xScale, setXScale] = useState<ScaleType>('linear');
  const [yScale, setYScale] = useState<ScaleType>('linear');
  const [y2Scale, setY2Scale] = useState<ScaleType>('linear');
  const [yAutoRange, setYAutoRange] = useState(false); // Auto-scale Y to data range vs 0-max
  const [y2AutoRange, setY2AutoRange] = useState(false);
  const [showMarkers, setShowMarkers] = useState(false);
  const [showDataPreview, setShowDataPreview] = useState(false);

  // Transform data for chart
  const chartData = useMemo(() => {
    if (!results) return [];
    const data = results.data;
    const length = data.time.length;
    const points: Record<string, number>[] = [];

    for (let i = 0; i < length; i++) {
      const point: Record<string, number> = {};
      for (const field of availableFields) {
        const arr = (data as unknown as Record<string, number[]>)[field];
        if (arr && arr[i] !== undefined) {
          point[field] = arr[i];
        }
      }
      points.push(point);
    }
    return points;
  }, [results, availableFields]);

  // Calculate time axis ticks (integer seconds) when x-axis is time
  const timeAxisConfig = useMemo(() => {
    if (xAxis !== 'time' || chartData.length === 0) return null;

    const times = chartData.map(p => p.time).filter(t => t !== undefined);
    if (times.length === 0) return null;

    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const maxTimeInt = Math.ceil(maxTime);

    // Generate integer ticks from 0 to maxTimeInt
    const integerTicks: number[] = [];
    for (let i = 0; i <= maxTimeInt; i++) {
      integerTicks.push(i);
    }

    return {
      minTime,
      maxTimeInt,
      integerTicks,
      formatTick: (value: number) => Math.round(value).toString(),
    };
  }, [xAxis, chartData]);

  // Handle Y-axis selection changes
  const handleYAxisChange = useCallback((field: string) => {
    setYAxes(prev => {
      if (prev.includes(field)) {
        const newAxes = prev.filter(f => f !== field);
        // Also remove from primary/secondary
        setPrimaryYAxes(p => p.filter(f => f !== field));
        setSecondaryYAxes(s => s.filter(f => f !== field));
        return newAxes;
      } else {
        const newAxes = [...prev, field];
        // Add to primary by default
        setPrimaryYAxes(p => [...p, field]);
        return newAxes;
      }
    });
  }, []);

  // Move field between primary and secondary axes
  const toggleAxisAssignment = useCallback((field: string) => {
    if (primaryYAxes.includes(field)) {
      setPrimaryYAxes(p => p.filter(f => f !== field));
      setSecondaryYAxes(s => [...s, field]);
    } else {
      setSecondaryYAxes(s => s.filter(f => f !== field));
      setPrimaryYAxes(p => [...p, field]);
    }
  }, [primaryYAxes]);

  // Get field info
  const getFieldInfo = (field: string) => {
    return FIELD_CONFIG[field] || { label: field, unit: '', color: '#94a3b8' };
  };

  // Get color for a series
  const getSeriesColor = (field: string, index: number) => {
    const config = FIELD_CONFIG[field];
    if (config) return config.color;
    return SERIES_COLORS[index % SERIES_COLORS.length];
  };

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;

    const xInfo = getFieldInfo(xAxis);

    return (
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-xl">
        <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
          {xInfo.label} = {formatValue(label)} {xInfo.unit}
        </p>
        <div className="space-y-1">
          {payload.map((entry: any, idx: number) => {
            const info = getFieldInfo(entry.dataKey);
            return (
              <p key={idx} className="text-xs flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span style={{ color: entry.color }}>
                  {info.label}: {formatValue(entry.value)} {info.unit}
                </span>
              </p>
            );
          })}
        </div>
      </div>
    );
  };

  // Download CSV
  const handleDownloadCSV = useCallback(() => {
    if (!results) return;

    const headers = availableFields.map(f => {
      const info = getFieldInfo(f);
      return `${info.label} (${info.unit})`;
    });

    const rows = chartData.map(point =>
      availableFields.map(f => point[f]?.toString() ?? '').join(',')
    );

    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom_plot_data.csv';
    a.click();
    URL.revokeObjectURL(url);
  }, [results, availableFields, chartData]);

  // Download RASP .eng thrust curve
  const handleDownloadENG = useCallback(() => {
    if (!results) return;

    const time = results.data.time;
    const thrust_kN = results.data.thrust_kN;

    if (
      !Array.isArray(time) ||
      !Array.isArray(thrust_kN) ||
      time.length === 0 ||
      time.length !== thrust_kN.length
    ) {
      return;
    }

    // Convert thrust from kN to N
    const thrust_N = thrust_kN.map((v) => v * 1000);

    // Integrate thrust to get total impulse [N·s] using trapezoidal rule
    let totalImpulse = 0;
    for (let i = 1; i < time.length; i++) {
      const dt = time[i] - time[i - 1];
      if (dt <= 0) continue;
      const avgThrust = 0.5 * (thrust_N[i] + thrust_N[i - 1]);
      totalImpulse += avgThrust * dt;
    }

    const motorName = 'PINTLE-MOTOR';
    const diameter_mm = 100; // Placeholder diameter, edit in .eng if needed
    const length_mm = 1000; // Placeholder length, edit in .eng if needed
    const propMass_kg = results.summary.total_propellant_kg ?? 0;
    const delay_s = 0.0;

    const header = [
      motorName,
      diameter_mm.toFixed(0),
      length_mm.toFixed(0),
      propMass_kg.toFixed(3),
      totalImpulse.toFixed(1),
      delay_s.toFixed(1),
    ].join(' ');

    const lines = [
      header,
      ...time.map((t, i) => `${t.toFixed(4)} ${thrust_N[i].toFixed(2)}`),
    ];

    const engText = lines.join('\n');
    const blob = new Blob([engText], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'thrust_curve.eng';
    a.click();
    URL.revokeObjectURL(url);
  }, [results]);

  // Empty state
  if (!results) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-lg font-medium">No Data Available</p>
          <p className="text-sm mt-2">
            Run a time-series analysis first to generate data for plotting.
          </p>
        </div>
      </div>
    );
  }

  const xInfo = getFieldInfo(xAxis);

  // Helper to format field label with unit
  const formatFieldLabel = (field: string) => {
    const info = getFieldInfo(field);
    return info.unit ? `${info.label} (${info.unit})` : info.label;
  };

  const primaryLabel = primaryYAxes.length <= 2
    ? primaryYAxes.map(f => formatFieldLabel(f)).join(', ')
    : `${primaryYAxes.length} series`;
  const secondaryLabel = secondaryYAxes.length <= 2
    ? secondaryYAxes.map(f => formatFieldLabel(f)).join(', ')
    : `${secondaryYAxes.length} series`;

  // For single axis mode, use the same label format
  const singleYAxisLabel = yAxes.length === 1
    ? formatFieldLabel(yAxes[0])
    : yAxes.length <= 2
      ? yAxes.map(f => formatFieldLabel(f)).join(', ')
      : `${yAxes.length} series`;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Custom Plotter</h2>
            <p className="text-sm text-[var(--color-text-secondary)]">
              Build custom plots from time-series data ({chartData.length} data points)
            </p>
          </div>
        </div>

        {/* Configuration Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Plot Type */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">Plot Type</label>
            <div className="flex gap-2">
              <button
                onClick={() => setPlotType('line')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${plotType === 'line'
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-emerald-500'
                  }`}
              >
                Line
              </button>
              <button
                onClick={() => setPlotType('scatter')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${plotType === 'scatter'
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-emerald-500'
                  }`}
              >
                Scatter
              </button>
            </div>
          </div>

          {/* X-Axis */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">X-Axis</label>
            <select
              value={xAxis}
              onChange={(e) => setXAxis(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] focus:outline-none focus:border-emerald-500"
            >
              {availableFields.map(field => (
                <option key={field} value={field}>
                  {getFieldInfo(field).label}
                </option>
              ))}
            </select>
          </div>

          {/* X Scale */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">X-Axis Scale</label>
            <div className="flex gap-2">
              <button
                onClick={() => setXScale('linear')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${xScale === 'linear'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500'
                  }`}
              >
                Linear
              </button>
              <button
                onClick={() => setXScale('log')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${xScale === 'log'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500'
                  }`}
              >
                Log
              </button>
            </div>
          </div>

          {/* Y Scale */}
          <div>
            <label className="block text-sm text-[var(--color-text-secondary)] mb-2">Y-Axis Scale</label>
            <div className="flex gap-2">
              <button
                onClick={() => setYScale('linear')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${yScale === 'linear'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500'
                  }`}
              >
                Linear
              </button>
              <button
                onClick={() => setYScale('log')}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${yScale === 'log'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-blue-500'
                  }`}
              >
                Log
              </button>
            </div>
          </div>
        </div>

        {/* Y-Axis Auto Range */}
        <div className="mt-4 flex items-center gap-4">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={yAutoRange}
              onChange={(e) => setYAutoRange(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border)] text-blue-600 focus:ring-blue-500"
            />
            Y-Axis Auto Range
            <span className="text-xs opacity-60">(fit to data min/max)</span>
          </label>
        </div>

        {/* Y-Axis Selection */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm text-[var(--color-text-secondary)]">Y-Axis Variables</label>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={showMarkers}
                  onChange={(e) => setShowMarkers(e.target.checked)}
                  className="w-4 h-4 rounded border-[var(--color-border)] text-emerald-600 focus:ring-emerald-500"
                />
                Show Markers
              </label>
              {yAxes.length > 1 && (
                <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                  <input
                    type="checkbox"
                    checked={useSecondaryAxis}
                    onChange={(e) => setUseSecondaryAxis(e.target.checked)}
                    className="w-4 h-4 rounded border-[var(--color-border)] text-emerald-600 focus:ring-emerald-500"
                  />
                  Dual Y-Axis
                </label>
              )}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            {availableFields.filter(f => f !== xAxis).map((field, idx) => {
              const info = getFieldInfo(field);
              const isSelected = yAxes.includes(field);
              const isSecondary = secondaryYAxes.includes(field);

              return (
                <button
                  key={field}
                  onClick={() => handleYAxisChange(field)}
                  className={`px-3 py-1.5 text-xs rounded-lg border transition-all flex items-center gap-2 ${isSelected
                    ? 'border-emerald-500 bg-emerald-500/20 text-emerald-400'
                    : 'border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-secondary)] hover:border-emerald-500/50'
                    }`}
                >
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: getSeriesColor(field, idx) }}
                  />
                  {info.label}
                  {isSelected && useSecondaryAxis && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleAxisAssignment(field);
                      }}
                      className={`ml-1 px-1.5 py-0.5 text-[10px] rounded cursor-pointer ${isSecondary
                        ? 'bg-purple-500/30 text-purple-400'
                        : 'bg-blue-500/30 text-blue-400'
                        }`}
                    >
                      {isSecondary ? 'R' : 'L'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Secondary Y-Axis Scale (when dual axis enabled) */}
        {useSecondaryAxis && secondaryYAxes.length > 0 && (
          <div className="mt-4 flex items-center gap-6">
            <div>
              <label className="block text-sm text-[var(--color-text-secondary)] mb-2">Secondary Y-Axis Scale</label>
              <div className="flex gap-2 w-48">
                <button
                  onClick={() => setY2Scale('linear')}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${y2Scale === 'linear'
                    ? 'bg-purple-600 border-purple-600 text-white'
                    : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-purple-500'
                    }`}
                >
                  Linear
                </button>
                <button
                  onClick={() => setY2Scale('log')}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${y2Scale === 'log'
                    ? 'bg-purple-600 border-purple-600 text-white'
                    : 'bg-[var(--color-bg-primary)] border-[var(--color-border)] text-[var(--color-text-secondary)] hover:border-purple-500'
                    }`}
                >
                  Log
                </button>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] mt-6">
              <input
                type="checkbox"
                checked={y2AutoRange}
                onChange={(e) => setY2AutoRange(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--color-border)] text-purple-600 focus:ring-purple-500"
              />
              Auto Range
            </label>
          </div>
        )}
      </div>

      {/* Chart */}
      {yAxes.length > 0 && isVisible ? (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {yAxes.length === 1
                ? `${getFieldInfo(yAxes[0]).label} vs ${xInfo.label}`
                : `Multi-Series Plot`
              }
            </h4>
            <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
              {useSecondaryAxis && (
                <>
                  <span className="px-2 py-1 rounded bg-blue-500/20 text-blue-400">L: {primaryLabel}</span>
                  <span className="px-2 py-1 rounded bg-purple-500/20 text-purple-400">R: {secondaryLabel}</span>
                </>
              )}
            </div>
          </div>

          <ResponsiveContainer width="100%" height={400}>
            <ComposedChart data={chartData} margin={{ top: 5, right: 60, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey={xAxis}
                type="number"
                scale={xScale}
                domain={timeAxisConfig && xScale !== 'log'
                  ? [timeAxisConfig.minTime, timeAxisConfig.maxTimeInt]
                  : ['auto', 'auto']}
                ticks={timeAxisConfig && xScale !== 'log' ? timeAxisConfig.integerTicks : undefined}
                tickFormatter={timeAxisConfig ? timeAxisConfig.formatTick : undefined}
                allowDecimals={!timeAxisConfig}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{
                  value: xInfo.unit ? `${xInfo.label} (${xInfo.unit})` : xInfo.label,
                  position: 'insideBottom',
                  offset: -5,
                  fill: 'var(--color-text-secondary)'
                }}
              />

              {/* Primary Y-Axis */}
              <YAxis
                yAxisId="left"
                scale={yScale}
                domain={yScale === 'log' || yAutoRange ? ['auto', 'auto'] : [0, 'auto']}
                stroke={useSecondaryAxis ? '#3b82f6' : 'var(--color-text-secondary)'}
                tick={{ fill: useSecondaryAxis ? '#3b82f6' : 'var(--color-text-secondary)', fontSize: 11 }}
                label={{
                  value: useSecondaryAxis ? primaryLabel : singleYAxisLabel,
                  angle: -90,
                  position: 'insideLeft',
                  fill: useSecondaryAxis ? '#3b82f6' : 'var(--color-text-secondary)'
                }}
              />

              {/* Secondary Y-Axis */}
              {useSecondaryAxis && secondaryYAxes.length > 0 && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  scale={y2Scale}
                  domain={y2Scale === 'log' || y2AutoRange ? ['auto', 'auto'] : [0, 'auto']}
                  stroke="#a855f7"
                  tick={{ fill: '#a855f7', fontSize: 11 }}
                  label={{
                    value: secondaryLabel,
                    angle: 90,
                    position: 'insideRight',
                    fill: '#a855f7'
                  }}
                />
              )}

              <Tooltip content={<CustomTooltip />} />
              <Legend />

              {/* Render series */}
              {yAxes.map((field, idx) => {
                const color = getSeriesColor(field, idx);
                const info = getFieldInfo(field);
                const isSecondary = useSecondaryAxis && secondaryYAxes.includes(field);
                const yAxisId = isSecondary ? 'right' : 'left';

                if (plotType === 'scatter') {
                  return (
                    <Scatter
                      key={field}
                      yAxisId={yAxisId}
                      dataKey={field}
                      name={info.label}
                      fill={color}
                    />
                  );
                }

                return (
                  <Line
                    key={field}
                    yAxisId={yAxisId}
                    type="monotone"
                    dataKey={field}
                    name={info.label}
                    stroke={color}
                    strokeWidth={2}
                    dot={showMarkers ? { fill: color, r: 3 } : false}
                    strokeDasharray={isSecondary ? '5 5' : undefined}
                  />
                );
              })}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-[var(--color-text-secondary)] opacity-30" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
          <p className="text-[var(--color-text-secondary)]">
            Select at least one Y-axis variable to create a plot
          </p>
        </div>
      )}

      {/* Data Preview */}
      {isVisible && (
        <div className="rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] overflow-hidden">
          <button
            onClick={() => setShowDataPreview(!showDataPreview)}
            className="w-full px-4 py-3 flex items-center justify-between text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-bg-primary)] transition-colors"
          >
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
              </svg>
              Data Preview ({chartData.length} rows, {availableFields.length} columns)
            </span>
            <svg
              className={`w-4 h-4 transition-transform ${showDataPreview ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showDataPreview && (
            <div className="border-t border-[var(--color-border)]">
              <div className="p-3 flex justify-end gap-2 border-b border-[var(--color-border)]">
                <button
                  onClick={handleDownloadENG}
                  className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-emerald-500 transition-colors flex items-center gap-1"
                  title="Export thrust curve as RASP .eng file for rocket simulation software"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3 3-3M8 4h8a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z" />
                  </svg>
                  Export .eng
                </button>
                <button
                  onClick={handleDownloadCSV}
                  className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-emerald-500 transition-colors flex items-center gap-1"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  Download CSV
                </button>
              </div>

              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--color-bg-secondary)]">
                    <tr className="border-b border-[var(--color-border)]">
                      {availableFields.slice(0, 10).map(field => {
                        const info = getFieldInfo(field);
                        return (
                          <th key={field} className="text-left py-2 px-2 text-[var(--color-text-secondary)] font-medium whitespace-nowrap">
                            {info.label} {info.unit && `(${info.unit})`}
                          </th>
                        );
                      })}
                      {availableFields.length > 10 && (
                        <th className="text-left py-2 px-2 text-[var(--color-text-secondary)] font-medium">
                          +{availableFields.length - 10} more
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {chartData.slice(0, 50).map((row, i) => (
                      <tr key={i} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-bg-primary)]/50">
                        {availableFields.slice(0, 10).map(field => (
                          <td key={field} className="py-1.5 px-2 text-[var(--color-text-primary)] whitespace-nowrap">
                            {row[field] !== undefined ? formatValue(row[field]) : '-'}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {chartData.length > 50 && (
                  <p className="text-center text-xs text-[var(--color-text-secondary)] py-2">
                    Showing first 50 of {chartData.length} rows. Download CSV for full data.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

