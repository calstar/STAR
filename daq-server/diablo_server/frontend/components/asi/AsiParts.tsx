'use client'

/**
 * Small pieces shared by the ASI Test and ASI Twin tabs.
 */

import { useMemo, type ReactNode } from 'react';
import { useSensorConfig } from '@/lib/sensor-config';
import { useActuatorsFromConfig, type ActuatorFromConfig } from '@/lib/actuators-from-config';
import { autoMapping, resolveMapping, useAsiSettings, type AsiMapping } from '@/lib/asi/settings';
import type { Verdict } from '@/lib/asi/checks';

export const ASI_COLORS = {
  gox: '#38BDF8',
  goxDn: '#0EA5E9',
  ch4: '#A78BFA',
  ch4Dn: '#8B5CF6',
  pc: '#F97316',
  tc: '#F472B6',
  bore: '#FB7185',
  neck: '#E879F9',
  of: '#4ADE80',
} as const;

export interface AsiHardware {
  mapping: AsiMapping;
  auto: AsiMapping;
  ptRoles: string[];
  tcRoles: string[];
  actuatorNames: string[];
  /** Calibrated entity per mapped sensor ('' when unmapped). */
  entities: { goxUp: string; goxDn: string; ch4Up: string; ch4Dn: string; tc: string };
  actuator: (name: string) => ActuatorFromConfig | undefined;
}

/** The DAQ roles behind each ASI part: explicit mapping, else auto-detected. */
export function useAsiHardware(): AsiHardware {
  const sensors = useSensorConfig();
  const { actuators } = useActuatorsFromConfig();
  const { settings } = useAsiSettings();
  return useMemo(() => {
    const ptRoles = sensors.filter((s) => s.type === 'PT').map((s) => s.role);
    const tcRoles = sensors.filter((s) => s.type === 'TC').map((s) => s.role);
    const actuatorNames = actuators.map((a) => a.name);
    const auto = autoMapping(ptRoles, tcRoles, actuatorNames, settings.model);
    const mapping = resolveMapping(settings.mapping, auto);
    const ent = (role: string) => (role ? sensors.find((s) => s.role === role)?.calEntity ?? '' : '');
    return {
      mapping, auto, ptRoles, tcRoles, actuatorNames,
      entities: {
        goxUp: ent(mapping.goxUp), goxDn: ent(mapping.goxDn),
        ch4Up: ent(mapping.ch4Up), ch4Dn: ent(mapping.ch4Dn), tc: ent(mapping.tc),
      },
      actuator: (name: string) => actuators.find((a) => a.name === name),
    };
  }, [sensors, actuators, settings.mapping, settings.model]);
}

export function Panel({ title, right, children, className = '' }: {
  title: ReactNode; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`flex min-w-0 flex-col border border-line bg-[#070707] ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h2 className="caps truncate">{title}</h2>
        {right}
      </header>
      <div className="min-h-0 flex-1 p-3">{children}</div>
    </section>
  );
}

export function Stat({ label, value, unit, color, hint }: {
  label: string; value: string; unit?: string; color?: string; hint?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col border border-line px-2.5 py-1.5" title={hint}>
      <span className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-ink-3">{label}</span>
      <span className="font-mono text-[17px] font-semibold tabular-nums leading-tight" style={{ color: color ?? 'var(--ink)' }}>
        {value}
        {unit && <span className="ml-1 text-[10px] font-normal text-ink-3">{unit}</span>}
      </span>
    </div>
  );
}

export function VerdictBadge({ verdict }: { verdict: Verdict | 'none' }) {
  const cls = verdict === 'pass' ? 'border-green-600 text-green-400'
    : verdict === 'fail' ? 'border-red-600 text-red-400'
    : verdict === 'warn' ? 'border-amber-600 text-amber-400'
    : 'border-line text-ink-4';
  return (
    <span className={`border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${cls}`}>
      {verdict === 'none' ? '—' : verdict}
    </span>
  );
}

export function NumField({ label, value, onChange, unit, step = 'any', note, width = 'w-24' }: {
  label: string; value: number; onChange: (v: number) => void; unit?: string; step?: number | 'any'; note?: string; width?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-2 py-0.5" title={note}>
      <span className="truncate font-mono text-[11px] text-ink-2">
        {label}
        {note && <span className="ml-1 text-ink-4">ⓘ</span>}
      </span>
      <span className="flex flex-shrink-0 items-center gap-1">
        <input
          type="number"
          step={step}
          value={Number.isFinite(value) ? value : ''}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(v);
          }}
          className={`${width} border border-line-strong bg-black px-1.5 py-0.5 text-right font-mono text-[12px] tabular-nums text-ink outline-none focus:border-[#5a5a5a]`}
        />
        {unit && <span className="w-12 font-mono text-[10px] text-ink-3">{unit}</span>}
      </span>
    </label>
  );
}

export function SubTabs<T extends string>({ tabs, value, onChange }: {
  tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-x-5 gap-y-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => onChange(t.id)}
          className={`relative pb-1.5 font-mono text-[12px] tracking-[0.04em] ${value === t.id ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
        >
          {t.label}
          {value === t.id && <span className="absolute inset-x-0 bottom-0 h-px bg-ink" />}
        </button>
      ))}
    </div>
  );
}

export const fmt = (v: number | null | undefined, digits = 0): string =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(digits);
