import { useMemo, useState, useEffect, useRef } from 'react';
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import type { ChamberGeometryResponse } from '../api/client';

interface ChamberThermalGraphicProps {
  geometry: ChamberGeometryResponse | null;
  showLowerHalf?: boolean;
  onShowLowerHalfChange?: (show: boolean) => void;
  className?: string;
  title?: string;
}

const M_TO_MM = 1000;
const MM_TO_INCH = 1 / 25.4;

// Helper functions copied (and simplified for mm-only) from ChamberContourPlot to keep
// axis/scaling behavior identical across plots.
function getNiceStep(range: number): number {
  const magnitude = Math.floor(Math.log10(range));
  const normalized = range / Math.pow(10, magnitude);

  let step: number;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;

  return step * Math.pow(10, magnitude);
}

function makeNiceDomain(min: number, max: number, includeZero: boolean = true): [number, number] {
  let range = max - min;

  if (includeZero) {
    if (min > 0) {
      range = max;
      min = 0;
    } else if (max < 0) {
      range = Math.abs(min);
      max = 0;
    } else {
      range = Math.max(Math.abs(min), Math.abs(max)) * 2;
      min = -range / 2;
      max = range / 2;
    }
  }

  const step = getNiceStep(range / 8);
  const domainMin = Math.floor(min / step) * step;
  const domainMax = Math.ceil(max / step) * step;

  let finalMin = domainMin;
  let finalMax = domainMax;
  if (includeZero) {
    if (finalMin > 0) finalMin = 0;
    if (finalMax < 0) finalMax = 0;
  }

  if (finalMin >= finalMax) {
    const absMax = Math.max(Math.abs(finalMin), Math.abs(finalMax));
    finalMin = -absMax;
    finalMax = absMax;
  }

  return [finalMin, finalMax];
}

function generateTicks(min: number, max: number, interval: number): number[] {
  const ticks: number[] = [];
  const start = Math.ceil(min / interval) * interval;
  const end = Math.floor(max / interval) * interval;
  for (let value = start; value <= end; value += interval) {
    ticks.push(value);
  }
  return ticks;
}

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

