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
import { HeatFluxProfileChart } from './HeatFluxProfileChart';

interface PressureCurveChartProps {
  data: TimeSeriesData;
  summary: TimeSeriesSummary;
}

interface ChartDataPoint {
  time: number;
  thrust: number;
  Pc: number;
  Isp: number;
  P_tank_O: number;
  P_tank_F: number;
  MR: number;
  mdot_total: number;
  mdot_O?: number;
  mdot_F?: number;
  delta_P_injector_O?: number;
  delta_P_injector_F?: number;
  Lstar?: number;
  recession_rate_ablative?: number;
  recession_rate_graphite_thermal?: number;
  recession_rate_graphite_oxidation?: number;
  recession_cumulative_ablative?: number;
  recession_cumulative_graphite_thermal?: number;
  recession_cumulative_graphite_oxidation?: number;
  V_chamber_pct_change?: number;
  A_throat_pct_change?: number;
  copv_pressure?: number;
   lox_mass_remaining?: number;
   fuel_mass_remaining?: number;
  Cd_O?: number;
  Cd_F?: number;
  P_exit?: number;
}

function formatValue(value: number | null | undefined, decimals: number = 2): string {
  if (value == null) return '—';
  return value.toFixed(decimals);
}

// Correlation heatmap component
interface CorrelationHeatmapProps {
  matrix: number[][];
  labels: string[];
}

function getCorrelationColor(value: number): string {
  // Diverging colorscale: Orange/Red for negative, Teal/Blue for positive
  const absVal = Math.abs(value);
  if (value > 0) {
    // Teal/Blue gradient for positive correlations
    const r = Math.round(255 - absVal * 200);
    const g = Math.round(255 - absVal * 100);
    const b = Math.round(255 - absVal * 50);
    return `rgb(${r}, ${g}, ${b})`;
  } else if (value < 0) {
    // Orange/Red gradient for negative correlations
    const r = 255;
    const g = Math.round(255 - absVal * 150);
    const b = Math.round(255 - absVal * 200);
    return `rgb(${r}, ${g}, ${b})`;
  }
  return 'rgb(248, 250, 252)';
}

