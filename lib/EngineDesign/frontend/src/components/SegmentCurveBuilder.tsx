import { useState, useCallback, useRef, useEffect } from 'react';
import type { PressureSegment, SegmentType } from '../api/client';

interface SegmentCurveBuilderProps {
  label: string;
  segments: PressureSegment[];
  onChange: (segments: PressureSegment[]) => void;
  colorClass: string;
  strokeColor: string;
  minPressure?: number;
  maxPressure?: number;
  duration?: number; // Duration in seconds for time axis
  overlaySegments?: PressureSegment[]; // Segments from the other plot to display as overlay
  overlayStrokeColor?: string; // Color for the overlay line
}

// Generate curve points from segments using blowdown/linear formulas
function generateCurvePoints(
  segments: PressureSegment[],
  nPoints: number = 200
): { x: number; y: number }[] {
  if (segments.length === 0) return [];

  const points: { x: number; y: number }[] = [];
  
  // Normalize length ratios
  const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
  const normalizedRatios = segments.map(seg => seg.length_ratio / totalRatio);
  
  let pointIdx = 0;
  let prevEndPressure = segments[0].start_pressure_psi;
  
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const ratio = normalizedRatios[i];
    
    // Calculate points for this segment
    const nSegPoints = i === segments.length - 1 
      ? nPoints - pointIdx 
      : Math.max(1, Math.round(ratio * nPoints));
    
    // Start pressure chains from previous segment to ensure continuity
    // For first segment, use its start_pressure_psi
    // For subsequent segments, use previous segment's end to ensure smooth connection
    const startP = i === 0 ? seg.start_pressure_psi : prevEndPressure;
    // Use the segment's end pressure, but ensure it's <= start for physical validity
    let endP = seg.end_pressure_psi;
    if (endP > startP) {
      endP = startP * 0.95; // Force decrease
    }
    // Ensure endP is at least as low as the next segment's start (if exists)
    if (i < segments.length - 1) {
      const nextStart = segments[i + 1].start_pressure_psi;
      if (endP > nextStart) {
        endP = nextStart;
      }
    }
    
    for (let j = 0; j < nSegPoints; j++) {
      const tNorm = nSegPoints > 1 ? j / (nSegPoints - 1) : 0;
      let pressure: number;
      
      if (seg.type === 'blowdown') {
        // Blowdown: P(t) = P_end + (P_start - P_end) * exp(-k * t_norm)
        // At t_norm=0: P = P_start, at t_norm=1: P = P_end + (P_start - P_end) * exp(-k)
        // To ensure we reach exactly endP at t_norm=1, we need to adjust the formula
        // Use: P(t) = P_end + (P_start - P_end) * (exp(-k * t_norm) - exp(-k)) / (1 - exp(-k))
        // This ensures P(0) = P_start and P(1) = P_end exactly
        const exp_k = Math.exp(-seg.k);
        if (Math.abs(1 - exp_k) < 1e-6) {
          // k is very small, use linear approximation
          pressure = startP + (endP - startP) * tNorm;
        } else {
          const exp_kt = Math.exp(-seg.k * tNorm);
          pressure = endP + (startP - endP) * (exp_kt - exp_k) / (1 - exp_k);
        }
      } else {
        // Linear: P(t) = P_start + (P_end - P_start) * t
        pressure = startP + (endP - startP) * tNorm;
      }
      
      const x = (pointIdx + j) / (nPoints - 1);
      points.push({ x, y: pressure });
    }
    
    pointIdx += nSegPoints;
    prevEndPressure = endP;
    
    if (pointIdx >= nPoints) break;
  }
  
  return points;
}

// Get segment boundary positions (normalized 0-1)
function getSegmentBoundaries(segments: PressureSegment[]): number[] {
  const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
  const boundaries: number[] = [0];
  let cumulative = 0;
  
  for (let i = 0; i < segments.length - 1; i++) {
    cumulative += segments[i].length_ratio / totalRatio;
    boundaries.push(cumulative);
  }
  boundaries.push(1);
  
  return boundaries;
}

