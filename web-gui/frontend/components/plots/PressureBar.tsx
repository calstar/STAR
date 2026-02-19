'use client'

import { useSensorStore } from '@/lib/store';

interface PressureBarProps {
  label: string;
  value: number | null;
  nop?: number; // Normal Operating Pressure
  meop?: number; // Maximum Expected Operating Pressure
  color?: string;
  unit?: string;
  height?: number;
}

export default function PressureBar({
  label,
  value,
  nop = 500.0,
  meop = 700.0,
  color,
  unit = 'PSI',
  height = 200,
}: PressureBarProps) {
  const displayValue = value !== null ? value : 0;

  // Use a fixed maximum range based on MEOP, with some headroom
  // This ensures consistent scaling across all bars
  const maxVal = Math.max(meop * 1.2, 1000, 100);
  const barHeight = height - 80; // Account for label and value display

  // Calculate positions: bottom is 0, top is maxVal
  // So position = (value / maxVal) * barHeight from bottom
  const valuePosition = displayValue > 0 ? (displayValue / maxVal) * barHeight : 0;
  const nopPosition = (nop / maxVal) * barHeight;
  const meopPosition = (meop / maxVal) * barHeight;

  // Clamp positions to bar bounds
  const clampedValuePos = Math.min(Math.max(valuePosition, 0), barHeight);
  const clampedNopPos = Math.min(Math.max(nopPosition, 0), barHeight);
  const clampedMeopPos = Math.min(Math.max(meopPosition, 0), barHeight);

  // Determine color based on NOP/MEOP thresholds
  let barColor = color;
  if (!barColor) {
    if (displayValue > meop) {
      barColor = '#E74C3C'; // Red - over MEOP
    } else if (displayValue > nop) {
      barColor = '#F39C12'; // Orange - over NOP
    } else {
      barColor = '#27AE60'; // Green - normal
    }
  }

  return (
    <div className="flex flex-col items-center justify-end" style={{ height: `${height}px`, minWidth: '80px' }}>
      <div className="text-sm font-semibold mb-2 text-center">{label}</div>

      <div className="relative w-16 bg-gray-800 rounded-lg overflow-hidden" style={{ height: `${barHeight}px` }}>
        {/* Background fill - shows the full range */}
        <div className="absolute bottom-0 w-full bg-gray-700" style={{ height: `${barHeight}px` }} />

        {/* NOP threshold line (yellow) */}
        {nop > 0 && nop <= maxVal && (
          <div
            className="absolute w-full border-t-2 border-yellow-400 opacity-70 z-10"
            style={{
              bottom: `${clampedNopPos}px`,
            }}
          />
        )}

        {/* MEOP threshold line (red/pink) */}
        {meop > 0 && meop <= maxVal && (
          <div
            className="absolute w-full border-t-2 border-red-400 opacity-70 z-10"
            style={{
              bottom: `${clampedMeopPos}px`,
            }}
          />
        )}

        {/* Current value indicator line (dashed, colored) */}
        {value !== null && displayValue > 0 && (
          <div
            className="absolute w-full border-t-2 opacity-90 z-20"
            style={{
              bottom: `${clampedValuePos}px`,
              borderColor: barColor,
              borderStyle: 'dashed',
            }}
          />
        )}
      </div>

      {/* Value display */}
      <div className="mt-2 text-center">
        <div className="text-lg font-bold" style={{ color: barColor }}>
          {value !== null ? value.toFixed(1) : '---'}
        </div>
        <div className="text-xs text-text-muted">{unit}</div>
      </div>
    </div>
  );
}