function CorrelationHeatmap({ matrix, labels }: CorrelationHeatmapProps) {
  const cellSize = 52;
  const labelWidth = 90;

  return (
    <div className="inline-block">
      {/* Header row with X-axis labels */}
      <div className="flex">
        <div style={{ width: labelWidth }} /> {/* Empty corner */}
        {labels.map((label, j) => (
          <div
            key={`x-${j}`}
            className="text-[10px] text-[var(--color-text-secondary)] font-medium text-center px-1"
            style={{
              width: cellSize,
              height: 70,
              writingMode: 'vertical-rl',
              transform: 'rotate(180deg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
            }}
            title={label}
          >
            <span className="truncate" style={{ maxHeight: 65 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Matrix rows */}
      {matrix.map((row, i) => (
        <div key={`row-${i}`} className="flex items-center">
          {/* Y-axis label */}
          <div
            className="text-[10px] text-[var(--color-text-secondary)] font-medium text-right pr-3 truncate"
            style={{ width: labelWidth }}
            title={labels[i]}
          >
            {labels[i]}
          </div>

          {/* Row cells */}
          {row.map((value, j) => {
            const isStrong = Math.abs(value) > 0.7;
            const isMedium = Math.abs(value) > 0.4;
            return (
              <div
                key={`cell-${i}-${j}`}
                className="flex items-center justify-center text-[10px] font-mono transition-all hover:scale-105 hover:z-10 cursor-default"
                style={{
                  width: cellSize,
                  height: cellSize - 8,
                  backgroundColor: getCorrelationColor(value),
                  color: isStrong ? 'white' : isMedium ? 'rgba(0,0,0,0.8)' : 'rgba(0,0,0,0.6)',
                  fontWeight: isStrong ? 600 : 400,
                  borderRadius: 2,
                  margin: 1,
                  boxShadow: i === j ? 'inset 0 0 0 2px rgba(59, 130, 246, 0.5)' : 'none',
                }}
                title={`${labels[i]} × ${labels[j]}\nCorrelation: ${value.toFixed(4)}`}
              >
                {value.toFixed(2)}
              </div>
            );
          })}
        </div>
      ))}

      {/* Color legend */}
      <div className="flex items-center justify-center gap-3 mt-6 pt-4 border-t border-[var(--color-border)]">
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-text-secondary)]">Negative</span>
          <div className="flex rounded overflow-hidden">
            <div className="w-6 h-4" style={{ backgroundColor: 'rgb(255, 105, 55)' }} />
            <div className="w-6 h-4" style={{ backgroundColor: 'rgb(255, 180, 130)' }} />
            <div className="w-6 h-4" style={{ backgroundColor: 'rgb(248, 250, 252)' }} />
            <div className="w-6 h-4" style={{ backgroundColor: 'rgb(155, 205, 230)' }} />
            <div className="w-6 h-4" style={{ backgroundColor: 'rgb(55, 155, 205)' }} />
          </div>
          <span className="text-xs text-[var(--color-text-secondary)]">Positive</span>
        </div>
        <span className="text-[10px] text-[var(--color-text-secondary)] opacity-60">
          Diagonal = self-correlation (1.00)
        </span>
      </div>
    </div>
  );
}

export function PressureCurveChart({ data, summary }: PressureCurveChartProps) {
  // Guard against missing data
  if (!data || !data.time || data.time.length === 0 || !summary) {
    return (
      <div className="p-8 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-center">
        <p className="text-[var(--color-text-secondary)]">No pressure curve data available</p>
      </div>
    );
  }

  // Transform data for recharts - keep it simple like before
  const chartData: ChartDataPoint[] = data.time.map((t, i) => ({
    time: t,
    thrust: data.thrust_kN?.[i],
    Pc: data.Pc_psi?.[i],
    Isp: data.Isp_s?.[i],
    P_tank_O: data.P_tank_O_psi?.[i],
    P_tank_F: data.P_tank_F_psi?.[i],
    MR: data.MR?.[i],
    mdot_total: data.mdot_total_kg_s?.[i],
    mdot_O: data.mdot_O_kg_s?.[i],
    mdot_F: data.mdot_F_kg_s?.[i],
    delta_P_injector_O: data.delta_P_injector_O_psi?.[i],
    delta_P_injector_F: data.delta_P_injector_F_psi?.[i],
    Lstar: data.Lstar_mm?.[i],
    recession_rate_ablative: data.recession_rate_ablative_um_s?.[i],
    recession_rate_graphite_thermal: data.recession_rate_graphite_thermal_um_s?.[i],
    recession_rate_graphite_oxidation: data.recession_rate_graphite_oxidation_um_s?.[i],
    recession_cumulative_ablative: data.recession_cumulative_ablative_mm?.[i],
    recession_cumulative_graphite_thermal: data.recession_cumulative_graphite_thermal_mm?.[i],
    recession_cumulative_graphite_oxidation: data.recession_cumulative_graphite_oxidation_mm?.[i],
    V_chamber_pct_change: data.V_chamber_m3 && data.V_chamber_initial_m3 && data.V_chamber_m3[i]
      ? ((data.V_chamber_m3[i] / data.V_chamber_initial_m3) - 1) * 100
      : undefined,
    A_throat_pct_change: data.A_throat_m2 && data.A_throat_initial_m2 && data.A_throat_m2[i]
      ? ((data.A_throat_m2[i] / data.A_throat_initial_m2) - 1) * 100
      : undefined,
    copv_pressure: data.copv_pressure_psi?.[i],
    lox_mass_remaining: data.lox_mass_remaining_kg?.[i],
    fuel_mass_remaining: data.fuel_mass_remaining_kg?.[i],
    Cd_O: data.Cd_O?.[i],
    Cd_F: data.Cd_F?.[i],
    P_exit: data.P_exit_psi?.[i],
  }));

  // Calculate max time for x-axis domain
  const maxTime = data.time.length > 0 ? Math.max(...data.time) : 0;
  const minTime = data.time.length > 0 ? Math.min(...data.time) : 0;
  const maxTimeInt = Math.ceil(maxTime);

  // Generate integer ticks from 0 to maxTimeInt
  const integerTicks: number[] = [];
  for (let i = 0; i <= maxTimeInt; i++) {
    integerTicks.push(i);
  }

  // Format tick as integer seconds
  const formatTick = (value: number) => Math.round(value).toString();

  const hasDeltaPInjO =
    Array.isArray(data.delta_P_injector_O_psi) && data.delta_P_injector_O_psi.length === data.time.length;
  const hasDeltaPInjF =
    Array.isArray(data.delta_P_injector_F_psi) && data.delta_P_injector_F_psi.length === data.time.length;
  const showInjectorDeltaChart = hasDeltaPInjO || hasDeltaPInjF;

  const showExitPressureChart =
    !data.is_waterflow &&
    Array.isArray(data.P_exit_psi) &&
    data.P_exit_psi.length === data.time.length;
  const targetExitPsi = summary.target_P_exit_psi;
  const hasTargetExit =
    targetExitPsi != null && Number.isFinite(targetExitPsi) && targetExitPsi > 0;

  const customTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-lg">
          <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
            t = {formatValue(label, 3)} s
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, idx: number) => (
              <p key={idx} className="text-xs" style={{ color: entry.color }}>
                {entry.name}: {formatValue(entry.value, 2)} {getUnit(entry.dataKey)}
              </p>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  const getUnit = (dataKey: string): string => {
    switch (dataKey) {
      case 'thrust': return 'kN';
      case 'Pc':
      case 'P_tank_O':
      case 'P_tank_F':
      case 'delta_P_injector_O':
      case 'delta_P_injector_F':
      case 'copv_pressure': return 'psi';
      case 'Isp': return 's';
      case 'MR': return '';
      case 'mdot_total':
      case 'mdot_O':
      case 'mdot_F': return 'kg/s';
      case 'Lstar': return 'mm';
      case 'recession_rate_ablative':
      case 'recession_rate_graphite_thermal':
      case 'recession_rate_graphite_oxidation': return 'µm/s';
      case 'recession_cumulative_ablative':
      case 'recession_cumulative_graphite_thermal':
      case 'recession_cumulative_graphite_oxidation': return 'mm';
      case 'V_chamber_pct_change':
      case 'A_throat_pct_change': return '%';
      case 'lox_mass_remaining':
      case 'fuel_mass_remaining': return 'kg';
      case 'Cd_O':
      case 'Cd_F': return '';
      case 'P_exit': return 'psi';
      default: return '';
    }
  };

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
        <div className="p-3 rounded-lg bg-blue-500/10 border border-blue-500/30">
          <div className="text-xs text-[var(--color-text-secondary)]">Avg Thrust</div>
          <div className="text-lg font-bold text-blue-400">
            {formatValue(summary.avg_thrust_kN)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">kN</span>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-green-500/10 border border-green-500/30">
          <div className="text-xs text-[var(--color-text-secondary)]">Peak Thrust</div>
          <div className="text-lg font-bold text-green-400">
            {formatValue(summary.peak_thrust_kN)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">kN</span>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-purple-500/10 border border-purple-500/30">
          <div className="text-xs text-[var(--color-text-secondary)]">Avg Isp</div>
          <div className="text-lg font-bold text-purple-400">
            {formatValue(summary.avg_Isp_s, 1)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">s</span>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          <div className="text-xs text-[var(--color-text-secondary)]">Total Impulse</div>
          <div className="text-lg font-bold text-yellow-400">
            {formatValue(summary.total_impulse_kNs, 1)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">kN·s</span>
          </div>
        </div>
        <div className="p-3 rounded-lg bg-cyan-500/10 border border-cyan-500/30">
          <div className="text-xs text-[var(--color-text-secondary)]">Propellant</div>
          <div className="text-lg font-bold text-cyan-400">
            {formatValue(summary.total_propellant_kg, 1)} <span className="text-sm font-normal text-[var(--color-text-secondary)]">kg</span>
          </div>
        </div>
      </div>

      {/* 1. Thrust vs Time */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
          Thrust vs Time
        </h4>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis
              dataKey="time"
              type="number"
              domain={[minTime, maxTimeInt]}
              ticks={integerTicks}
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={formatTick}
              allowDecimals={false}
              label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
            />
            <YAxis
              stroke="#3b82f6"
              tick={{ fill: '#3b82f6', fontSize: 11 }}
              label={{ value: 'Thrust (kN)', angle: -90, position: 'insideLeft', fill: '#3b82f6' }}
            />
            <Tooltip content={customTooltip} />
            <Legend />
            <Line
              type="monotone"
              dataKey="thrust"
              name="Thrust"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 2. Chamber Pressure vs Time */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
          Chamber Pressure vs Time
        </h4>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis
              dataKey="time"
              type="number"
              domain={[minTime, maxTimeInt]}
              ticks={integerTicks}
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={formatTick}
              allowDecimals={false}
              label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
            />
            <YAxis
              stroke="#10b981"
              tick={{ fill: '#10b981', fontSize: 11 }}
              label={{ value: 'Pc (psi)', angle: -90, position: 'insideLeft', fill: '#10b981' }}
            />
            <Tooltip content={customTooltip} />
            <Legend />
            <Line
              type="monotone"
              dataKey="Pc"
              name="Chamber Pressure"
              stroke="#10b981"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Exit pressure vs ambient target */}
      {showExitPressureChart && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Exit Pressure vs Time
            {hasTargetExit && (
              <span className="text-xs font-normal text-[var(--color-text-secondary)] ml-2">
                (dashed = ambient / target {targetExitPsi.toFixed(2)} psi)
              </span>
            )}
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="#f43f5e"
                tick={{ fill: '#f43f5e', fontSize: 11 }}
                label={{ value: 'P_exit (psi)', angle: -90, position: 'insideLeft', fill: '#f43f5e' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {hasTargetExit && (
                <ReferenceLine
                  y={targetExitPsi}
                  stroke="var(--color-text-secondary)"
                  strokeDasharray="6 4"
                  strokeWidth={2}
                  ifOverflow="extendDomain"
                  label={{
                    value: 'Target (ambient)',
                    position: 'insideTopRight',
                    fill: 'var(--color-text-secondary)',
                    fontSize: 11,
                  }}
                />
              )}
              <Line
                type="monotone"
                dataKey="P_exit"
                name="Exit pressure"
                stroke="#f43f5e"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 3. Mass Flow Rates */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
          Mass Flow Rates vs Time
        </h4>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis
              dataKey="time"
              type="number"
              domain={[minTime, maxTimeInt]}
              ticks={integerTicks}
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={formatTick}
              allowDecimals={false}
              label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
            />
            <YAxis
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              label={{ value: 'Mass Flow Rate (kg/s)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
            />
            <Tooltip content={customTooltip} />
            <Legend />
            <Line
              type="monotone"
              dataKey="mdot_total"
              name="Total"
              stroke="#8b5cf6"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="mdot_O"
              name="Oxidizer"
              stroke="#06b6d4"
              strokeWidth={2}
              dot={false}
            />
            <Line
              type="monotone"
              dataKey="mdot_F"
              name="Fuel"
              stroke="#f97316"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 4. O/F Ratio vs Time */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
          O/F Ratio vs Time
        </h4>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
            <XAxis
              dataKey="time"
              type="number"
              domain={[minTime, maxTimeInt]}
              ticks={integerTicks}
              stroke="var(--color-text-secondary)"
              tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
              tickFormatter={formatTick}
              allowDecimals={false}
              label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
            />
            <YAxis
              stroke="#eab308"
              tick={{ fill: '#eab308', fontSize: 11 }}
              label={{ value: 'O/F Ratio', angle: -90, position: 'insideLeft', fill: '#eab308' }}
            />
            <Tooltip content={customTooltip} />
            <Legend />
            <Line
              type="monotone"
              dataKey="MR"
              name="O/F Ratio"
              stroke="#eab308"
              strokeWidth={2}
              dot={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* 5. Cd vs Time */}
      {(data.Cd_O || data.Cd_F) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Discharge Coefficient (Cd) vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Cd', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {data.Cd_O && (
                <Line
                  type="monotone"
                  dataKey="Cd_O"
                  name="LOX Cd"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.Cd_F && (
                <Line
                  type="monotone"
                  dataKey="Cd_F"
                  name="Fuel Cd"
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 6. COPV & Tank Pressures vs Time */}
      {(data.copv_pressure_psi || data.P_tank_O_psi) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
              {data.copv_pressure_psi ? "COPV & Tank Pressures vs Time" : "Tank Pressures vs Time"}
            </h4>
            {summary.copv_initial_pressure_psi && (
              <div className="flex gap-4 text-xs">
                <span className="text-green-400">
                  P₀: {formatValue(summary.copv_initial_pressure_psi, 0)} psi
                </span>
                <span className="text-[var(--color-text-secondary)]">
                  m₀: {formatValue(summary.copv_initial_mass_kg || 0, 3)} kg
                </span>
                <span className={`${(summary.copv_min_margin_psi || 0) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                  Min Margin: {formatValue(summary.copv_min_margin_psi || 0, 1)} psi
                </span>
              </div>
            )}
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                yAxisId="left"
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Tank Pressure (psi)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              {data.copv_pressure_psi && (
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="#22c55e"
                  tick={{ fill: '#22c55e', fontSize: 11 }}
                  label={{ value: 'COPV Pressure (psi)', angle: 90, position: 'insideRight', fill: '#22c55e' }}
                />
              )}
              <Tooltip content={customTooltip} />
              <Legend />
              {data.copv_pressure_psi && (
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="copv_pressure"
                  name="COPV"
                  stroke="#22c55e"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="P_tank_O"
                name="LOX Tank"
                stroke="#06b6d4"
                strokeWidth={2}
                dot={false}
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="P_tank_F"
                name="Fuel Tank"
                stroke="#f97316"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Tank Fill Levels (Propellant Mass Remaining) */}
      {(data.lox_mass_remaining_kg || data.fuel_mass_remaining_kg) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Tank Fill Levels vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Mass (kg)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {data.lox_mass_remaining_kg && (
                <Line
                  type="monotone"
                  dataKey="lox_mass_remaining"
                  name="LOX Mass"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.fuel_mass_remaining_kg && (
                <Line
                  type="monotone"
                  dataKey="fuel_mass_remaining"
                  name="Fuel Mass"
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 6. Injector Pressure Drops (LOX + fuel when present) */}
      {showInjectorDeltaChart && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Injector Pressure Drops vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Pressure Drop (psi)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {hasDeltaPInjO && (
                <Line
                  type="monotone"
                  dataKey="delta_P_injector_O"
                  name="LOX ΔP_inj"
                  stroke="#06b6d4"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              )}
              {hasDeltaPInjF && (
                <Line
                  type="monotone"
                  dataKey="delta_P_injector_F"
                  name="Fuel ΔP_inj"
                  stroke="#f97316"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 6. Characteristic Length */}
      {data.Lstar_mm && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Characteristic Length (L*) vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="#a855f7"
                tick={{ fill: '#a855f7', fontSize: 11 }}
                label={{ value: 'L* (mm)', angle: -90, position: 'insideLeft', fill: '#a855f7' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              <Line
                type="monotone"
                dataKey="Lstar"
                name="L*"
                stroke="#a855f7"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 7. Recession Rate Plot */}
      {(data.recession_rate_ablative_um_s || data.recession_rate_graphite_thermal_um_s || data.recession_rate_graphite_oxidation_um_s) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Recession Rate vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Recession Rate (µm/s)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {data.recession_rate_ablative_um_s && (
                <Line
                  type="monotone"
                  dataKey="recession_rate_ablative"
                  name="Ablative"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.recession_rate_graphite_thermal_um_s && (
                <Line
                  type="monotone"
                  dataKey="recession_rate_graphite_thermal"
                  name="Graphite Thermal Ablation"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.recession_rate_graphite_oxidation_um_s && (
                <Line
                  type="monotone"
                  dataKey="recession_rate_graphite_oxidation"
                  name="Graphite Oxidation"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 8. Recession Cumulative Plot */}
      {(data.recession_cumulative_ablative_mm || data.recession_cumulative_graphite_thermal_mm || data.recession_cumulative_graphite_oxidation_mm) && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Cumulative Recession vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Cumulative Recession (mm)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              {data.recession_cumulative_ablative_mm && (
                <Line
                  type="monotone"
                  dataKey="recession_cumulative_ablative"
                  name="Ablative"
                  stroke="#8b5cf6"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.recession_cumulative_graphite_thermal_mm && (
                <Line
                  type="monotone"
                  dataKey="recession_cumulative_graphite_thermal"
                  name="Graphite Thermal Ablation"
                  stroke="#ef4444"
                  strokeWidth={2}
                  dot={false}
                />
              )}
              {data.recession_cumulative_graphite_oxidation_mm && (
                <Line
                  type="monotone"
                  dataKey="recession_cumulative_graphite_oxidation"
                  name="Graphite Oxidation"
                  stroke="#f59e0b"
                  strokeWidth={2}
                  dot={false}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 9. Geometry Growth */}
      {data.V_chamber_m3 && data.A_throat_m2 && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Geometry Growth vs Time
          </h4>
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={chartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.5} />
              <XAxis
                dataKey="time"
                type="number"
                domain={[minTime, maxTimeInt]}
                ticks={integerTicks}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                tickFormatter={formatTick}
                allowDecimals={false}
                label={{ value: 'Time (s)', position: 'insideBottom', offset: -5, fill: 'var(--color-text-secondary)' }}
              />
              <YAxis
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{ value: 'Change (%)', angle: -90, position: 'insideLeft', fill: 'var(--color-text-secondary)' }}
              />
              <Tooltip content={customTooltip} />
              <Legend />
              <Line
                type="monotone"
                dataKey="V_chamber_pct_change"
                name="Chamber Volume"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="A_throat_pct_change"
                name="Throat Area"
                stroke="#3b82f6"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* 10. Heat Flux Profile Charts */}
      <HeatFluxProfileChart data={data} summary={summary} />

      {/* Correlation Heatmap */}
      {data.correlation_matrix && data.correlation_labels && data.correlation_labels.length >= 2 && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold mb-4 text-[var(--color-text-primary)]">
            Correlation Heatmap
          </h4>
          <div className="overflow-x-auto">
            <CorrelationHeatmap
              matrix={data.correlation_matrix}
              labels={data.correlation_labels}
            />
          </div>
        </div>
      )}

      {/* Data Table */}
      <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center justify-between mb-4">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            Data Table
          </h4>
          <button
            onClick={() => {
              // Generate CSV and download
              const headers = ['time (s)', 'P_tank_O (psi)', 'P_tank_F (psi)', 'Pc (psi)', 'Thrust (kN)', 'Isp (s)', 'MR', 'mdot_total (kg/s)'];
              const rows = data.time.map((t, i) => [
                t.toFixed(4),
                data.P_tank_O_psi[i].toFixed(2),
                data.P_tank_F_psi[i].toFixed(2),
                data.Pc_psi[i].toFixed(2),
                data.thrust_kN[i].toFixed(4),
                data.Isp_s[i].toFixed(2),
                data.MR[i].toFixed(4),
                data.mdot_total_kg_s[i].toFixed(4),
              ].join(','));
              const csv = [headers.join(','), ...rows].join('\n');
              const blob = new Blob([csv], { type: 'text/csv' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'time_series_results.csv';
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="px-3 py-1.5 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-blue-500 transition-colors flex items-center gap-1"
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
                <th className="text-left py-2 px-2 text-[var(--color-text-secondary)] font-medium">Time (s)</th>
                <th className="text-right py-2 px-2 text-cyan-400 font-medium">LOX (psi)</th>
                <th className="text-right py-2 px-2 text-orange-400 font-medium">Fuel (psi)</th>
                <th className="text-right py-2 px-2 text-green-400 font-medium">Pc (psi)</th>
                <th className="text-right py-2 px-2 text-blue-400 font-medium">Thrust (kN)</th>
                <th className="text-right py-2 px-2 text-purple-400 font-medium">Isp (s)</th>
                <th className="text-right py-2 px-2 text-yellow-400 font-medium">O/F</th>
              </tr>
            </thead>
            <tbody>
              {data.time.slice(0, 50).map((t, i) => (
                <tr key={i} className="border-b border-[var(--color-border)]/50 hover:bg-[var(--color-bg-primary)]/50">
                  <td className="py-1.5 px-2 text-[var(--color-text-primary)]">{(t ?? 0).toFixed(3)}</td>
                  <td className="py-1.5 px-2 text-right text-cyan-400">{(data.P_tank_O_psi[i] ?? 0).toFixed(1)}</td>
                  <td className="py-1.5 px-2 text-right text-orange-400">{(data.P_tank_F_psi[i] ?? 0).toFixed(1)}</td>
                  <td className="py-1.5 px-2 text-right text-green-400">{(data.Pc_psi[i] ?? 0).toFixed(1)}</td>
                  <td className="py-1.5 px-2 text-right text-blue-400">{(data.thrust_kN[i] ?? 0).toFixed(3)}</td>
                  <td className="py-1.5 px-2 text-right text-purple-400">{(data.Isp_s[i] ?? 0).toFixed(1)}</td>
                  <td className="py-1.5 px-2 text-right text-yellow-400">{(data.MR[i] ?? 0).toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.time.length > 50 && (
            <p className="text-center text-xs text-[var(--color-text-secondary)] py-2">
              Showing first 50 of {data.time.length} rows. Download CSV for full data.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

