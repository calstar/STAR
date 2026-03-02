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
      <div className="bg-gray-900/60 rounded px-2.5 py-2 flex items-center gap-2 min-w-0">
        <span className="text-sm text-text-muted font-medium uppercase tracking-wider truncate">{label}</span>
        <span className="text-base font-mono tabular-nums ml-auto" style={{ color }}>
          {display}
        </span>
        <span className="text-sm text-gray-500">{unit}</span>
      </div>
    );
  }
  return (
    <div className="bg-gray-900/60 rounded-lg px-5 py-3 flex items-center gap-4 min-w-0">
      <span className="text-base text-text-muted font-bold uppercase tracking-wider truncate">{label}</span>
      <span className="text-3xl font-bold font-mono tabular-nums ml-auto" style={{ color }}>
        {display}
      </span>
      <span className="text-sm text-gray-400 font-semibold">{unit}</span>
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
