'use client'

import { useState, useEffect, useRef, useMemo } from 'react';

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  unit?: string;
  showLabels?: boolean; // Show NOP/MEOP labels on this bar (default true)
  compact?: boolean;    // Reduced font sizes for use in tight spaces (e.g. TopBar)
}

function fmtPressure(v: number): string {
  if (!isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs > 99999) return '---';
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

/**
 * Non-linear piecewise scaling so the bar expands faster near NOP/MEOP.
 * Gives the operator much better visual resolution near operating limits.
 *
 *   0  →  70% NOP   ⟶   0% –  35%  bar  (compressed — safe zone)
 *  70% NOP → NOP    ⟶  35% –  60%  bar  (expanding — approaching limit)
 *  NOP → MEOP       ⟶  60% –  85%  bar  (fast — critical zone)
 *  MEOP → maxVal    ⟶  85% – 100%  bar  (over-pressure)
 */
function nonLinearPct(value: number, nop: number, meop: number, maxVal: number): number {
  // Handle negative values - clamp to 0 for display purposes
  // Negative pressures should show as minimal bar (not going below baseline)
  // Use absolute value for calculation, but ensure result is always >= 0
  const clampedValue = Math.max(0, value);
  if (clampedValue <= 0) return 0;
  if (clampedValue >= maxVal) return 100;

  const safeEdge = nop * 0.7;
  const safePct = 35;
  const warningPct = 60;
  const dangerPct = 85;

  if (clampedValue <= safeEdge) {
    return (clampedValue / safeEdge) * safePct;
  } else if (clampedValue <= nop) {
    const frac = (clampedValue - safeEdge) / (nop - safeEdge);
    return safePct + frac * (warningPct - safePct);
  } else if (clampedValue <= meop) {
    const frac = (clampedValue - nop) / (meop - nop);
    return warningPct + frac * (dangerPct - warningPct);
  } else {
    const frac = (clampedValue - meop) / (maxVal - meop);
    return dangerPct + frac * (100 - dangerPct);
  }
}

export default function PressureBar({
  label,
  value,
  nop = 500,
  meop = 700,
  color,
  unit = 'PSI',
  showLabels = true,
  compact = false,
}: PressureBarProps) {
  const displayValue = value ?? 0;

  // Memoize calculations based on value - will recalculate when value changes
  // The useSensorValue hook now properly triggers re-renders when values update
  const { sane, valuePct, nopPct, meopPct, displayHeight, barColor } = useMemo(() => {
    const maxVal = Math.max(meop * 1.3, 1000);
    const sane = isFinite(displayValue) && Math.abs(displayValue) < 100000;
    const clampedDisplayValue = Math.max(0, displayValue);
    const valuePct = sane ? Math.min(Math.max(nonLinearPct(clampedDisplayValue, nop, meop, maxVal), 0), 100) : 0;
    const nopPct = nonLinearPct(nop, nop, meop, maxVal);
    const meopPct = nonLinearPct(meop, nop, meop, maxVal);
    const minVisibleHeight = 2;
    const displayHeight = sane && value !== null && value !== 0
      ? Math.max(valuePct, minVisibleHeight)
      : valuePct;
    const barColor = color || (sane && displayValue > meop ? '#E74C3C' : sane && displayValue > nop ? '#F39C12' : '#27AE60');

    return { sane, valuePct, nopPct, meopPct, displayHeight, barColor };
  }, [displayValue, value, nop, meop, color]);

  return (
    <div className="flex flex-col items-center h-full gap-1 min-h-0 overflow-hidden select-none w-full">
      {/* Label */}
      <div className={`${compact ? 'text-[10px]' : 'text-2xl'} font-bold uppercase tracking-wider text-gray-300 text-center leading-none flex-shrink-0 whitespace-nowrap`}>
        {label}
      </div>

      {/* Bar — takes all remaining space */}
      <div
        className="relative w-full flex-1 rounded-xl border border-white/10 overflow-hidden min-h-0 bg-black/40 shadow-inner"
        style={{ maxHeight: '100%' }}
      >
        {sane && value !== null && (
          <div
            className="absolute bottom-0 w-full rounded-sm"
            style={{
              height: `${displayHeight}%`,
              background: barColor,
              boxShadow: `0 0 15px ${barColor}80`,
              minHeight: value !== null && value !== 0 ? '2px' : '0px',
              transition: 'height 0.15s ease-out',
              opacity: value !== null && value !== 0 ? 0.8 : 0.3,
            }}
          />
        )}

        {/* MEOP threshold line with centered value label */}
        <div
          className="absolute w-full pointer-events-none flex flex-col items-center"
          style={{ bottom: `${meopPct.toFixed(2)}%` }}
        >
          <span className="text-sm font-mono font-extrabold text-red-400 whitespace-nowrap mb-0.5">
            {meop}
          </span>
          <div className="w-full border-t-2 border-dashed border-red-500/85" />
        </div>

        {/* NOP threshold line with centered value label */}
        <div
          className="absolute w-full pointer-events-none flex flex-col items-center"
          style={{ bottom: `${nopPct.toFixed(2)}%` }}
        >
          <span className="text-sm font-mono font-extrabold text-yellow-400 whitespace-nowrap mb-0.5">
            {nop}
          </span>
          <div className="w-full border-t-2 border-dashed border-yellow-500/85" />
        </div>
        {/* Fill top edge */}
        {sane && value !== null && displayHeight > 0.5 && (
          <div
            className="absolute w-full pointer-events-none"
            style={{
              bottom: `${displayHeight}%`,
              borderTop: `2px solid ${barColor}`,
              filter: 'brightness(1.5)',
            }}
          />
        )}
      </div>

      <div className="flex-shrink-0 text-center leading-none">
        <div className={`${compact ? 'text-xs' : 'text-2xl'} font-bold font-mono tabular-nums`} style={{ color: barColor }}>
          {value !== null ? fmtPressure(value) : '---'}
        </div>
        <div className={`${compact ? 'text-[9px]' : 'text-sm'} text-gray-400 font-semibold`}>{unit}</div>
      </div>
    </div>
  );
}
