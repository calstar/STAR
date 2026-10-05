import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from 'recharts';
import type { ChamberGeometryResponse } from '../api/client';
import { useViewState } from '../lib/viewState';
import { CONTOUR_FRAME } from '../lib/contourScale';
import { useTrueScale } from '../lib/useTrueScale';

interface ChamberThermalGraphicProps {
  geometry: ChamberGeometryResponse | null;
  showLowerHalf?: boolean;
  onShowLowerHalfChange?: (show: boolean) => void;
  className?: string;
  title?: string;
}

const M_TO_MM = 1000;
const MM_TO_INCH = 1 / 25.4;

function formatTick(value: number, unit: 'mm' | 'inch'): string {
  if (Math.abs(value) < 1e-10) return '0';

  const absValue = Math.abs(value);

  if (unit === 'inch') {
    if (absValue % 1 === 0) return value.toFixed(0);
    if (absValue < 0.1) return value.toFixed(3);
    if (absValue < 1) return value.toFixed(2);
    return value.toFixed(1);
  }

  if (absValue % 1 === 0) return value.toFixed(0);
  if (absValue < 1) return value.toFixed(2);
  if (absValue < 10) return value.toFixed(1);
  return value.toFixed(0);
}

export interface ThermalSectionPoint {
  x: number;
  rGas_upper: number;
  rAblative_upper: number;
  rGraphite_upper: number;
  rStainless_upper: number;
  rGas_lower: number;
  rAblative_lower: number;
  rGraphite_lower: number;
  rStainless_lower: number;
  tAbl: string;
  tGra: string;
  tTotal: string;
  isGraphiteRegion: boolean;
}

/**
 * The to-scale section, drawn on the solved gas contour (throat at x = 0).
 *
 * The layer arrays (positions, R_*) and throat_position / graphite_start / graphite_end come
 * in a different frame -- face at 0, throat at throat_position -- on a cylinder-to-throat
 * profile, so they give only thicknesses and the insert's extent about the throat, never
 * positions. The case is the barrel's outer radius, constant; the liner stops at the insert
 * (or the throat) and continues down the nozzle only when the nozzle is declared ablative.
 */
export function buildThermalSection(
  geometry: ChamberGeometryResponse & { nozzle_ablative?: boolean },
  unitMultiplier: number,
  showLowerHalf: boolean,
): ThermalSectionPoint[] {
  const point = (x_m: number, rGas_m: number, tAbl_m: number, tGra_m: number, rCase_m: number): ThermalSectionPoint => {
    const rGas = rGas_m * unitMultiplier;
    const rAbl = Math.min(rGas_m + tAbl_m, rCase_m) * unitMultiplier;
    const rGra = Math.min(rGas_m + tGra_m, rCase_m) * unitMultiplier;
    const rCase = rCase_m * unitMultiplier;
    const isGraphiteRegion = tGra_m > 0;
    return {
      x: x_m * unitMultiplier,
      rGas_upper: rGas,
      rAblative_upper: rAbl,
      rGraphite_upper: isGraphiteRegion ? rGra : rGas,
      rStainless_upper: rCase,
      rGas_lower: showLowerHalf ? -rGas : 0,
      rAblative_lower: showLowerHalf ? -rAbl : 0,
      rGraphite_lower: showLowerHalf ? (isGraphiteRegion ? -rGra : -rGas) : 0,
      rStainless_lower: showLowerHalf ? -rCase : 0,
      tAbl: (rAbl - rGas).toFixed(2),
      tGra: isGraphiteRegion ? (rGra - rGas).toFixed(2) : '0.00',
      tTotal: (rCase - rGas).toFixed(2),
      isGraphiteRegion,
    };
  };

  // Thicknesses from the layer arrays, at the barrel (first station) and in the insert.
  const n = geometry.positions?.length ?? 0;
  const tAbl_m = n > 0 && geometry.ablative_enabled ? Math.max(0, geometry.R_ablative_outer[0] - geometry.R_gas[0]) : 0;
  let tGra_m = 0;
  for (let i = 0; i < n; i++) {
    const p = geometry.positions[i];
    if (p >= geometry.graphite_start && p <= geometry.graphite_end) {
      tGra_m = Math.max(tGra_m, geometry.R_graphite_outer[i] - geometry.R_gas[i]);
    }
  }
  if (!geometry.graphite_enabled) tGra_m = 0;
  const rCase_m = n > 0 ? geometry.R_stainless[0] : 0;
  const upstreamHalf = geometry.throat_position - geometry.graphite_start;
  const downstreamHalf = geometry.graphite_end - geometry.throat_position;
  const nozzleAblative = geometry.nozzle_ablative === true;

  const cx = geometry.chamber_contour_x ?? [];
  const cy = geometry.chamber_contour_y ?? [];
  if (cx.length > 1 && cy.length === cx.length) {
    let iT = 0;
    for (let i = 1; i < cy.length; i++) if (cy[i] < cy[iT]) iT = i;
    const xT = cx[iT];
    const g0 = xT - upstreamHalf;
    const g1 = xT + downstreamHalf;
    const linerEnd = tGra_m > 0 ? g0 : xT;
    return cx.map((x_m, i) => {
      const inInsert = tGra_m > 0 && x_m >= g0 && x_m <= g1;
      const lined = !inInsert && (x_m <= linerEnd || nozzleAblative);
      return point(x_m, cy[i], lined ? tAbl_m : 0, inInsert ? tGra_m : 0, rCase_m);
    });
  }
  // No solved contour: the layer arrays, in their own (face) frame.
  return geometry.positions.map((p, i) => {
    const inInsert = tGra_m > 0 && p >= geometry.graphite_start && p <= geometry.graphite_end;
    const lined = !inInsert && (p <= geometry.throat_position || nozzleAblative);
    return point(p, geometry.R_gas[i], lined ? tAbl_m : 0, inInsert ? tGra_m : 0, rCase_m);
  });
}

