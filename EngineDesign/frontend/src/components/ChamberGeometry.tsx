import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { getChamberGeometry } from '../api/client';
import type { ChamberGeometryResponse, EngineConfig } from '../api/client';
import { ChamberContourPlot } from './ChamberContourPlot';
import { ChamberThermalGraphic } from './ChamberThermalGraphic';

interface ChamberGeometryProps {
  config: EngineConfig | null;
}

// Convert m to mm for display
const M_TO_MM = 1000;


export function ChamberGeometry({ config }: ChamberGeometryProps) {
  const [geometry, setGeometry] = useState<ChamberGeometryResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLowerHalf, setShowLowerHalf] = useState(true);

  // Fetch geometry when component mounts or config changes
  const fetchGeometry = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const result = await getChamberGeometry();

    setIsLoading(false);

    if (result.error) {
      setError(result.error);
      setGeometry(null);
    } else if (result.data) {
      setGeometry(result.data);
    }
  }, []);

  useEffect(() => {
    if (config) {
      fetchGeometry();
    }
  }, [config, fetchGeometry]);

  // Transform geometry data for chart - create symmetric view
  // This includes chamber layers + Rao nozzle contour
  const chartData = useMemo(() => {
    if (!geometry) return [];

    const data: Record<string, number>[] = [];

    // First, add chamber region data (before throat)
    const n = geometry.positions.length;
    for (let i = 0; i < n; i++) {
      const pos = geometry.positions[i];
      // Only include chamber region (up to throat)
      if (pos > geometry.throat_position) continue;

      const x = pos * M_TO_MM;  // Convert to mm
      const rGas = geometry.R_gas[i] * M_TO_MM;
      const rAblative = geometry.R_ablative_outer[i] * M_TO_MM;
      const rGraphite = geometry.R_graphite_outer[i] * M_TO_MM;
      const rStainless = geometry.R_stainless[i] * M_TO_MM;

      // Check if this point is in graphite region
      const isGraphiteRegion =
        pos >= geometry.graphite_start &&
        pos <= geometry.graphite_end;

      data.push({
        x,
        // Upper half
        R_stainless_upper: rStainless,
        R_graphite_upper: isGraphiteRegion ? rGraphite : rGas,
        R_ablative_upper: rAblative,
        R_gas_upper: rGas,
        // Lower half (negative)
        R_stainless_lower: showLowerHalf ? -rStainless : 0,
        R_graphite_lower: showLowerHalf ? (isGraphiteRegion ? -rGraphite : -rGas) : 0,
        R_ablative_lower: showLowerHalf ? -rAblative : 0,
        R_gas_lower: showLowerHalf ? -rGas : 0,
      });
    }

    return data;
  }, [geometry, showLowerHalf]);

  // Calculate dimensions for display
  const dimensions = useMemo(() => {
    if (!geometry) return null;

    return {
      L_chamber_mm: geometry.L_chamber * M_TO_MM,
      L_nozzle_mm: geometry.L_nozzle * M_TO_MM,
      L_total_mm: (geometry.L_chamber + geometry.L_nozzle) * M_TO_MM,
      D_chamber_mm: geometry.D_chamber * M_TO_MM,
      D_throat_mm: geometry.D_throat * M_TO_MM,
      D_exit_mm: geometry.D_exit * M_TO_MM,
      throat_position_mm: geometry.throat_position * M_TO_MM,
    };
  }, [geometry]);

  // Custom tooltip
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload || !payload.length) return null;

    // Find the actual radii at this position
    const gasRadius = payload.find((p: any) => p.dataKey === 'R_gas_upper')?.value || 0;
    const ablativeRadius = payload.find((p: any) => p.dataKey === 'R_ablative_upper')?.value || 0;
    const graphiteRadius = payload.find((p: any) => p.dataKey === 'R_graphite_upper')?.value || 0;
    const stainlessRadius = payload.find((p: any) => p.dataKey === 'R_stainless_upper')?.value || 0;

    return (
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-xl">
        <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
          Position: {label.toFixed(1)} mm
        </p>
        <div className="space-y-1 text-xs">
          <p className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#ff6b35' }} />
            <span className="text-orange-400">Gas Boundary: Ø{(gasRadius * 2).toFixed(1)} mm</span>
          </p>
          {ablativeRadius > gasRadius && (
            <p className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#8b4513' }} />
              <span className="text-amber-600">Ablative: Ø{(ablativeRadius * 2).toFixed(1)} mm</span>
            </p>
          )}
          {graphiteRadius > gasRadius && (
            <p className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#1a1a1a' }} />
              <span className="text-gray-400">Graphite: Ø{(graphiteRadius * 2).toFixed(1)} mm</span>
            </p>
          )}
          <p className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full" style={{ backgroundColor: '#6b7280' }} />
            <span className="text-gray-500">Stainless: Ø{(stainlessRadius * 2).toFixed(1)} mm</span>
          </p>
        </div>
      </div>
    );
  };

  // Empty state - no config
  if (!config) {
    return (
      <div className="flex items-center justify-center h-64 text-[var(--color-text-secondary)]">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p>No config loaded</p>
          <p className="text-sm mt-1">Upload a YAML config file first</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-rose-500 to-orange-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z" />
              </svg>
            </div>
            <div>
              <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Chamber Geometry</h2>
              <p className="text-sm text-[var(--color-text-secondary)]">
                Cross-section visualization of thrust chamber
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
              <input
                type="checkbox"
                checked={showLowerHalf}
                onChange={(e) => setShowLowerHalf(e.target.checked)}
                className="w-4 h-4 rounded border-[var(--color-border)] text-rose-600 focus:ring-rose-500"
              />
              Show Full Cross-Section
            </label>

            <button
              onClick={fetchGeometry}
              disabled={isLoading}
              className="px-4 py-2 rounded-lg bg-gradient-to-r from-rose-600 to-orange-600 hover:from-rose-700 hover:to-orange-700 text-white text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-2"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  Loading...
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Refresh
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error message */}
        {error && (
          <div className="mt-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-400 text-sm">
            {error}
          </div>
        )}
      </div>

      {/* Geometry Plot */}
      {geometry && chartData.length > 0 && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-4">
            Chamber Cross-Section (Side View)
          </h4>

          <ResponsiveContainer width="100%" height={450}>
            <ComposedChart data={chartData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />

              <XAxis
                dataKey="x"
                type="number"
                domain={['dataMin', 'dataMax']}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{
                  value: 'Axial Position (mm)',
                  position: 'insideBottom',
                  offset: -10,
                  fill: 'var(--color-text-secondary)'
                }}
              />

              <YAxis
                domain={showLowerHalf ? ['auto', 'auto'] : [0, 'auto']}
                stroke="var(--color-text-secondary)"
                tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                label={{
                  value: 'Radius (mm)',
                  angle: -90,
                  position: 'insideLeft',
                  fill: 'var(--color-text-secondary)'
                }}
              />

              <Tooltip content={<CustomTooltip />} />

              {/* Stainless Steel (outermost) - Upper */}
              <Area
                type="monotone"
                dataKey="R_stainless_upper"
                stroke="#6b7280"
                fill="#6b7280"
                fillOpacity={0.3}
                strokeWidth={1.5}
                name="Stainless Steel"
              />

              {/* Graphite (throat region) - Upper */}
              <Area
                type="monotone"
                dataKey="R_graphite_upper"
                stroke="#1a1a1a"
                fill="#1a1a1a"
                fillOpacity={0.5}
                strokeWidth={1.5}
                name="Graphite Insert"
              />

              {/* Ablative (chamber region) - Upper */}
              <Area
                type="monotone"
                dataKey="R_ablative_upper"
                stroke="#8b4513"
                fill="#8b4513"
                fillOpacity={0.4}
                strokeWidth={1.5}
                name="Ablative Liner"
              />

              {/* Gas Boundary - Upper */}
              <Area
                type="monotone"
                dataKey="R_gas_upper"
                stroke="#ff6b35"
                fill="#ff6b35"
                fillOpacity={0.2}
                strokeWidth={2}
                name="Gas Boundary"
              />

              {/* Lower half (symmetric) */}
              {showLowerHalf && (
                <>
                  <Area
                    type="monotone"
                    dataKey="R_stainless_lower"
                    stroke="#6b7280"
                    fill="#6b7280"
                    fillOpacity={0.3}
                    strokeWidth={1.5}
                    legendType="none"
                  />
                  <Area
                    type="monotone"
                    dataKey="R_graphite_lower"
                    stroke="#1a1a1a"
                    fill="#1a1a1a"
                    fillOpacity={0.5}
                    strokeWidth={1.5}
                    legendType="none"
                  />
                  <Area
                    type="monotone"
                    dataKey="R_ablative_lower"
                    stroke="#8b4513"
                    fill="#8b4513"
                    fillOpacity={0.4}
                    strokeWidth={1.5}
                    legendType="none"
                  />
                  <Area
                    type="monotone"
                    dataKey="R_gas_lower"
                    stroke="#ff6b35"
                    fill="#ff6b35"
                    fillOpacity={0.2}
                    strokeWidth={2}
                    legendType="none"
                  />
                </>
              )}

              {/* Throat position reference line */}
              {dimensions && (
                <ReferenceLine
                  x={dimensions.throat_position_mm}
                  stroke="#ef4444"
                  strokeWidth={2}
                  strokeDasharray="5 5"
                  label={{
                    value: 'Throat',
                    position: 'top',
                    fill: '#ef4444',
                    fontSize: 11,
                  }}
                />
              )}

              {/* Centerline */}
              <ReferenceLine
                y={0}
                stroke="var(--color-text-secondary)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />

              <Legend
                verticalAlign="top"
                height={36}
                wrapperStyle={{ paddingBottom: '10px' }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Thermal Thickness Graphic (Layer 3) */}
      <ChamberThermalGraphic
        geometry={geometry}
        showLowerHalf={showLowerHalf}
        onShowLowerHalfChange={setShowLowerHalf}
      />

      {/* CEA-Solved Chamber Contour */}
      <ChamberContourPlot geometry={geometry} />

      {/* Dimensions Table */}
      {geometry && dimensions && (
        <div className="p-5 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-4">
            Chamber Dimensions
          </h4>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Chamber Length</p>
              <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                {dimensions.L_chamber_mm.toFixed(1)} mm
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Nozzle Length</p>
              <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                {dimensions.L_nozzle_mm.toFixed(1)} mm
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Chamber Diameter</p>
              <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                {dimensions.D_chamber_mm.toFixed(1)} mm
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Throat Diameter</p>
              <p className="text-lg font-semibold text-rose-400">
                {dimensions.D_throat_mm.toFixed(1)} mm
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Exit Diameter</p>
              <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                {dimensions.D_exit_mm.toFixed(1)} mm
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Expansion Ratio</p>
              <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                {geometry.expansion_ratio.toFixed(2)}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Ablative Cooling</p>
              <p className={`text-lg font-semibold ${geometry.ablative_enabled ? 'text-green-400' : 'text-gray-500'}`}>
                {geometry.ablative_enabled ? 'Enabled' : 'Disabled'}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Graphite Insert</p>
              <p className={`text-lg font-semibold ${geometry.graphite_enabled ? 'text-green-400' : 'text-gray-500'}`}>
                {geometry.graphite_enabled ? 'Enabled' : 'Disabled'}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
              <p className="text-xs text-[var(--color-text-secondary)]">Nozzle Type</p>
              <p className="text-lg font-semibold text-blue-400">
                {geometry.nozzle_method.includes('rao') ? 'Rao Bell (80%)' : 'Conical'}
              </p>
            </div>

            {geometry.Cf !== null && (
              <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)]">Thrust Coeff (Cf)</p>
                <p className="text-lg font-semibold text-emerald-400">
                  {geometry.Cf.toFixed(4)}
                </p>
              </div>
            )}

            {geometry.Cf_ideal !== null && (
              <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)]">Cf Ideal (CEA)</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {geometry.Cf_ideal.toFixed(4)}
                </p>
              </div>
            )}

            {geometry.A_throat_solved !== null && (
              <div className="p-3 rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)]">
                <p className="text-xs text-[var(--color-text-secondary)]">A_throat (solved)</p>
                <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                  {(geometry.A_throat_solved * 1e6).toFixed(2)} mm²
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Legend explanation */}
      {geometry && (
        <div className="p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">
            Structure Legend
          </h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: '#ff6b35', opacity: 0.6 }} />
              <span className="text-[var(--color-text-secondary)]">
                <span className="text-orange-400 font-medium">Gas Boundary</span> — Hot combustion gas
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: '#8b4513', opacity: 0.6 }} />
              <span className="text-[var(--color-text-secondary)]">
                <span className="text-amber-600 font-medium">Ablative</span> — Chamber liner
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: '#1a1a1a', opacity: 0.7 }} />
              <span className="text-[var(--color-text-secondary)]">
                <span className="text-gray-400 font-medium">Graphite</span> — Throat insert
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded" style={{ backgroundColor: '#6b7280', opacity: 0.5 }} />
              <span className="text-[var(--color-text-secondary)]">
                <span className="text-gray-500 font-medium">Stainless</span> — Outer case
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {isLoading && !geometry && (
        <div className="flex items-center justify-center h-64">
          <div className="text-center">
            <div className="w-12 h-12 border-4 border-rose-600 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
            <p className="text-[var(--color-text-secondary)]">Loading chamber geometry...</p>
          </div>
        </div>
      )}
    </div>
  );
}

