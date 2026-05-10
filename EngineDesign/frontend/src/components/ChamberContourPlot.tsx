import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  ComposedChart,
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

// Convert m to mm for display
const M_TO_MM = 1000;
const MM_TO_INCH = 1 / 25.4;

// Generate a minimal DXF file with a single contour polyline
// Exports the upper half contour only (for CAD revolve operations)
// With proper vertex deduplication, simplification, and coordinate quantization
function generateDxfContent(xCoords: number[], yCoords: number[], unit: 'mm' | 'inch'): string {
  // Convert coordinates to selected unit
  const unitMultiplier = unit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;

  // Create points with unit conversion and proper precision
  const PRECISION = 6;  // 6 decimal places for CAD compatibility
  const EPSILON = 1e-9; // Threshold for duplicate vertex detection
  const TARGET_POINTS = 150; // Target number of points for CAD performance

  // Build upper half contour only (this is what CAD software revolves)
  const rawPoints: { x: number; y: number }[] = [];
  for (let i = 0; i < xCoords.length; i++) {
    rawPoints.push({
      x: Number((xCoords[i] * unitMultiplier).toFixed(PRECISION)),
      y: Number((yCoords[i] * unitMultiplier).toFixed(PRECISION))
    });
  }

  // Deduplicate consecutive vertices (removes zero-length segments)
  let points: { x: number; y: number }[] = [];
  for (const pt of rawPoints) {
    if (points.length === 0) {
      points.push(pt);
    } else {
      const last = points[points.length - 1];
      const dx = Math.abs(pt.x - last.x);
      const dy = Math.abs(pt.y - last.y);
      // Only add if not a duplicate (distance > epsilon)
      if (dx > EPSILON || dy > EPSILON) {
        points.push(pt);
      }
    }
  }

  // Ramer-Douglas-Peucker line simplification algorithm
  // Reduces vertices while preserving contour shape
  function perpendicularDistance(
    point: { x: number; y: number },
    lineStart: { x: number; y: number },
    lineEnd: { x: number; y: number }
  ): number {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    const lineLengthSq = dx * dx + dy * dy;

    if (lineLengthSq === 0) {
      // Line start and end are the same point
      return Math.sqrt((point.x - lineStart.x) ** 2 + (point.y - lineStart.y) ** 2);
    }

    // Calculate perpendicular distance using cross product
    const t = Math.abs(dy * point.x - dx * point.y + lineEnd.x * lineStart.y - lineEnd.y * lineStart.x);
    return t / Math.sqrt(lineLengthSq);
  }

  function douglasPeucker(
    pts: { x: number; y: number }[],
    tolerance: number
  ): { x: number; y: number }[] {
    if (pts.length <= 2) return pts;

    // Find the point with maximum distance from the line
    let maxDist = 0;
    let maxIdx = 0;
    const first = pts[0];
    const last = pts[pts.length - 1];

    for (let i = 1; i < pts.length - 1; i++) {
      const dist = perpendicularDistance(pts[i], first, last);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }

    // If max distance is greater than tolerance, recursively simplify
    if (maxDist > tolerance) {
      const left = douglasPeucker(pts.slice(0, maxIdx + 1), tolerance);
      const right = douglasPeucker(pts.slice(maxIdx), tolerance);
      return [...left.slice(0, -1), ...right];
    } else {
      // Return just the endpoints
      return [first, last];
    }
  }

  // Apply simplification if we have too many points
  if (points.length > TARGET_POINTS) {
    // Calculate initial tolerance based on geometry size
    const xRange = Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x));
    const yRange = Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y));
    const size = Math.max(xRange, yRange);

    // Start with a small tolerance and increase until we hit target
    let tolerance = size * 0.0001;
    let simplified = douglasPeucker(points, tolerance);

    // Iteratively increase tolerance until we're at or below target
    while (simplified.length > TARGET_POINTS && tolerance < size * 0.1) {
      tolerance *= 1.5;
      simplified = douglasPeucker(points, tolerance);
    }

    points = simplified;
  }

  // DXF R12 (AC1009) - Most universally compatible format
  // R12 doesn't require BLOCKS, OBJECTS, or CLASSES sections
  const header = `0
SECTION
2
HEADER
9
$ACADVER
1
AC1009
9
$INSUNITS
70
${unit === 'mm' ? '4' : '1'}
0
ENDSEC
`;

  // Minimal TABLES section for R12
  const tables = `0
SECTION
2
TABLES
0
TABLE
2
LTYPE
70
1
0
LTYPE
2
CONTINUOUS
70
0
3
Solid line
72
65
73
0
40
0.0
0
ENDTAB
0
TABLE
2
LAYER
70
3
0
LAYER
2
0
70
0
62
7
6
CONTINUOUS
0
LAYER
2
CONTOUR
70
0
62
3
6
CONTINUOUS
0
LAYER
2
CENTERLINE
70
0
62
1
6
CONTINUOUS
0
ENDTAB
0
ENDSEC
`;

  // DXF entities section - single open polyline (upper half only)
  // Using POLYLINE entity for R12 compatibility (not LWPOLYLINE)
  let entities = `0
SECTION
2
ENTITIES
0
POLYLINE
8
CONTOUR
66
1
70
0
`;

  // Add each vertex as VERTEX entity (R12 format)
  for (const pt of points) {
    entities += `0
VERTEX
8
CONTOUR
10
${pt.x.toFixed(PRECISION)}
20
${pt.y.toFixed(PRECISION)}
30
0.0
`;
  }

  // End the polyline
  entities += `0
SEQEND
8
CONTOUR
`;

  // Add centerline (for revolve axis reference)
  const xMin = Math.min(...points.map(p => p.x));
  const xMax = Math.max(...points.map(p => p.x));
  const margin = (xMax - xMin) * 0.05;  // 5% margin
  entities += `0
LINE
8
CENTERLINE
10
${(xMin - margin).toFixed(PRECISION)}
20
0.0
11
${(xMax + margin).toFixed(PRECISION)}
21
0.0
`;

  entities += `0
ENDSEC
`;

  // DXF end of file
  const eof = `0
EOF
`;

  return header + tables + entities + eof;
}


