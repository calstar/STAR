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

function ReadoutBox({ label, entity, component, unit = 'PSI', color, decimals = 1 }: SensorReadoutProps) {
  const value = useSensorValue(entity, component);
  return (
    <div className="bg-gray-900/60 rounded-lg px-5 py-3 flex items-center gap-4 min-w-0">
      <span className="text-base text-text-muted font-bold uppercase tracking-wider truncate">{label}</span>
      <span className="text-3xl font-bold font-mono tabular-nums ml-auto" style={{ color }}>
        {value !== null ? value.toFixed(decimals) : '---'}
      </span>
      <span className="text-sm text-gray-400 font-semibold">{unit}</span>
    </div>
  );
}

interface SensorReadoutStripProps {
  sensors: SensorReadoutProps[];
}

export default function SensorReadoutStrip({ sensors }: SensorReadoutStripProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sensors.map((s) => (
        <ReadoutBox key={`${s.entity}.${s.component}`} {...s} />
      ))}
    </div>
  );
}

export { ReadoutBox };

