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
      <div className="flex min-w-0 flex-1 items-baseline gap-3 border border-line px-3 py-2">
        <span className="truncate font-mono text-[11px] uppercase tracking-[0.12em] text-ink-2">{label}</span>
        <span className="ml-auto font-mono text-lg leading-none tabular-nums" style={{ color }}>
          {display}
        </span>
        <span className="font-mono text-[10px] uppercase text-ink-3">{unit}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 items-baseline gap-4 border border-line px-5 py-3">
      <span className="caps truncate">{label}</span>
      <span className="ml-auto font-mono text-[30px] leading-none tabular-nums" style={{ color }}>
        {display}
      </span>
      <span className="font-mono text-[12px] uppercase tracking-[0.08em] text-ink-3">{unit}</span>
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
