'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { useSensorConfig } from '@/lib/sensor-config';
import { PRESSURE_SENSORS } from '@/lib/sensor-colors';
import { SystemState, engineStateCodeToLabel } from '@/lib/types';
import { getServerTimeNow } from '@/lib/server-time';

type PressureOption = {
  entity: string;
  label: string;
  nop?: number;
  meop?: number;
};

const LEFT_STORAGE_KEY = 'diablo-livestream-left-pt';
const RIGHT_STORAGE_KEY = 'diablo-livestream-right-pt';
const CHROMA_KEY_BACKGROUND = '#000000';
const DIAL_START_ANGLE = 230;
const DIAL_END_ANGLE = 490;

function formatTimerSegment(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function formatMissionTimer(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // Livestream pane uses 2-digit hours (e.g. 00:10:00) rather than 3-digit (000:10:00).
  return `${formatTimerSegment(hours, 2)}:${formatTimerSegment(minutes)}:${formatTimerSegment(seconds)}`;
}

function useMissionTimer() {
  const countdownTargetTimeMs = useSensorStore((s) => s.countdownTargetTimeMs);
  const [now, setNow] = useState(() => getServerTimeNow());

  useEffect(() => {
    const id = window.setInterval(() => setNow(getServerTimeNow()), 250);
    return () => window.clearInterval(id);
  }, []);

  return useMemo(() => {
    if (countdownTargetTimeMs == null || countdownTargetTimeMs <= 0) {
      return {
        prefix: 'T',
        value: '--:--:--',
        sublabel: 'Awaiting countdown target',
      };
    }

    const deltaMs = countdownTargetTimeMs - now;
    const countdownActive = deltaMs > 0;

    return {
      prefix: countdownActive ? 'T-' : 'T+',
      value: formatMissionTimer(Math.abs(deltaMs)),
      sublabel: countdownActive ? 'Countdown to T0' : 'Elapsed since T0',
    };
  }, [countdownTargetTimeMs, now]);
}

function formatPressure(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '---';
  if (Math.abs(value) >= 1000) return value.toFixed(0);
  return value.toFixed(1);
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const radians = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(radians),
    y: cy + r * Math.sin(radians),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function PressureDial({
  selectedEntity,
  options,
  onSelect,
}: {
  selectedEntity: string | null;
  options: PressureOption[];
  onSelect: (entity: string) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selected = useMemo(
    () => options.find((option) => option.entity === selectedEntity) ?? options[0] ?? null,
    [options, selectedEntity]
  );
  const value = useSensorValue(selected?.entity ?? '', 'pressure_psi');
  const progress = useMemo(() => {
    const maxValue = Math.max(selected?.meop ?? 100, 1);
    const safeValue = Math.max(0, value ?? 0);
    return Math.min(safeValue / maxValue, 1);
  }, [selected, value]);

  useEffect(() => {
    if (!menuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [menuOpen]);

  const trackPath = useMemo(
    () => describeArc(100, 100, 76, DIAL_START_ANGLE, DIAL_END_ANGLE),
    []
  );
  const progressPath = useMemo(() => {
    const angle = DIAL_START_ANGLE + (DIAL_END_ANGLE - DIAL_START_ANGLE) * progress;
    return describeArc(100, 100, 76, DIAL_START_ANGLE, angle);
  }, [progress]);

  return (
    <div ref={containerRef} className="relative flex items-center justify-center">
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        className="relative flex aspect-square w-[150px] items-center justify-center bg-transparent p-3 lg:w-[170px]"
      >
        <svg viewBox="0 0 200 200" className="absolute inset-0 h-full w-full">
          <path d={trackPath} fill="none" stroke="#6b7280" strokeWidth="6" strokeLinecap="round" />
          {progress > 0 && (
            <path d={progressPath} fill="none" stroke="#ffffff" strokeWidth="6" strokeLinecap="round" />
          )}
        </svg>

        <div className="pointer-events-none flex max-w-[72%] flex-col items-center justify-center px-4 text-center">
          <span className="line-clamp-2 break-words text-[9px] font-semibold uppercase leading-tight tracking-[0.08em] text-neutral-300">
            {selected?.label ?? 'Select PT'}
          </span>
          <span className="mt-1 font-mono text-[clamp(1.75rem,2vw,2.6rem)] font-medium tabular-nums text-white">
            {formatPressure(value)}
          </span>
          <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-neutral-300">PSI</span>
        </div>
      </button>

      {menuOpen && (
        <div
          className="absolute bottom-full left-1/2 z-20 mb-3 max-h-72 w-[min(22rem,85vw)] -translate-x-1/2 overflow-y-auto rounded-2xl border border-white p-2"
          style={{ backgroundColor: CHROMA_KEY_BACKGROUND }}
        >
          {options.map((option) => {
            const active = option.entity === selected?.entity;
            return (
              <button
                key={option.entity}
                type="button"
                onClick={() => {
                  onSelect(option.entity);
                  setMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition ${
                  active ? 'bg-white text-black' : 'text-white hover:bg-white/10'
                }`}
              >
                <span className="text-sm font-semibold">{option.label}</span>
                <span className={`text-xs font-mono ${active ? 'text-black/70' : 'text-white/80'}`}>{option.entity}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function LivestreamStatsPane() {
  const sensors = useSensorConfig();
  const currentState = useSensorStore((s) => s.currentState);
  const timer = useMissionTimer();
  const [leftEntity, setLeftEntity] = useState<string | null>(null);
  const [rightEntity, setRightEntity] = useState<string | null>(null);

  const pressureOptions = useMemo<PressureOption[]>(() => {
    const configBacked = sensors
      .filter((sensor) => {
        const calEntity = sensor.calEntity;
        return calEntity.startsWith('PT_Cal.') || /^PT\d+_Cal\.CH\d+$/.test(calEntity);
      })
      .map((sensor) => {
        const known = PRESSURE_SENSORS.find((entry) => entry.entity === sensor.calEntity);
        return {
          entity: sensor.calEntity,
          label: sensor.role,
          nop: known?.nop,
          meop: known?.meop,
        };
      });

    const unique = new Map<string, PressureOption>();
    for (const option of configBacked) {
      if (!unique.has(option.entity)) unique.set(option.entity, option);
    }

    if (unique.size === 0) {
      for (const sensor of PRESSURE_SENSORS) {
        unique.set(sensor.entity, {
          entity: sensor.entity,
          label: sensor.label,
          nop: sensor.nop,
          meop: sensor.meop,
        });
      }
    }

    return Array.from(unique.values());
  }, [sensors]);

  useEffect(() => {
    if (pressureOptions.length === 0) return;

    const validEntities = new Set(pressureOptions.map((option) => option.entity));
    const storedLeft = typeof window !== 'undefined' ? window.localStorage.getItem(LEFT_STORAGE_KEY) : null;
    const storedRight = typeof window !== 'undefined' ? window.localStorage.getItem(RIGHT_STORAGE_KEY) : null;
    const defaultLeft = storedLeft && validEntities.has(storedLeft) ? storedLeft : pressureOptions[0]?.entity ?? null;
    const defaultRightCandidate = pressureOptions[1]?.entity ?? pressureOptions[0]?.entity ?? null;
    const defaultRight = storedRight && validEntities.has(storedRight) ? storedRight : defaultRightCandidate;

    setLeftEntity((current) => (current && validEntities.has(current) ? current : defaultLeft));
    setRightEntity((current) => (current && validEntities.has(current) ? current : defaultRight));
  }, [pressureOptions]);

  useEffect(() => {
    if (leftEntity && typeof window !== 'undefined') {
      window.localStorage.setItem(LEFT_STORAGE_KEY, leftEntity);
    }
  }, [leftEntity]);

  useEffect(() => {
    if (rightEntity && typeof window !== 'undefined') {
      window.localStorage.setItem(RIGHT_STORAGE_KEY, rightEntity);
    }
  }, [rightEntity]);

  const effectiveState = currentState ?? SystemState.IDLE;
  const stateLabel = engineStateCodeToLabel(effectiveState);

  return (
    <main className="h-full min-h-0 overflow-hidden text-white" style={{ backgroundColor: CHROMA_KEY_BACKGROUND }}>
      <div className="relative h-full w-full">
        <div className="absolute bottom-10 left-0 right-0 flex items-center justify-center">
          <div className="relative flex w-full max-w-[1500px] items-center justify-center px-10">
            <div className="absolute left-8 top-1/2 flex -translate-y-1/2 flex-col justify-center">
              <span className="mb-2 text-[11px] font-semibold uppercase tracking-[0.35em] text-white/80">
                Engine State
              </span>
              <span className="text-[clamp(1.5rem,2.1vw,2.5rem)] font-black uppercase leading-none text-white">
                {stateLabel}
              </span>
            </div>

            <div className="flex items-center justify-center gap-6">
              <PressureDial
                selectedEntity={leftEntity}
                options={pressureOptions}
                onSelect={setLeftEntity}
              />

              <div className="flex min-w-[360px] flex-col items-center justify-center text-center">
                <div className="font-mono text-[clamp(1.2rem,2vw,2.1rem)] font-semibold leading-none tabular-nums text-white">
                  {timer.prefix} {timer.value}
                </div>
                <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.28em] text-white/80">
                  Diablo Hotifre Test
                </div>
              </div>

              <PressureDial
                selectedEntity={rightEntity}
                options={pressureOptions}
                onSelect={setRightEntity}
              />
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