export function SegmentCurveBuilder({
  label,
  segments,
  onChange,
  colorClass,
  strokeColor,
  minPressure = 0,
  maxPressure = 2000,
  duration = 5.0,
  overlaySegments,
  overlayStrokeColor,
}: SegmentCurveBuilderProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{
    type: 'boundary' | 'endpoint' | 'startpoint';
    segmentIdx: number;
  } | null>(null);
  const [numSegmentsInput, setNumSegmentsInput] = useState<string>(segments.length.toString());
  const [kInputs, setKInputs] = useState<Record<number, string>>({});
  const [startPressureInputs, setStartPressureInputs] = useState<Record<number, string>>({});
  const [endPressureInputs, setEndPressureInputs] = useState<Record<number, string>>({});
  const [lengthRatioInputs, setLengthRatioInputs] = useState<Record<number, string>>({});

  // SVG dimensions
  const circleRadius = 8; // Radius of draggable circles
  const baseWidth = 600;
  const height = 200;
  // Increase width to accommodate circle radius on the right side
  const width = baseWidth + circleRadius;
  const padding = { top: 20, right: 80, bottom: 30, left: 60 };
  // Visual plot area (for grid) - ends at baseWidth - padding.right
  const visualPlotWidth = baseWidth - padding.left - padding.right;
  // Effective plot width for data scaling - accounts for circle radius so final point fits
  const plotWidth = visualPlotWidth - circleRadius;
  const plotHeight = height - padding.top - padding.bottom;

  // Scale functions
  // Scale data so x=1 maps to position where circle fits within visual plot area
  const xScale = useCallback((x: number) => padding.left + x * plotWidth, [plotWidth, padding.left]);
  const yScale = useCallback((y: number) => {
    const range = maxPressure - minPressure;
    return padding.top + plotHeight * (1 - (y - minPressure) / range);
  }, [maxPressure, minPressure, plotHeight]);
  
  const xScaleInverse = useCallback((px: number) => {
    return Math.max(0, Math.min(1, (px - padding.left) / plotWidth));
  }, [plotWidth, padding.left]);
  
  const yScaleInverse = useCallback((py: number) => {
    const range = maxPressure - minPressure;
    const normalized = 1 - (py - padding.top) / plotHeight;
    return minPressure + normalized * range;
  }, [maxPressure, minPressure, plotHeight]);

  // Generate curve points
  const curvePoints = generateCurvePoints(segments, 200);
  const pathD = curvePoints.length > 0
    ? `M ${curvePoints.map(p => `${xScale(p.x)},${yScale(p.y)}`).join(' L ')}`
    : '';

  // Generate overlay curve points (from other plot)
  const overlayCurvePoints = overlaySegments ? generateCurvePoints(overlaySegments, 200) : [];
  const overlayPathD = overlayCurvePoints.length > 0
    ? `M ${overlayCurvePoints.map(p => `${xScale(p.x)},${yScale(p.y)}`).join(' L ')}`
    : '';

  // Segment boundaries
  const boundaries = getSegmentBoundaries(segments);

  // Handle mouse events for dragging
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging || !svgRef.current) return;
    
    const rect = svgRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    
    const newSegments = [...segments];
    
    if (dragging.type === 'boundary') {
      // Drag segment boundary (adjust length ratios)
      const xNorm = xScaleInverse(mx);
      const prevBoundary = dragging.segmentIdx > 0 ? boundaries[dragging.segmentIdx] : 0;
      const nextBoundary = dragging.segmentIdx < segments.length - 1 
        ? boundaries[dragging.segmentIdx + 2] 
        : 1;
      
      // Constrain to valid range
      const newBoundary = Math.max(prevBoundary + 0.05, Math.min(nextBoundary - 0.05, xNorm));
      
      // Update length ratios
      const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
      const currentBoundary = boundaries[dragging.segmentIdx + 1];
      const delta = newBoundary - currentBoundary;
      
      newSegments[dragging.segmentIdx].length_ratio += delta * totalRatio;
      newSegments[dragging.segmentIdx + 1].length_ratio -= delta * totalRatio;
      
      onChange(newSegments);
    } else if (dragging.type === 'endpoint') {
      // Drag pressure endpoint with pushing behavior
      const pressure = yScaleInverse(my);
      
      // Get this segment's start pressure (max allowed for endpoint)
      const segmentStartPressure = newSegments[dragging.segmentIdx].start_pressure_psi;
      
      // Get minimum allowed: either next segment's end pressure or absolute min
      const nextSegEndPressure = dragging.segmentIdx < segments.length - 1
        ? newSegments[dragging.segmentIdx + 1].end_pressure_psi
        : minPressure;
      
      // Clamp to absolute bounds
      const clampedPressure = Math.max(minPressure, Math.min(maxPressure, pressure));
      
      // If dragging above start pressure, push the start pressure up (and cascade backward)
      if (clampedPressure > segmentStartPressure) {
        newSegments[dragging.segmentIdx].start_pressure_psi = clampedPressure;
        // Cascade backward through all previous segments
        let currentPressure = clampedPressure;
        for (let i = dragging.segmentIdx - 1; i >= 0; i--) {
          // Always update this segment's end pressure to match the next segment's start
          newSegments[i].end_pressure_psi = currentPressure;
          // If this segment's start pressure is now below its end, push it up
          if (newSegments[i].start_pressure_psi < currentPressure) {
            newSegments[i].start_pressure_psi = Math.min(maxPressure, currentPressure);
          }
          // Continue cascading with this segment's start pressure (whether we pushed it or not)
          currentPressure = newSegments[i].start_pressure_psi;
        }
      }
      
      // If dragging below next segment's end, push it down (and cascade)
      if (dragging.segmentIdx < segments.length - 1 && clampedPressure < nextSegEndPressure) {
        // Push all subsequent segments down
        let currentPressure = clampedPressure;
        for (let i = dragging.segmentIdx + 1; i < segments.length; i++) {
          newSegments[i].start_pressure_psi = currentPressure;
          // Ensure end pressure is still below start
          if (newSegments[i].end_pressure_psi > currentPressure) {
            newSegments[i].end_pressure_psi = Math.max(minPressure, currentPressure * 0.95);
          }
          currentPressure = newSegments[i].end_pressure_psi;
        }
      }
      
      // Set the endpoint pressure
      newSegments[dragging.segmentIdx].end_pressure_psi = clampedPressure;
      
      // Chain to next segment's start
      if (dragging.segmentIdx < segments.length - 1) {
        newSegments[dragging.segmentIdx + 1].start_pressure_psi = clampedPressure;
      }
      
      onChange(newSegments);
    } else if (dragging.type === 'startpoint') {
      // Drag the initial start pressure with pushing behavior
      const pressure = yScaleInverse(my);
      const clampedPressure = Math.max(minPressure, Math.min(maxPressure, pressure));
      
      newSegments[0].start_pressure_psi = clampedPressure;
      
      // If dragging below the first segment's end pressure, push it down (and cascade)
      if (newSegments[0].end_pressure_psi > clampedPressure) {
        // Push all segments down
        let currentPressure = Math.max(minPressure, clampedPressure * 0.95);
        newSegments[0].end_pressure_psi = currentPressure;
        
        // Cascade to subsequent segments
        for (let i = 1; i < segments.length; i++) {
          newSegments[i].start_pressure_psi = currentPressure;
          // Ensure end pressure is still below start
          if (newSegments[i].end_pressure_psi > currentPressure) {
            newSegments[i].end_pressure_psi = Math.max(minPressure, currentPressure * 0.95);
          }
          currentPressure = newSegments[i].end_pressure_psi;
        }
      }
      
      onChange(newSegments);
    }
  }, [dragging, segments, boundaries, xScaleInverse, yScaleInverse, onChange, minPressure, maxPressure]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  // Add segment
  const addSegment = () => {
    if (segments.length >= 20) return;
    
    const lastSeg = segments[segments.length - 1];
    const newEndPressure = lastSeg.end_pressure_psi * 0.9;
    
    // Reduce last segment's ratio and add new segment
    const newSegments = segments.map((seg, i) => 
      i === segments.length - 1 
        ? { ...seg, length_ratio: seg.length_ratio * 0.5 }
        : seg
    );
    
    newSegments.push({
      length_ratio: lastSeg.length_ratio * 0.5,
      type: 'blowdown' as SegmentType,
      start_pressure_psi: lastSeg.end_pressure_psi,
      end_pressure_psi: newEndPressure,
      k: 0.5,
    });
    
    onChange(newSegments);
  };

  // Remove segment
  const removeSegment = (idx: number) => {
    if (segments.length <= 1) return;
    
    const newSegments = segments.filter((_, i) => i !== idx);
    
    // Redistribute the removed segment's ratio
    const removedRatio = segments[idx].length_ratio;
    const redistributeAmount = removedRatio / newSegments.length;
    
    const redistributed = newSegments.map(seg => ({
      ...seg,
      length_ratio: seg.length_ratio + redistributeAmount,
    }));
    
    // Fix chain: segment after removed one gets removed one's start pressure
    if (idx < redistributed.length) {
      redistributed[idx].start_pressure_psi = segments[idx].start_pressure_psi;
    }
    
    onChange(redistributed);
  };

  // Update k for a segment (from slider - immediate)
  const updateK = (idx: number, k: number) => {
    const newSegments = [...segments];
    newSegments[idx].k = k;
    onChange(newSegments);
    setKInputs(prev => ({ ...prev, [idx]: k.toFixed(2) }));
  };

  // Commit k value from input box
  const commitK = (idx: number, value: string) => {
    const k = parseFloat(value);
    if (isNaN(k) || k < 0.1 || k > 3) {
      setKInputs(prev => ({ ...prev, [idx]: segments[idx].k.toFixed(2) }));
      return;
    }
    const clampedK = Math.max(0.1, Math.min(3, k));
    const newSegments = [...segments];
    newSegments[idx].k = clampedK;
    onChange(newSegments);
    setKInputs(prev => ({ ...prev, [idx]: clampedK.toFixed(2) }));
  };

  // Commit start pressure
  const commitStartPressure = (idx: number, value: string) => {
    const pressure = parseFloat(value);
    if (isNaN(pressure) || pressure < minPressure || pressure > maxPressure) {
      setStartPressureInputs(prev => ({ ...prev, [idx]: segments[idx].start_pressure_psi.toFixed(0) }));
      return;
    }
    const newSegments = [...segments];
    newSegments[idx].start_pressure_psi = pressure;
    
    // If this is the first segment, we're done
    // If not, we need to update the previous segment's end pressure to match
    if (idx > 0) {
      newSegments[idx - 1].end_pressure_psi = pressure;
      setEndPressureInputs(prev => ({ ...prev, [idx - 1]: pressure.toFixed(0) }));
    }
    
    // Ensure this segment's end pressure is still valid
    if (newSegments[idx].end_pressure_psi > pressure) {
      newSegments[idx].end_pressure_psi = pressure * 0.95;
      setEndPressureInputs(prev => ({ ...prev, [idx]: newSegments[idx].end_pressure_psi.toFixed(0) }));
    }
    
    onChange(newSegments);
    setStartPressureInputs(prev => ({ ...prev, [idx]: pressure.toFixed(0) }));
  };

  // Commit end pressure
  const commitEndPressure = (idx: number, value: string) => {
    const pressure = parseFloat(value);
    const segmentStart = segments[idx].start_pressure_psi;
    const nextEnd = idx < segments.length - 1 ? segments[idx + 1].end_pressure_psi : minPressure;
    
    if (isNaN(pressure) || pressure < Math.max(nextEnd, minPressure) || pressure > segmentStart - 10) {
      setEndPressureInputs(prev => ({ ...prev, [idx]: segments[idx].end_pressure_psi.toFixed(0) }));
      return;
    }
    
    const clampedPressure = Math.max(
      Math.max(nextEnd, minPressure),
      Math.min(segmentStart - 10, pressure)
    );
    
    const newSegments = [...segments];
    newSegments[idx].end_pressure_psi = clampedPressure;
    
    // Chain to next segment's start
    if (idx < segments.length - 1) {
      newSegments[idx + 1].start_pressure_psi = clampedPressure;
      setStartPressureInputs(prev => ({ ...prev, [idx + 1]: clampedPressure.toFixed(0) }));
    }
    
    onChange(newSegments);
    setEndPressureInputs(prev => ({ ...prev, [idx]: clampedPressure.toFixed(0) }));
  };

  // Commit length ratio (as percentage)
  const commitLengthRatio = (idx: number, value: string) => {
    const percent = parseFloat(value);
    if (isNaN(percent) || percent < 0.1 || percent > 100) {
      const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
      setLengthRatioInputs(prev => ({ ...prev, [idx]: ((segments[idx].length_ratio / totalRatio) * 100).toFixed(1) }));
      return;
    }
    
    const newSegments = [...segments];
    const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
    
    // Get current percentages
    const currentPercent = (segments[idx].length_ratio / totalRatio) * 100;
    const otherPercent = 100 - currentPercent;
    const newOtherPercent = 100 - percent;
    
    // If other percent would be too small, clamp
    if (newOtherPercent < 0.1) {
      setLengthRatioInputs(prev => ({ ...prev, [idx]: currentPercent.toFixed(1) }));
      return;
    }
    
    // Scale all other segments proportionally
    if (otherPercent > 0.01) {
      const scaleFactor = newOtherPercent / otherPercent;
      newSegments.forEach((seg, i) => {
        if (i !== idx) {
          seg.length_ratio = seg.length_ratio * scaleFactor;
        }
      });
    }
    
    // Set target segment's ratio
    const newTotalRatio = newSegments.reduce((sum, seg) => sum + seg.length_ratio, 0);
    newSegments[idx].length_ratio = (percent / 100) * newTotalRatio;
    
    // Normalize to preserve original total
    const finalTotal = newSegments.reduce((sum, seg) => sum + seg.length_ratio, 0);
    if (finalTotal > 0) {
      newSegments.forEach(seg => {
        seg.length_ratio = (seg.length_ratio / finalTotal) * totalRatio;
      });
    }
    
    onChange(newSegments);
    const finalTotalRatio = newSegments.reduce((sum, seg) => sum + seg.length_ratio, 0);
    setLengthRatioInputs(prev => ({ ...prev, [idx]: ((newSegments[idx].length_ratio / finalTotalRatio) * 100).toFixed(1) }));
  };

  // Sync local input states when segments change externally
  useEffect(() => {
    setNumSegmentsInput(segments.length.toString());
    const newKInputs: Record<number, string> = {};
    const newStartInputs: Record<number, string> = {};
    const newEndInputs: Record<number, string> = {};
    const newLengthInputs: Record<number, string> = {};
    const totalRatio = segments.reduce((sum, seg) => sum + seg.length_ratio, 0);
    
    segments.forEach((seg, idx) => {
      newKInputs[idx] = seg.k.toFixed(2);
      newStartInputs[idx] = seg.start_pressure_psi.toFixed(0);
      newEndInputs[idx] = seg.end_pressure_psi.toFixed(0);
      newLengthInputs[idx] = ((seg.length_ratio / totalRatio) * 100).toFixed(1);
    });
    
    setKInputs(newKInputs);
    setStartPressureInputs(newStartInputs);
    setEndPressureInputs(newEndInputs);
    setLengthRatioInputs(newLengthInputs);
  }, [segments]);

  // Set number of segments (redistributes evenly)
  const commitNumSegments = (value: string) => {
    const n = parseInt(value);
    if (isNaN(n) || n < 1 || n > 20) {
      setNumSegmentsInput(segments.length.toString());
      return;
    }
    
    const targetN = n;
    if (targetN === segments.length) {
      setNumSegmentsInput(targetN.toString());
      return;
    }
    
    const startPressure = segments[0].start_pressure_psi;
    const endPressure = segments[segments.length - 1].end_pressure_psi;
    const pressureRange = startPressure - endPressure;
    
    const newSegments: PressureSegment[] = [];
    for (let i = 0; i < targetN; i++) {
      const segStartP = startPressure - (pressureRange * i / targetN);
      const segEndP = startPressure - (pressureRange * (i + 1) / targetN);
      
      newSegments.push({
        length_ratio: 1 / targetN,
        type: 'blowdown' as SegmentType,
        start_pressure_psi: segStartP,
        end_pressure_psi: segEndP,
        k: 0.5,
      });
    }
    
    onChange(newSegments);
    setNumSegmentsInput(targetN.toString());
  };

  return (
    <div className={`p-4 rounded-xl border ${colorClass}`}>
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{label}</h4>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1">
            <span className="text-xs text-[var(--color-text-secondary)]">N:</span>
            <input
              type="text"
              value={numSegmentsInput}
              onChange={(e) => setNumSegmentsInput(e.target.value)}
              onBlur={(e) => commitNumSegments(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.currentTarget.blur();
                }
              }}
              className="w-12 px-2 py-1 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={addSegment}
            disabled={segments.length >= 20}
            className="px-3 py-1 text-xs rounded-lg bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:border-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            + Add
          </button>
        </div>
      </div>

      {/* SVG Curve Editor */}
      <div className="bg-[var(--color-bg-primary)] rounded-lg p-2 mb-3 overflow-visible">
        <svg
          ref={svgRef}
          width={width}
          height={height}
          className="w-full"
          style={{ maxWidth: width, overflow: 'visible' }}
        >
          {/* Grid lines */}
          <defs>
            <pattern id={`grid-${label}`} width="40" height="30" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 30" fill="none" stroke="var(--color-border)" strokeWidth="0.5" opacity="0.3" />
            </pattern>
          </defs>
          <rect x={padding.left} y={padding.top} width={visualPlotWidth} height={plotHeight} fill={`url(#grid-${label})`} />
          
          {/* Y-axis labels - 100psi increments from 300 to 1000 */}
          {[300, 400, 500, 600, 700, 800, 900, 1000].map(pressure => {
            // Only show labels within the visible range
            if (pressure < minPressure || pressure > maxPressure) return null;
            return (
              <text
                key={pressure}
                x={padding.left - 8}
                y={yScale(pressure)}
                textAnchor="end"
                alignmentBaseline="middle"
                className="text-xs fill-[var(--color-text-secondary)]"
              >
                {pressure.toFixed(0)}
              </text>
            );
          })}
          
          {/* X-axis labels - integer seconds */}
          {(() => {
            const maxTime = Math.ceil(duration);
            const ticks: number[] = [];
            // Generate integer ticks from 0 to maxTime
            for (let i = 0; i <= maxTime; i++) {
              const normalizedTime = i / duration;
              if (normalizedTime <= 1) {
                ticks.push(normalizedTime);
              }
            }
            return ticks.map(t => (
              <text
                key={t}
                x={xScale(t)}
                y={height - 20}
                textAnchor="middle"
                className="text-xs fill-[var(--color-text-secondary)]"
              >
                {Math.round(t * duration)}
              </text>
            ));
          })()}
          
          {/* Axis labels */}
          <text
            x={padding.left - 45}
            y={height / 2}
            textAnchor="middle"
            transform={`rotate(-90, ${padding.left - 45}, ${height / 2})`}
            className="text-xs fill-[var(--color-text-secondary)]"
          >
            Pressure (psi)
          </text>
          <text
            x={width / 2}
            y={height - 5}
            textAnchor="middle"
            className="text-xs fill-[var(--color-text-secondary)]"
          >
            Time (s)
          </text>

          {/* Segment boundaries (draggable vertical lines) */}
          {boundaries.slice(1, -1).map((b, i) => (
            <g key={`boundary-${i}`}>
              <line
                x1={xScale(b)}
                y1={padding.top}
                x2={xScale(b)}
                y2={padding.top + plotHeight}
                stroke="var(--color-border)"
                strokeWidth="2"
                strokeDasharray="4,4"
                className="cursor-ew-resize"
              />
              <rect
                x={xScale(b) - 6}
                y={padding.top}
                width={12}
                height={plotHeight}
                fill="transparent"
                className="cursor-ew-resize"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDragging({ type: 'boundary', segmentIdx: i });
                }}
              />
            </g>
          ))}

          {/* Overlay curve (from other plot) */}
          {overlayPathD && overlayStrokeColor && (
            <path
              d={overlayPathD}
              fill="none"
              stroke={overlayStrokeColor}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="5,5"
              opacity={0.6}
            />
          )}

          {/* Pressure curve */}
          <path
            d={pathD}
            fill="none"
            stroke={strokeColor}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Segment endpoint handles (draggable circles) */}
          {segments.map((seg, i) => {
            // Each segment's endpoint is at the next boundary
            // Last segment's endpoint is at the final boundary (x=1)
            const boundary = boundaries[i + 1];
            const y = seg.end_pressure_psi;
            // Ensure boundary exists (boundaries array should have length segments.length + 1)
            if (boundary === undefined || boundary === null) return null;
            return (
              <g key={`endpoint-${i}`}>
                <circle
                  cx={xScale(boundary)}
                  cy={yScale(y)}
                  r={8}
                  fill={strokeColor}
                  stroke="white"
                  strokeWidth="2"
                  className="cursor-ns-resize"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setDragging({ type: 'endpoint', segmentIdx: i });
                    setSelectedSegment(i);
                  }}
                />
              </g>
            );
          })}
          
          {/* Final endpoint (last segment's end) - ensure it's always visible */}
          {segments.length > 0 && (
            <circle
              cx={xScale(1)}
              cy={yScale(segments[segments.length - 1].end_pressure_psi)}
              r={8}
              fill={strokeColor}
              stroke="white"
              strokeWidth="2"
              className="cursor-ns-resize"
              onMouseDown={(e) => {
                e.preventDefault();
                setDragging({ type: 'endpoint', segmentIdx: segments.length - 1 });
                setSelectedSegment(segments.length - 1);
              }}
            />
          )}

          {/* Start point (draggable) */}
          <circle
            cx={xScale(0)}
            cy={yScale(segments[0]?.start_pressure_psi || maxPressure)}
            r={8}
            fill={strokeColor}
            stroke="white"
            strokeWidth="2"
            className="cursor-ns-resize"
            onMouseDown={(e) => {
              e.preventDefault();
              setDragging({ type: 'startpoint', segmentIdx: 0 });
              setSelectedSegment(0);
            }}
          />
        </svg>
      </div>

      {/* Segment controls */}
      <div className="space-y-2">
        {segments.map((seg, i) => (
          <div
            key={i}
            className={`p-3 rounded-lg bg-[var(--color-bg-primary)] border transition-colors ${
              selectedSegment === i ? 'border-blue-500' : 'border-[var(--color-border)]'
            }`}
            onClick={() => setSelectedSegment(i)}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-[var(--color-text-secondary)]">
                Segment {i + 1}
              </span>
              {segments.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSegment(i);
                  }}
                  className="w-5 h-5 rounded flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
            
            {/* Pressures */}
            <div className="grid grid-cols-2 gap-2 mb-2">
              <div>
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Start (psi)</label>
                <input
                  type="text"
                  value={startPressureInputs[i] ?? seg.start_pressure_psi.toFixed(0)}
                  onChange={(e) => setStartPressureInputs(prev => ({ ...prev, [i]: e.target.value }))}
                  onBlur={(e) => commitStartPressure(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full px-2 py-1 text-xs rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">End (psi)</label>
                <input
                  type="text"
                  value={endPressureInputs[i] ?? seg.end_pressure_psi.toFixed(0)}
                  onChange={(e) => setEndPressureInputs(prev => ({ ...prev, [i]: e.target.value }))}
                  onBlur={(e) => commitEndPressure(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full px-2 py-1 text-xs rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            {/* k slider */}
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs text-[var(--color-text-secondary)] w-6">k:</span>
              <input
                type="range"
                min="0.1"
                max="3"
                step="0.05"
                value={seg.k}
                onChange={(e) => updateK(i, parseFloat(e.target.value))}
                onClick={(e) => e.stopPropagation()}
                className="flex-1 accent-blue-500"
              />
              <input
                type="text"
                value={kInputs[i] ?? seg.k.toFixed(2)}
                onChange={(e) => setKInputs(prev => ({ ...prev, [i]: e.target.value }))}
                onBlur={(e) => commitK(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
                onClick={(e) => e.stopPropagation()}
                className="w-14 px-2 py-0.5 text-xs rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
              />
            </div>
            
            {/* Time % and type */}
            <div className="flex items-center gap-2">
              <div className="flex-1">
                {(() => {
                  const totalRatio = segments.reduce((s, seg) => s + seg.length_ratio, 0);
                  const percent = (seg.length_ratio / totalRatio) * 100;
                  const timeSeconds = (seg.length_ratio / totalRatio) * duration;
                  return (
                    <label className="block text-xs text-[var(--color-text-secondary)] mb-1">
                      Time: {percent.toFixed(1)}% ({timeSeconds.toFixed(2)}s)
                    </label>
                  );
                })()}
                <input
                  type="text"
                  value={lengthRatioInputs[i] ?? ((seg.length_ratio / segments.reduce((s, seg) => s + seg.length_ratio, 0)) * 100).toFixed(1)}
                  onChange={(e) => setLengthRatioInputs(prev => ({ ...prev, [i]: e.target.value }))}
                  onBlur={(e) => commitLengthRatio(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.currentTarget.blur();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full px-2 py-1 text-xs rounded bg-[var(--color-bg-primary)] border border-[var(--color-border)] text-[var(--color-text-primary)] text-center focus:outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex-1">
                <label className="block text-xs text-[var(--color-text-secondary)] mb-1">Type</label>
                <div className="text-xs text-[var(--color-text-secondary)] px-2 py-1 text-center">
                  {seg.type === 'blowdown' ? 'Blowdown' : 'Linear'}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Instructions */}
      <div className="mt-3 text-xs text-[var(--color-text-secondary)]">
        <p>• Drag circles to adjust start and end pressures</p>
        <p>• Drag dashed lines to adjust segment timing</p>
        <p>• Use k slider to control blowdown curve shape</p>
      </div>
    </div>
  );
}

