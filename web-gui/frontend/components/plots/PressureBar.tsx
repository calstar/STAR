'use client'

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  unit?: string;
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
  if (value <= 0) return 0;
  if (value >= maxVal) return 100;

  const safeEdge    = nop * 0.7;
  const safePct     = 35;
  const warningPct  = 60;
  const dangerPct   = 85;

  if (value <= safeEdge) {
    return (value / safeEdge) * safePct;
  } else if (value <= nop) {
    const frac = (value - safeEdge) / (nop - safeEdge);
    return safePct + frac * (warningPct - safePct);
  } else if (value <= meop) {
    const frac = (value - nop) / (meop - nop);
    return warningPct + frac * (dangerPct - warningPct);
  } else {
    const frac = (value - meop) / (maxVal - meop);
    return dangerPct + frac * (100 - dangerPct);
  }
}

export default function PressureBar({
  label,
  value,
  nop  = 500,
  meop = 700,
  color,
  unit = 'PSI',
}: PressureBarProps) {
  const displayValue = value ?? 0;
  const maxVal = Math.max(meop * 1.3, 1000);

  const sane = isFinite(displayValue) && Math.abs(displayValue) < 100000;

  // Non-linear percentage for fill and threshold lines
  const valuePct = sane ? Math.min(Math.max(nonLinearPct(displayValue, nop, meop, maxVal), 0), 100) : 0;
  const nopPct   = nonLinearPct(nop, nop, meop, maxVal);
  const meopPct  = nonLinearPct(meop, nop, meop, maxVal);

  let barColor = color;
  if (!barColor) {
    barColor = sane && displayValue > meop ? '#E74C3C' : sane && displayValue > nop ? '#F39C12' : '#27AE60';
  }

  return (
    <div className="flex flex-col items-center h-full gap-1 min-h-0 overflow-hidden select-none">
      {/* Label */}
      <div className="text-sm font-bold uppercase tracking-wider text-gray-300 text-center leading-none flex-shrink-0 truncate w-full">
        {label}
      </div>

      {/* Bar — takes all remaining space */}
      <div
        className="relative w-full flex-1 rounded border border-gray-700 overflow-hidden min-h-0"
        style={{ background: '#0d0d0d', maxHeight: '100%' }}
      >
        {sane && value !== null && (
          <div
            className="absolute bottom-0 w-full transition-[height] duration-100"
            style={{
              height:     `${valuePct}%`,
              background: barColor,
            }}
          />
        )}

        {/* MEOP threshold */}
        <div
          className="absolute w-full pointer-events-none"
          style={{ bottom: `${meopPct.toFixed(2)}%`, borderTop: '2px dashed rgba(231,76,60,0.85)' }}
        />
        {/* NOP threshold */}
        <div
          className="absolute w-full pointer-events-none"
          style={{ bottom: `${nopPct.toFixed(2)}%`, borderTop: '2px dashed rgba(243,156,18,0.85)' }}
        />
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
      </div>

      {/* Value + unit */}
      <div className="flex-shrink-0 text-center leading-none">
        <div className="text-lg font-bold font-mono tabular-nums" style={{ color: barColor }}>
          {value !== null ? fmtPressure(value) : '---'}
        </div>
        <div className="text-[10px] text-gray-500">{unit}</div>
      </div>
    </div>
  );
}