// Helper function to get nice step size for a given range
function getNiceStep(range: number): number {
  const magnitude = Math.floor(Math.log10(range));
  const normalized = range / Math.pow(10, magnitude);

  let step;
  if (normalized <= 1) step = 1;
  else if (normalized <= 2) step = 2;
  else if (normalized <= 5) step = 5;
  else step = 10;

  return step * Math.pow(10, magnitude);
}

// Helper function to ensure domain includes 0 and has nice rounded bounds
function makeNiceDomain(min: number, max: number, includeZero: boolean = true): [number, number] {
  // Calculate the range
  let range = max - min;

  // If including zero, expand range to include it
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

  // Get a nice step size
  const step = getNiceStep(range / 8); // Aim for about 8 ticks

  // Round min down and max up to nice values
  const domainMin = includeZero && min <= 0 && max >= 0
    ? Math.floor(min / step) * step
    : Math.floor(min / step) * step;
  const domainMax = includeZero && min <= 0 && max >= 0
    ? Math.ceil(max / step) * step
    : Math.ceil(max / step) * step;

  // Ensure 0 is included if requested
  let finalMin = domainMin;
  let finalMax = domainMax;
  if (includeZero) {
    if (finalMin > 0) finalMin = 0;
    if (finalMax < 0) finalMax = 0;
  }

  // Ensure min < max
  if (finalMin >= finalMax) {
    const absMax = Math.max(Math.abs(finalMin), Math.abs(finalMax));
    finalMin = -absMax;
    finalMax = absMax;
  }

  return [finalMin, finalMax];
}

