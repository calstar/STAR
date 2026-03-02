'use client'

import { useSensorValue } from '@/lib/store';

interface SensorReadoutProps {
  label: string;
  entity: string;
  component: string;
  unit?: string;
  color: string;
  decimals?: number;
}

function formatWithCommas(value: number, decimals: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function ReadoutBox({
  label,
  entity,
  component,
  unit = 'PSI',
  color,
  decimals = 1,
  compact = false,
}: SensorReadoutProps & { compact?: boolean }) {
  const value = useSensorValue(entity, component);
  const display = value !== null ? formatWithCommas(value, decimals) : '---';
  if (compact) {
    return (
      <div className="bg-white/[0.02] backdrop-blur-md border border-white/5 rounded-lg px-3 py-2 flex items-center gap-3 min-w-0 hover:bg-white/[0.04] hover:shadow-md transition-all duration-300 flex-1">
        <span className="text-xs text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
        <span className="text-lg font-black font-mono tabular-nums ml-auto" style={{ color, textShadow: `0 0 8px ${color}50` }}>
          {display}
        </span>
        <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">{unit}</span>
      </div>
    );
  }
  return (
    <div className="bg-white/[0.02] backdrop-blur-md border border-white/5 rounded-xl px-5 py-3.5 flex items-center gap-4 min-w-0 hover:bg-white/[0.04] hover:shadow-lg transition-all duration-300 flex-1">
      <span className="text-[13px] text-gray-400 font-bold uppercase tracking-widest truncate">{label}</span>
      <span className="text-3xl font-black font-mono tabular-nums ml-auto" style={{ color, textShadow: `0 0 15px ${color}60` }}>
        {display}
      </span>
      <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">{unit}</span>
    </div>
  );
}

interface SensorReadoutStripProps {
  sensors: SensorReadoutProps[];
  variant?: 'default' | 'compact';
}

export default function SensorReadoutStrip({ sensors, variant = 'default' }: SensorReadoutStripProps) {
  const compact = variant === 'compact';
  return (
    <div className="flex flex-wrap gap-1.5">
      {sensors.map((s) => (
        <ReadoutBox key={`${s.entity}.${s.component}`} {...s} compact={compact} />
      ))}
    </div>
  );
}

export { ReadoutBox };