export function ChamberThermalGraphic({
  geometry,
  showLowerHalf: showLowerHalfProp,
  onShowLowerHalfChange,
  className = "",
  title = "Chamber Cross-Section"
}: ChamberThermalGraphicProps) {
  const [showLowerHalfUncontrolled, setShowLowerHalfUncontrolled] = useViewState('chamberThermal.fullSection', false);
  const [unit, setUnit] = useState<'mm' | 'inch'>('mm');

  const showLowerHalf = showLowerHalfProp ?? showLowerHalfUncontrolled;
  const setShowLowerHalf = (next: boolean) => {
    onShowLowerHalfChange?.(next);
    if (showLowerHalfProp === undefined) {
      setShowLowerHalfUncontrolled(next);
    }
  };
  const chartData = useMemo(() => {
    if (!geometry) return [];
    const unitMultiplier = unit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;
    return buildThermalSection(geometry, unitMultiplier, showLowerHalf);
  }, [geometry, showLowerHalf, unit]);

  // True scale over everything drawn: the chart's height follows from its width
  // (lib/contourScale), so 1 mm is the same on both axes.
  const xsAll = chartData.map((d) => d.x);
  // The solved contour is drawn with the throat at 0; the fallback layer arrays are not.
  const throatX = geometry && geometry.chamber_contour_x?.length > 1
    ? 0 : (geometry?.throat_position ?? 0) * (unit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH);
  const { ref: chartRef, width: chartWidth, layout } = useTrueScale(
    Math.min(...xsAll), Math.max(...xsAll), Math.max(0, ...chartData.map((d) => d.rStainless_upper)), showLowerHalf);

  if (!geometry) return null;

  return (
    <div className={`p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            Solved gas-side contour, face to exit, with liner, graphite insert and case. To scale.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-[var(--color-bg-primary)] rounded-lg border border-[var(--color-border)] p-1">
            <button
              onClick={() => setUnit('mm')}
              className={`px-3 py-1 text-xs font-medium rounded transition-all ${
                unit === 'mm'
                  ? 'bg-rose-600 text-white'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              mm
            </button>
            <button
              onClick={() => setUnit('inch')}
              className={`px-3 py-1 text-xs font-medium rounded transition-all ${
                unit === 'inch'
                  ? 'bg-rose-600 text-white'
                  : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
              }`}
            >
              in
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={showLowerHalf}
              onChange={(e) => setShowLowerHalf(e.target.checked)}
              className="w-3.5 h-3.5 rounded border-[var(--color-border)] text-rose-600 focus:ring-rose-500"
            />
            Full View
          </label>
          {(geometry.t_abl_opt_mm || geometry.t_gra_opt_mm) && (
            <div className="flex gap-2">
              {geometry.t_abl_opt_mm && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">
                  Abl: {geometry.t_abl_opt_mm.toFixed(2)}mm
                </span>
              )}
              {geometry.t_gra_opt_mm && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/10 text-gray-400 border border-gray-500/20">
                  Gra: {geometry.t_gra_opt_mm.toFixed(2)}mm
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-4 mb-2 text-[11px] text-[var(--color-text-secondary)]">
        {([['#6b7280', 'Stainless case'], ['#1a1a1a', 'Graphite insert'], ['#8b4513', 'Ablative liner'], ['#f97316', 'Gas boundary']] as const).map(([c, l]) => (
          <span key={l} className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: c }} />{l}</span>
        ))}
      </div>
      <div ref={chartRef} className="w-full">
        {chartWidth > 0 && layout && (
        <ComposedChart width={layout.width} height={layout.height} data={chartData}
          margin={{ top: CONTOUR_FRAME.top, right: CONTOUR_FRAME.right, left: CONTOUR_FRAME.left, bottom: CONTOUR_FRAME.bottom }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.2} />
          <XAxis
            dataKey="x"
            type="number"
            domain={layout.xDomain}
            ticks={layout.xTicks}
                interval={0}
            allowDataOverflow
            height={CONTOUR_FRAME.xAxis}
            stroke="var(--color-text-secondary)"
            tick={{ fontSize: 10 }}
            tickFormatter={(value) => formatTick(value, unit)}
            label={{
              value: `Axial Position (${unit})`,
              position: 'insideBottom',
              offset: 0,
              fontSize: 11,
              fill: 'var(--color-text-secondary)',
            }}
          />
          <YAxis
            type="number"
            domain={layout.yDomain}
            ticks={layout.yTicks}
                interval={0}
            allowDataOverflow
            width={CONTOUR_FRAME.yAxis}
            stroke="var(--color-text-secondary)"
            tick={{ fontSize: 10 }}
            tickFormatter={(value) => formatTick(value, unit)}
            label={{
              value: `Radius (${unit})`,
              angle: -90,
              position: 'insideLeft',
              fontSize: 11,
              fill: 'var(--color-text-secondary)',
            }}
          />
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || !payload.length) return null;
              const d = payload[0].payload as (typeof chartData)[number];
              return (
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-2 shadow-xl text-xs">
                  <p className="font-medium text-[var(--color-text-primary)] mb-1">
                    Pos: {formatTick(Number(label), unit)} {unit}
                  </p>
                  <div className="space-y-0.5">
                    <p className="text-orange-400">
                      Gas Radius: {formatTick(Number(d.rGas_upper), unit)} {unit}
                    </p>
                    <p className="text-amber-600">
                      Ablative Thickness: {d.tAbl} {unit}
                    </p>
                    {d.isGraphiteRegion && Number(d.tGra) > 0 && (
                      <p className="text-gray-400">
                        Graphite Thickness: {d.tGra} {unit}
                      </p>
                    )}
                    <p className="text-gray-500">
                      Total Wall: {d.tTotal} {unit}
                    </p>
                  </div>
                </div>
              );
            }}
          />
          
          {/* Structural Layers - Upper */}
          <Area isAnimationActive={false} type="monotone" dataKey="rStainless_upper" stroke="none" fill="#6b7280" fillOpacity={0.2} name="Stainless Case" />
          <Area isAnimationActive={false} type="monotone" dataKey="rGraphite_upper" stroke="none" fill="#1a1a1a" fillOpacity={0.6} name="Graphite Insert" />
          <Area isAnimationActive={false} type="monotone" dataKey="rAblative_upper" stroke="none" fill="#8b4513" fillOpacity={0.4} name="Ablative Liner" />
          <Area isAnimationActive={false} type="monotone" dataKey="rGas_upper" stroke="none" fill="var(--color-bg-secondary)" fillOpacity={1} />
          
          {/* Inner Contour Line */}
          <Line isAnimationActive={false} type="monotone" dataKey="rGas_upper" stroke="#f97316" strokeWidth={2} dot={false} name="Gas Boundary" />

          {/* Lower Half */}
          {/* Lower half: one conditional per series -- recharts ignores series inside a fragment. */}
          {showLowerHalf && (
            <Area isAnimationActive={false} type="monotone" dataKey="rStainless_lower" stroke="none" fill="#6b7280" fillOpacity={0.2} />
          )}
          {showLowerHalf && (
            <Area isAnimationActive={false} type="monotone" dataKey="rGraphite_lower" stroke="none" fill="#1a1a1a" fillOpacity={0.6} />
          )}
          {showLowerHalf && (
            <Area isAnimationActive={false} type="monotone" dataKey="rAblative_lower" stroke="none" fill="#8b4513" fillOpacity={0.4} />
          )}
          {showLowerHalf && (
            <Area isAnimationActive={false} type="monotone" dataKey="rGas_lower" stroke="none" fill="var(--color-bg-secondary)" fillOpacity={1} />
          )}
          {showLowerHalf && (
            <Line isAnimationActive={false} type="monotone" dataKey="rGas_lower" stroke="#f97316" strokeWidth={2} dot={false} />
          )}

          <ReferenceLine y={0} stroke="var(--color-text-secondary)" strokeDasharray="3 3" opacity={0.5} />
          <ReferenceLine x={throatX} stroke="#ef4444" strokeDasharray="5 5" opacity={0.8}
            label={{ value: 'Throat', position: 'top', fill: '#ef4444', fontSize: 11 }} />
        </ComposedChart>
        )}
      </div>
    </div>
  );
}