// Helper function to format tick values nicely
function formatTick(value: number, unit: 'mm' | 'inch'): string {
  // Special case: always show "0" for zero, not "0.00"
  if (Math.abs(value) < 1e-10) {
    return '0';
  }

  const absValue = Math.abs(value);

  if (unit === 'inch') {
    // For inches, use integer values (no decimals for whole numbers)
    // Only show decimals if the value is fractional
    if (absValue % 1 === 0) {
      return value.toFixed(0);
    }
    if (absValue < 0.1) return value.toFixed(3);
    if (absValue < 1) return value.toFixed(2);
    return value.toFixed(1);
  } else {
    // mm - for whole numbers, show without decimals
    if (absValue % 1 === 0) {
      return value.toFixed(0);
    }
    if (absValue < 1) return value.toFixed(2);
    if (absValue < 10) return value.toFixed(1);
    return value.toFixed(0);
  }
}

interface ChamberContourPlotProps {
  geometry: ChamberGeometryResponse | null;
  title?: string;
  showCfBadge?: boolean;
  className?: string;
}

export function ChamberContourPlot({
  geometry,
  title = "Chamber Contour",
  showCfBadge = true,
  className = ""
}: ChamberContourPlotProps) {
  const [showLowerHalf, setShowLowerHalf] = useState(true);
  const [ceaUnit, setCeaUnit] = useState<'mm' | 'inch'>('mm');
  const ceaContourContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 1000, height: 350 });

  // Download DXF handler
  const handleDownloadDxf = useCallback(() => {
    if (!geometry || !geometry.chamber_contour_x || geometry.chamber_contour_x.length === 0) {
      return;
    }

    const dxfContent = generateDxfContent(
      geometry.chamber_contour_x,
      geometry.chamber_contour_y,
      ceaUnit
    );

    const blob = new Blob([dxfContent], { type: 'application/dxf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chamber_contour_${ceaUnit}.dxf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }, [geometry, ceaUnit]);

  // CEA-solved chamber contour data
  const chamberContourData = useMemo(() => {
    if (!geometry || !geometry.chamber_contour_x || geometry.chamber_contour_x.length === 0) return [];

    // Convert from meters to selected unit
    const unitMultiplier = ceaUnit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;

    return geometry.chamber_contour_x.map((x, i) => ({
      x: x * unitMultiplier,
      R_chamber_upper: geometry.chamber_contour_y[i] * unitMultiplier,
      R_chamber_lower: showLowerHalf ? -geometry.chamber_contour_y[i] * unitMultiplier : 0,
    }));
  }, [geometry, showLowerHalf, ceaUnit]);

  // Measure container size for equal-scale calculation
  useEffect(() => {
    if (!ceaContourContainerRef.current) return;

    const updateSize = () => {
      if (ceaContourContainerRef.current) {
        const rect = ceaContourContainerRef.current.getBoundingClientRect();
        setContainerSize({ width: rect.width, height: rect.height });
      }
    };

    // Initial measurement
    updateSize();

    // Use ResizeObserver for accurate container size tracking
    const resizeObserver = new ResizeObserver(() => {
      updateSize();
    });

    resizeObserver.observe(ceaContourContainerRef.current);

    // Also listen to window resize as fallback
    window.addEventListener('resize', updateSize);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [geometry]);

  // Calculate equal-scale domains for CEA contour plot (1:1 aspect ratio)
  const ceaContourDomains = useMemo(() => {
    if (!chamberContourData || chamberContourData.length === 0 || !geometry) {
      return {
        xDomain: ['dataMin', 'dataMax'] as [string, string],
        yDomain: ['auto', 'auto'] as [string, string],
        xLabel: `Axial Position (${ceaUnit})`,
        yLabel: `Radius (${ceaUnit})`,
        xTicks: [] as number[],
        yTicks: [] as number[]
      };
    }

    // Calculate data ranges in METRIC (meters) first for consistent scale calculation
    // This ensures the 1:1 scale is maintained regardless of unit conversion
    const xValues_m = geometry.chamber_contour_x;
    const yValues_m = geometry.chamber_contour_y;

    const xMin_m = Math.min(...xValues_m);
    const xMax_m = Math.max(...xValues_m);
    const yMax_m = Math.max(...yValues_m);
    const yMin_m = -yMax_m; // Symmetric around centerline

    const xRange_m = xMax_m - xMin_m;
    const yRange_m = yMax_m - yMin_m;

    // Now convert to display units for the actual domain values
    const unitMultiplier = ceaUnit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;
    const xMin = xMin_m * unitMultiplier;
    const xMax = xMax_m * unitMultiplier;
    const yMin = yMin_m * unitMultiplier;
    const yMax = yMax_m * unitMultiplier;

    const xRange = xRange_m * unitMultiplier;
    const yRange = yRange_m * unitMultiplier;

    // Container dimensions (accounting for margins: left: 20, right: 30, top: 20, bottom: 20)
    // Use default if container not measured yet
    const effectiveWidth = containerSize.width > 0 ? containerSize.width : 1000;
    const effectiveHeight = containerSize.height > 0 ? containerSize.height : 350;
    const plotWidth = effectiveWidth - 20 - 30;
    const plotHeight = effectiveHeight - 20 - 20;

    // Guard against invalid dimensions
    if (plotWidth <= 0 || plotHeight <= 0) {
      const tickInterval = ceaUnit === 'mm' ? 10 : 1;
      const generateTicks = (min: number, max: number, interval: number): number[] => {
        const ticks: number[] = [];
        const start = Math.ceil(min / interval) * interval;
        const end = Math.floor(max / interval) * interval;
        for (let value = start; value <= end; value += interval) {
          ticks.push(value);
        }
        return ticks;
      };
      return {
        xDomain: [xMin, xMax] as [number, number],
        yDomain: [yMin, yMax] as [number, number],
        xLabel: `Axial Position (${ceaUnit})`,
        yLabel: `Radius (${ceaUnit})`,
        xTicks: generateTicks(xMin, xMax, tickInterval),
        yTicks: generateTicks(yMin, yMax, tickInterval)
      };
    }

    // Calculate aspect ratio of plot area
    const plotAspectRatio = plotWidth / plotHeight;

    // Calculate the data aspect ratio from METRIC values (before unit conversion)
    // This ensures the aspect ratio is the same regardless of units
    const dataAspectRatio_m = xRange_m / yRange_m;

    // For equal scales (1:1), we want 1 unit on x-axis to equal 1 unit on y-axis visually
    // This means: xRange / plotWidth should equal yRange / plotHeight
    // Or: xRange / yRange should equal plotWidth / plotHeight

    // First, calculate target domains in metric units to maintain aspect ratio
    let xDomain_m: [number, number] = [xMin_m, xMax_m];
    let yDomain_m: [number, number] = [yMin_m, yMax_m];

    // To achieve 1:1 scale, adjust domains so that the visual representation
    // shows equal physical scales on both axes
    if (dataAspectRatio_m > plotAspectRatio) {
      // Data is wider relative to its height than the plot - expand y range to match
      const targetYRange_m = xRange_m / plotAspectRatio;
      const yCenter_m = (yMin_m + yMax_m) / 2;
      yDomain_m = [yCenter_m - targetYRange_m / 2, yCenter_m + targetYRange_m / 2];
    } else {
      // Data is taller relative to its width than the plot - expand x range to match
      const targetXRange_m = yRange_m * plotAspectRatio;
      const xCenter_m = (xMin_m + xMax_m) / 2;
      xDomain_m = [xCenter_m - targetXRange_m / 2, xCenter_m + targetXRange_m / 2];
    }

    // Add padding in metric units (5% of the range)
    const padding_m = Math.max(xDomain_m[1] - xDomain_m[0], yDomain_m[1] - yDomain_m[0]) * 0.05;
    xDomain_m = [xDomain_m[0] - padding_m, xDomain_m[1] + padding_m];
    yDomain_m = [yDomain_m[0] - padding_m, yDomain_m[1] + padding_m];

    // Round to nice values in metric units first
    const xIncludesZero_m = xDomain_m[0] <= 0 && xDomain_m[1] >= 0;
    xDomain_m = makeNiceDomain(xDomain_m[0], xDomain_m[1], xIncludesZero_m);
    yDomain_m = makeNiceDomain(yDomain_m[0], yDomain_m[1], true);

    // After rounding, ensure aspect ratio is still maintained in metric
    const finalXRange_m = xDomain_m[1] - xDomain_m[0];
    const finalYRange_m = yDomain_m[1] - yDomain_m[0];
    const finalDataAspectRatio_m = finalXRange_m / finalYRange_m;

    // Re-adjust if rounding changed the aspect ratio significantly
    if (Math.abs(finalDataAspectRatio_m - dataAspectRatio_m) / dataAspectRatio_m > 0.01) {
      if (finalDataAspectRatio_m > dataAspectRatio_m) {
        // Domain is wider than it should be - expand y
        const targetYRange_m = finalXRange_m / dataAspectRatio_m;
        const yCenter_m = (yDomain_m[0] + yDomain_m[1]) / 2;
        yDomain_m = [yCenter_m - targetYRange_m / 2, yCenter_m + targetYRange_m / 2];
      } else {
        // Domain is taller than it should be - expand x
        const targetXRange_m = finalYRange_m * dataAspectRatio_m;
        const xCenter_m = (xDomain_m[0] + xDomain_m[1]) / 2;
        xDomain_m = [xCenter_m - targetXRange_m / 2, xCenter_m + targetXRange_m / 2];
      }
    }

    // Now convert the final domains to display units
    const xDomain: [number, number] = [xDomain_m[0] * unitMultiplier, xDomain_m[1] * unitMultiplier];
    const yDomain: [number, number] = [yDomain_m[0] * unitMultiplier, yDomain_m[1] * unitMultiplier];

    // Generate tick values based on unit
    const tickInterval = ceaUnit === 'mm' ? 10 : 1; // 10mm or 1 inch

    const generateTicks = (min: number, max: number, interval: number): number[] => {
      const ticks: number[] = [];
      const start = Math.ceil(min / interval) * interval;
      const end = Math.floor(max / interval) * interval;
      for (let value = start; value <= end; value += interval) {
        ticks.push(value);
      }
      return ticks;
    };

    const xTicks = generateTicks(xDomain[0], xDomain[1], tickInterval);
    const yTicks = generateTicks(yDomain[0], yDomain[1], tickInterval);

    return {
      xDomain: xDomain as [number, number],
      yDomain: yDomain as [number, number],
      xLabel: `Axial Position (${ceaUnit})`,
      yLabel: `Radius (${ceaUnit})`,
      xTicks,
      yTicks
    };
    // Note: showLowerHalf is not in the dependency array because we always want
    // the same scale calculation regardless of what's displayed
  }, [chamberContourData, containerSize, ceaUnit, geometry]);

  // Don't render if no geometry data
  if (!geometry || chamberContourData.length === 0) {
    return null;
  }

  return (
    <div
      ref={ceaContourContainerRef}
      className={`p-4 rounded-xl bg-[var(--color-bg-secondary)] border border-[var(--color-border)] ${className}`}
    >
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
          {title}
        </h4>
        <div className="flex items-center gap-3">
          {/* Unit switcher */}
          <div className="flex items-center gap-2 bg-[var(--color-bg-primary)] rounded-lg border border-[var(--color-border)] p-1">
            <button
              onClick={() => setCeaUnit('mm')}
              className={`px-3 py-1 text-xs font-medium rounded transition-all ${ceaUnit === 'mm'
                ? 'bg-rose-600 text-white'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
            >
              mm
            </button>
            <button
              onClick={() => setCeaUnit('inch')}
              className={`px-3 py-1 text-xs font-medium rounded transition-all ${ceaUnit === 'inch'
                ? 'bg-rose-600 text-white'
                : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'
                }`}
            >
              in
            </button>
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              checked={showLowerHalf}
              onChange={(e) => setShowLowerHalf(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-border)] text-rose-600 focus:ring-rose-500"
            />
            Show Full Cross-Section
          </label>
          {showCfBadge && geometry.Cf !== null && geometry.Cf !== undefined && (
            <span className="text-xs px-2 py-1 rounded bg-emerald-500/20 text-emerald-400">
              Cf = {geometry.Cf.toFixed(4)}
            </span>
          )}
          {/* Download DXF button */}
          <button
            onClick={handleDownloadDxf}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-rose-500/50 transition-all"
            title={`Download chamber contour as DXF (${ceaUnit})`}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            DXF
          </button>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={350}>
        <ComposedChart data={chamberContourData} margin={{ top: 20, right: 30, left: 20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />

          <XAxis
            dataKey="x"
            type="number"
            domain={ceaContourDomains.xDomain}
            ticks={ceaContourDomains.xTicks}
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            tickFormatter={(value) => formatTick(value, ceaUnit)}
            allowDecimals={false}
            label={{
              value: ceaContourDomains.xLabel,
              position: 'insideBottom',
              offset: -10,
              fill: 'var(--color-text-secondary)'
            }}
          />

          <YAxis
            domain={ceaContourDomains.yDomain}
            ticks={ceaContourDomains.yTicks}
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            tickFormatter={(value) => formatTick(value, ceaUnit)}
            allowDecimals={false}
            label={{
              value: ceaContourDomains.yLabel,
              angle: -90,
              position: 'insideLeft',
              fill: 'var(--color-text-secondary)'
            }}
          />

          {/* Custom Tooltip */}
          <Tooltip
            content={({ active, payload, label }) => {
              if (!active || !payload || !payload.length) return null;

              // Get the radius value (use upper if available, otherwise use the first payload)
              const radiusValue = payload[0]?.value;
              const xValue = label;

              return (
                <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 shadow-xl">
                  <p className="text-sm font-medium text-[var(--color-text-primary)] mb-2">
                    Position: {formatTick(xValue as number, ceaUnit)} {ceaUnit}
                  </p>
                  <p className="text-sm text-[var(--color-text-primary)]">
                    Radius: {formatTick(Math.abs(radiusValue as number), ceaUnit)} {ceaUnit}
                  </p>
                  {radiusValue !== undefined && typeof radiusValue === 'number' && (
                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                      Diameter: {formatTick(Math.abs(radiusValue * 2), ceaUnit)} {ceaUnit}
                    </p>
                  )}
                </div>
              );
            }}
          />

          {/* Chamber contour - Upper */}
          <Line
            type="monotone"
            dataKey="R_chamber_upper"
            stroke="#10b981"
            strokeWidth={2.5}
            dot={false}
            name="Chamber Contour (CEA)"
          />

          {/* Chamber contour - Lower (symmetric) */}
          {showLowerHalf && (
            <Line
              type="monotone"
              dataKey="R_chamber_lower"
              stroke="#10b981"
              strokeWidth={2.5}
              dot={false}
              legendType="none"
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

      <div className="mt-2 space-y-1">
        <p className="text-xs text-[var(--color-text-secondary)]">
          {geometry.chamber_contour_method === 'solved' && (
            <>Full chamber contour from optimized geometry (cylindrical + contraction + nozzle).</>
          )}
          {geometry.chamber_contour_method === 'cea_iterative' && (
            <>
              <span className="inline-flex items-center gap-1">
                <span className="text-amber-400">⚠</span>
                <span>Using CEA iterative solver (slower) - geometry not fully constrained.</span>
              </span>
            </>
          )}
          {(!geometry.chamber_contour_method || geometry.chamber_contour_method === 'failed') && (
            <>Full chamber contour (cylindrical + contraction + nozzle).</>
          )}
        </p>
      </div>
    </div>
  );
}

