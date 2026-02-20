'use client'

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  unit?: string;
  showLabels?: boolean; // Show NOP/MEOP labels on this bar (default true)
}

function fmtPressure(v: number): string {
  if (!isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs > 99999) return '---';
  if (abs >= 1000)  return v.toFixed(0);
  if (abs >= 100)   return v.toFixed(0);
  if (abs >= 1)     return v.toFixed(1);
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

  const safeEdge    = nop * 0.7;
  const safePct     = 35;
  const warningPct  = 60;
  const dangerPct   = 85;

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

// Ensure bars always grow upward - never shrink below previous value
let lastValuePct = 0;

export default function PressureBar({
  label,
  value,
  nop  = 500,
  meop = 700,
  color,
  unit = 'PSI',
  showLabels = true,
}: PressureBarProps) {
  const displayValue = value ?? 0;
  const maxVal = Math.max(meop * 1.3, 1000);

  const sane = isFinite(displayValue) && Math.abs(displayValue) < 100000;

  // Non-linear percentage for fill and threshold lines
  // Always use positive value for calculation - bars only grow upward
  const clampedDisplayValue = Math.max(0, displayValue);
  const valuePct = sane ? Math.min(Math.max(nonLinearPct(clampedDisplayValue, nop, meop, maxVal), 0), 100) : 0;
  const nopPct   = nonLinearPct(nop, nop, meop, maxVal);
  const meopPct  = nonLinearPct(meop, nop, meop, maxVal);

  let barColor = color;
  if (!barColor) {
    barColor = sane && displayValue > meop ? '#E74C3C' : sane && displayValue > nop ? '#F39C12' : '#27AE60';
  }

  return (
    <div className="flex flex-col items-center h-full gap-1 min-h-0 overflow-visible select-none w-full">
      {/* Label */}
      <div className="text-base font-semibold uppercase tracking-wider text-gray-300 text-center leading-none flex-shrink-0 truncate w-full">
        {label}
      </div>

      {/* Bar — takes all remaining space */}
      <div
        className="relative w-full flex-1 rounded border border-gray-700 overflow-visible min-h-0"
        style={{ background: '#0d0d0d', maxHeight: '100%', overflow: 'visible' }}
      >
        {sane && value !== null && (
          <div
            className="absolute bottom-0 w-full"
            style={{
              height:     `${Math.max(0, valuePct)}%`,
              background: barColor,
              minHeight:  '0%',
              transition: valuePct > (window.lastBarHeight || 0) ? 'height 0.1s ease-out' : 'none',
            }}
            ref={(el) => {
              if (el) {
                (window as any).lastBarHeight = valuePct;
              }
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
        {sane && value !== null && valuePct > 0.5 && (
          <div
            className="absolute w-full pointer-events-none"
            style={{
              bottom: `${valuePct}%`,
              borderTop: `2px solid ${barColor}`,
              filter: 'brightness(1.5)',
            }}
          />
        )}
        
        {/* Pressure value ON the bar itself */}
        {sane && value !== null && valuePct > 5 && (
          <div
            className="absolute w-full pointer-events-none flex items-center justify-center"
            style={{
              bottom: `${valuePct}%`,
              transform: 'translateY(-50%)',
            }}
          >
            <div className="bg-gray-900/90 px-1.5 py-0.5 rounded border border-gray-700">
              <div className="text-sm font-bold font-mono tabular-nums" style={{ color: barColor }}>
                {fmtPressure(value)}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Value + unit below bar (only if value is too low to show on bar) */}
      {(!sane || value === null || valuePct <= 5) && (
        <div className="flex-shrink-0 text-center leading-none">
          <div className="text-xl font-bold font-mono tabular-nums" style={{ color: barColor }}>
            {value !== null ? fmtPressure(value) : '---'}
          </div>
          <div className="text-xs text-gray-400 font-semibold">{unit}</div>
        </div>
      )}
    </div>
  );
}