export function ChamberThermalGraphic({
  geometry,
  showLowerHalf: showLowerHalfProp,
  onShowLowerHalfChange,
  className = "",
  title = "Chamber Thermal Structure"
}: ChamberThermalGraphicProps) {
  const [showLowerHalfUncontrolled, setShowLowerHalfUncontrolled] = useState(true);
  const [unit, setUnit] = useState<'mm' | 'inch'>('mm');

  const showLowerHalf = showLowerHalfProp ?? showLowerHalfUncontrolled;
  const setShowLowerHalf = (next: boolean) => {
    onShowLowerHalfChange?.(next);
    if (showLowerHalfProp === undefined) {
      setShowLowerHalfUncontrolled(next);
    }
  };
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 1000, height: 400 });

  // Measure container for aspect ratio
  useEffect(() => {
    if (!containerRef.current) return;
    const updateSize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(containerRef.current);
    window.addEventListener('resize', updateSize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, []);

  const chartData = useMemo(() => {
    if (!geometry) return [];

    const unitMultiplier = unit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;

    const hasChamberContour =
      Array.isArray(geometry.chamber_contour_x) &&
      Array.isArray(geometry.chamber_contour_y) &&
      geometry.chamber_contour_x.length > 1 &&
      geometry.chamber_contour_y.length === geometry.chamber_contour_x.length;

    // Helper: linear interpolation y(x) for monotonic-ish x arrays
    const lerpAt = (xs: number[], ys: number[], x: number): number => {
      if (xs.length === 0) return 0;
      if (x <= xs[0]) return ys[0];
      if (x >= xs[xs.length - 1]) return ys[ys.length - 1];

      // Binary search for upper index
      let lo = 0;
      let hi = xs.length - 1;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (xs[mid] <= x) lo = mid;
        else hi = mid;
      }

      const x0 = xs[lo];
      const x1 = xs[hi];
      const y0 = ys[lo];
      const y1 = ys[hi];
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    };

    // Thickness profiles defined on geometry.positions grid (meters)
    const pos_m = geometry.positions;
    const tAbl_m = geometry.R_ablative_outer.map((r, i) => Math.max(0, r - geometry.R_gas[i]));
    const tGra_m = geometry.R_graphite_outer.map((r, i) => Math.max(0, r - geometry.R_gas[i]));
    const tTotal_m = geometry.R_stainless.map((r, i) => Math.max(0, r - geometry.R_gas[i]));

    const data: Array<{
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
    }> = [];

    if (hasChamberContour) {
      // Use chamber contour as the gas boundary curve (identical to ChamberContourPlot).
      for (let i = 0; i < geometry.chamber_contour_x.length; i++) {
        const x_m = geometry.chamber_contour_x[i];
        const rGas_m = geometry.chamber_contour_y[i];

        const x = x_m * unitMultiplier;
        const rGas = rGas_m * unitMultiplier;

        // Interpolate thickness profiles onto the contour x-grid
        const inChamberRegion = x_m <= geometry.throat_position;
        const tAblHere_m = inChamberRegion ? lerpAt(pos_m, tAbl_m, x_m) : 0.0;
        const tGraHere_m = lerpAt(pos_m, tGra_m, x_m);
        const tTotalHere_m = lerpAt(pos_m, tTotal_m, x_m);

        const isGraphiteRegion = x_m >= geometry.graphite_start && x_m <= geometry.graphite_end;

        const rAblative = rGas + tAblHere_m * unitMultiplier;
        const rGraphite = rGas + (isGraphiteRegion ? tGraHere_m * unitMultiplier : 0);
        const rStainless = rGas + tTotalHere_m * unitMultiplier;

        data.push({
          x,
          // Upper
          rGas_upper: rGas,
          rAblative_upper: rAblative,
          rGraphite_upper: isGraphiteRegion ? rGraphite : rGas,
          rStainless_upper: rStainless,
          // Lower
          rGas_lower: showLowerHalf ? -rGas : 0,
          rAblative_lower: showLowerHalf ? -rAblative : 0,
          rGraphite_lower: showLowerHalf ? (isGraphiteRegion ? -rGraphite : -rGas) : 0,
          rStainless_lower: showLowerHalf ? -rStainless : 0,
          // Thicknesses for tooltip
          tAbl: (rAblative - rGas).toFixed(2),
          tGra: isGraphiteRegion ? (rGraphite - rGas).toFixed(2) : "0.00",
          tTotal: (rStainless - rGas).toFixed(2),
          isGraphiteRegion,
        });
      }
    } else {
      // Fallback: derive gas boundary from layer geometry arrays
      const n = geometry.positions.length;
      for (let i = 0; i < n; i++) {
        const pos = geometry.positions[i];
        const x = pos * unitMultiplier;
        const rGas = geometry.R_gas[i] * unitMultiplier;

        const inChamberRegion = pos <= geometry.throat_position;
        const rAblative = inChamberRegion ? geometry.R_ablative_outer[i] * unitMultiplier : rGas;
        const rGraphite = geometry.R_graphite_outer[i] * unitMultiplier;
        const rStainless = geometry.R_stainless[i] * unitMultiplier;

        const isGraphiteRegion = pos >= geometry.graphite_start && pos <= geometry.graphite_end;

        data.push({
          x,
          // Upper
          rGas_upper: rGas,
          rAblative_upper: rAblative,
          rGraphite_upper: isGraphiteRegion ? rGraphite : rGas,
          rStainless_upper: rStainless,
          // Lower
          rGas_lower: showLowerHalf ? -rGas : 0,
          rAblative_lower: showLowerHalf ? -rAblative : 0,
          rGraphite_lower: showLowerHalf ? (isGraphiteRegion ? -rGraphite : -rGas) : 0,
          rStainless_lower: showLowerHalf ? -rStainless : 0,
          // Thicknesses for tooltip
          tAbl: (rAblative - rGas).toFixed(2),
          tGra: isGraphiteRegion ? (rGraphite - rGas).toFixed(2) : "0.00",
          tTotal: (rStainless - rGas).toFixed(2),
          isGraphiteRegion,
        });
      }
    }

    return data;
  }, [geometry, showLowerHalf, unit]);

  // Scale logic similar to ChamberContourPlot for 1:1 aspect ratio
  const domains = useMemo(() => {
    if (!geometry) {
      return {
        xDomain: ['dataMin', 'dataMax'] as [string, string],
        yDomain: ['auto', 'auto'] as [string, string],
        xTicks: [] as number[],
        yTicks: [] as number[],
      };
    }

    // Prefer chamber contour for scale (to match ChamberContourPlot), fall back to stainless radius.
    const hasChamberContour =
      Array.isArray(geometry.chamber_contour_x) &&
      Array.isArray(geometry.chamber_contour_y) &&
      geometry.chamber_contour_x.length > 1 &&
      geometry.chamber_contour_y.length === geometry.chamber_contour_x.length;

    const xValues_m = hasChamberContour ? geometry.chamber_contour_x : geometry.positions;
    const yValues_m = hasChamberContour ? geometry.chamber_contour_y : geometry.R_stainless;

    const xMin_m = Math.min(...xValues_m);
    const xMax_m = Math.max(...xValues_m);
    const yMax_m = Math.max(...yValues_m);
    const yMin_m = -yMax_m; // symmetric around centerline

    const xRange_m = xMax_m - xMin_m;
    const yRange_m = yMax_m - yMin_m;

    const unitMultiplier = unit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;

    const xMin = xMin_m * unitMultiplier;
    const xMax = xMax_m * unitMultiplier;
    const yMin = yMin_m * unitMultiplier;
    const yMax = yMax_m * unitMultiplier;

    const effectiveWidth = containerSize.width > 0 ? containerSize.width : 1000;
    const effectiveHeight = containerSize.height > 0 ? containerSize.height : 400;
    const plotWidth = effectiveWidth - 20 - 30;
    const plotHeight = effectiveHeight - 10 - 20;

    if (plotWidth <= 0 || plotHeight <= 0) {
      const tickInterval = unit === 'mm' ? 10 : 1;
      return {
        xDomain: [xMin, xMax] as [number, number],
        yDomain: [yMin, yMax] as [number, number],
        xTicks: generateTicks(xMin, xMax, tickInterval),
        yTicks: generateTicks(yMin, yMax, tickInterval),
      };
    }

    const plotAspectRatio = plotWidth / plotHeight;
    const dataAspectRatio_m = xRange_m / yRange_m;

    let xDomain_m: [number, number] = [xMin_m, xMax_m];
    let yDomain_m: [number, number] = [yMin_m, yMax_m];

    if (dataAspectRatio_m > plotAspectRatio) {
      const targetYRange_m = xRange_m / plotAspectRatio;
      const yCenter_m = (yMin_m + yMax_m) / 2;
      yDomain_m = [yCenter_m - targetYRange_m / 2, yCenter_m + targetYRange_m / 2];
    } else {
      const targetXRange_m = yRange_m * plotAspectRatio;
      const xCenter_m = (xMin_m + xMax_m) / 2;
      xDomain_m = [xCenter_m - targetXRange_m / 2, xCenter_m + targetXRange_m / 2];
    }

    // Padding (5% in metric units)
    const padding_m = Math.max(xDomain_m[1] - xDomain_m[0], yDomain_m[1] - yDomain_m[0]) * 0.05;
    xDomain_m = [xDomain_m[0] - padding_m, xDomain_m[1] + padding_m];
    yDomain_m = [yDomain_m[0] - padding_m, yDomain_m[1] + padding_m];

    // Nice rounding (same approach as ChamberContourPlot)
    const xIncludesZero_m = xDomain_m[0] <= 0 && xDomain_m[1] >= 0;
    xDomain_m = makeNiceDomain(xDomain_m[0], xDomain_m[1], xIncludesZero_m);
    yDomain_m = makeNiceDomain(yDomain_m[0], yDomain_m[1], true);

    // Convert final domains to display units
    const xDomain: [number, number] = [xDomain_m[0] * unitMultiplier, xDomain_m[1] * unitMultiplier];
    const yDomain: [number, number] = [yDomain_m[0] * unitMultiplier, yDomain_m[1] * unitMultiplier];

    const tickInterval = unit === 'mm' ? 10 : 1;
    const xTicks = generateTicks(xDomain[0], xDomain[1], tickInterval);
    const yTicks = generateTicks(yDomain[0], yDomain[1], tickInterval);

    return { xDomain, yDomain, xTicks, yTicks };
    // Note: showLowerHalf is intentionally NOT in the dependency array here;
    // we always keep the same scale when toggling full view, just like ChamberContourPlot.
  }, [geometry, containerSize, unit]);

  if (!geometry) return null;

  return (
    <div ref={containerRef} className={`p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${className}`}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{title}</h4>
          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
            Physical contour with optimized thermal protection layers
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

      <ResponsiveContainer width="100%" height={350}>
        <ComposedChart data={chartData} margin={{ top: 10, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.2} />
          <XAxis
            dataKey="x"
            type="number"
            domain={domains.xDomain}
            ticks={domains.xTicks}
            stroke="var(--color-text-secondary)"
            tick={{ fontSize: 10 }}
            tickFormatter={(value) => formatTick(value, unit)}
            label={{
              value: `Axial Position (${unit})`,
              position: 'insideBottom',
              offset: -10,
              fontSize: 11,
              fill: 'var(--color-text-secondary)',
            }}
          />
          <YAxis
            type="number"
            domain={domains.yDomain}
            ticks={domains.yTicks}
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
          <Area type="monotone" dataKey="rStainless_upper" stroke="none" fill="#6b7280" fillOpacity={0.2} name="Stainless Case" />
          <Area type="monotone" dataKey="rGraphite_upper" stroke="none" fill="#1a1a1a" fillOpacity={0.6} name="Graphite Insert" />
          <Area type="monotone" dataKey="rAblative_upper" stroke="none" fill="#8b4513" fillOpacity={0.4} name="Ablative Liner" />
          <Area type="monotone" dataKey="rGas_upper" stroke="none" fill="var(--color-bg-secondary)" fillOpacity={1} />
          
          {/* Inner Contour Line */}
          <Line type="monotone" dataKey="rGas_upper" stroke="#f97316" strokeWidth={2} dot={false} name="Gas Boundary" />

          {/* Lower Half */}
          {showLowerHalf && (
            <>
              <Area type="monotone" dataKey="rStainless_lower" stroke="none" fill="#6b7280" fillOpacity={0.2} />
              <Area type="monotone" dataKey="rGraphite_lower" stroke="none" fill="#1a1a1a" fillOpacity={0.6} />
              <Area type="monotone" dataKey="rAblative_lower" stroke="none" fill="#8b4513" fillOpacity={0.4} />
              <Area type="monotone" dataKey="rGas_lower" stroke="none" fill="var(--color-bg-secondary)" fillOpacity={1} />
              <Line type="monotone" dataKey="rGas_lower" stroke="#f97316" strokeWidth={2} dot={false} />
            </>
          )}

          <ReferenceLine y={0} stroke="var(--color-text-secondary)" strokeDasharray="3 3" opacity={0.5} />
          <Legend verticalAlign="top" height={36} iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

