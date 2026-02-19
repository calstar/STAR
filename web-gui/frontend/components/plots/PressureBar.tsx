'use client'

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number;
  meop?: number;
  color?: string;
  unit?: string;
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

  // All CSS percentages relative to bar height
  const pct       = (v: number) => `${Math.min(Math.max((v / maxVal) * 100, 0), 100).toFixed(2)}%`;
  const valuePct  = Math.min(Math.max((displayValue / maxVal) * 100, 0), 100);

  let barColor = color;
  if (!barColor) {
    barColor = displayValue > meop ? '#E74C3C' : displayValue > nop ? '#F39C12' : '#27AE60';
  }

  return (
    <div className="flex flex-col items-center h-full gap-1 min-h-0 select-none">
      {/* Label above bar */}
      <div className="text-[9px] font-bold uppercase tracking-wider text-gray-500 text-center leading-none flex-shrink-0 truncate w-full text-center px-0.5">
        {label}
      </div>

      {/* Bar — fills all remaining height */}
      <div
        className="relative w-full flex-1 rounded-sm border border-gray-700 overflow-hidden min-h-0"
        style={{ background: '#0d0d0d' }}
      >
        {/* Gradient fill from bottom */}
        {value !== null && (
          <div
            className="absolute bottom-0 w-full transition-[height] duration-100"
            style={{
              height:     `${valuePct}%`,
              background: `linear-gradient(to top, ${barColor}, ${barColor}55)`,
            }}
          />
        )}

        {/* MEOP dashed threshold line */}
        <div
          className="absolute w-full pointer-events-none"
          style={{
            bottom:    pct(meop),
            borderTop: '1.5px dashed rgba(231,76,60,0.85)',
          }}
        />

        {/* NOP dashed threshold line */}
        <div
          className="absolute w-full pointer-events-none"
          style={{
            bottom:    pct(nop),
            borderTop: '1.5px dashed rgba(243,156,18,0.85)',
          }}
        />

        {/* Bright top edge on the fill — makes current level obvious */}
        {value !== null && valuePct > 0.5 && (
          <div
            className="absolute w-full pointer-events-none"
            style={{
              bottom:    `${valuePct}%`,
              borderTop: `2px solid ${barColor}`,
              filter:    'brightness(1.5)',
            }}
          />
        )}
      </div>

      {/* Numeric value */}
      <div className="flex-shrink-0 text-center leading-none">
        <div className="text-[11px] font-bold font-mono" style={{ color: barColor }}>
          {value !== null ? value.toFixed(0) : '---'}
        </div>
        <div className="text-[9px] text-gray-700">{unit}</div>
      </div>
    </div>
  );
}
