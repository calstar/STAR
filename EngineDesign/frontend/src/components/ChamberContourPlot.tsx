import { useState, useMemo, useCallback } from 'react';
import {
  ComposedChart,
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
  const [showLowerHalf, setShowLowerHalf] = useViewState('chamberContour.fullSection', false);
  const [ceaUnit, setCeaUnit] = useState<'mm' | 'inch'>('mm');

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

  // True scale: the chart's height follows from its width (lib/contourScale).
  const k = ceaUnit === 'mm' ? M_TO_MM : M_TO_MM * MM_TO_INCH;
  const xs = geometry?.chamber_contour_x ?? [];
  const { ref: chartRef, width: chartWidth, layout } = useTrueScale(
    Math.min(...xs) * k, Math.max(...xs) * k, Math.max(0, ...(geometry?.chamber_contour_y ?? [])) * k, showLowerHalf);
  const axisLabel = (name: string) => `${name} (${ceaUnit})`;

  // Don't render if no geometry data
  if (!geometry || chamberContourData.length === 0) {
    return null;
  }

  return (
    <div
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

      {/* True scale: the chart height is derived from its width, so 1 mm is the same number of
          pixels on both axes. No legend, since a legend's box would take height from the plot. */}
      <div ref={chartRef} className="w-full">
        {chartWidth > 0 && layout && (
        <ComposedChart width={layout.width} height={layout.height} data={chamberContourData}
          margin={{ top: CONTOUR_FRAME.top, right: CONTOUR_FRAME.right, left: CONTOUR_FRAME.left, bottom: CONTOUR_FRAME.bottom }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" opacity={0.3} />

          <XAxis
            dataKey="x"
            type="number"
            domain={layout.xDomain}
            ticks={layout.xTicks}
                interval={0}
            allowDataOverflow
            height={CONTOUR_FRAME.xAxis}
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            tickFormatter={(value) => formatTick(value, ceaUnit)}
            allowDecimals={false}
            label={{
              value: axisLabel('Axial position'),
              position: 'insideBottom',
              offset: 0,
              fill: 'var(--color-text-secondary)'
            }}
          />

          <YAxis
            domain={layout.yDomain}
            ticks={layout.yTicks}
                interval={0}
            allowDataOverflow
            width={CONTOUR_FRAME.yAxis}
            stroke="var(--color-text-secondary)"
            tick={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
            tickFormatter={(value) => formatTick(value, ceaUnit)}
            allowDecimals={false}
            label={{
              value: axisLabel('Radius'),
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
          <Line isAnimationActive={false}
            type="monotone"
            dataKey="R_chamber_upper"
            stroke="#10b981"
            strokeWidth={2.5}
            dot={false}
            name="Chamber Contour (CEA)"
          />

          {/* Chamber contour - Lower (symmetric) */}
          {showLowerHalf && (
            <Line isAnimationActive={false}
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

        </ComposedChart>
        )}
      </div>

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

