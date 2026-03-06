'use client'

import { useSensorStore } from '@/lib/store';
import { useEffect, useMemo } from 'react';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, MissionStartTime, CommandPayload, BoardStatus, BoardStatusPayload, NotificationPayload, ActuatorUpdate, ActuatorState } from '@/lib/types';
import WindowLauncher from '@/components/windows/WindowLauncher';
import { useSensorValue, useActuatorCommandedState } from '@/lib/store';
import { PRESSURE_SENSORS } from '@/lib/sensor-colors';
import { useControlMode } from '@/lib/control-mode';

// ── Sensor value card ────────────────────────────────────────────────────────
interface SensorCardProps {
  label: string;
  entity: string;
  component: string;
  unit?: string;
  color: string;
  nop?: number;
  meop?: number;
}

function SensorCard({ label, entity, component, unit = 'PSI', color, nop, meop }: SensorCardProps) {
  const value = useSensorValue(entity, component);

  let valueColor = color;
  let statusClass = 'border-gray-800';
  if (value !== null && meop && value > meop) {
    valueColor = '#E74C3C';
    statusClass = 'border-red-700 bg-red-950/20';
  } else if (value !== null && nop && value > nop) {
    valueColor = '#F39C12';
    statusClass = 'border-yellow-700 bg-yellow-950/20';
  }

  return (
    <div className={`bg-card border rounded-lg px-3 py-2 hover:border-gray-600 transition-all ${statusClass}`}>
      <div className="text-xs text-text-muted font-semibold tracking-wider uppercase truncate mb-0.5">
        {label}
      </div>

      {/* Current value */}
      <div
        className="text-2xl font-bold font-mono tabular-nums leading-tight"
        style={{ color: valueColor }}
      >
        {value !== null ? value.toFixed(1) : <span className="text-gray-700">---</span>}
      </div>

      {/* Unit */}
      <div className="text-[10px] text-text-muted mt-0.5">{unit}</div>
    </div>
  );
}

// ── Actuator status pill ─────────────────────────────────────────────────────
function ActuatorPill({ label, entity }: { label: string; entity: string }) {
  const commanded = useActuatorCommandedState(entity);
  const hasData = commanded !== null;
  const isOpen = commanded === ActuatorState.OPEN;

  return (
    <div className={`flex flex-col items-center justify-center bg-card border rounded-xl px-3 py-3 gap-2.5 transition-all min-h-[100px] ${!hasData ? 'border-gray-800' : isOpen ? 'border-green-700/80' : 'border-red-700/80'
      }`}>
      <span className="text-xs font-bold text-text-muted uppercase tracking-wider text-center leading-tight">{label}</span>
      <span
        className={`text-xl font-bold font-mono px-3 py-2 rounded-lg w-full text-center ${!hasData ? 'text-gray-600 bg-gray-900/40' : isOpen ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
          }`}
      >
        {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
      </span>
    </div>
  );
}

// ── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div className={`w-1.5 h-5 rounded-full ${color}`} />
      <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase">{children}</h2>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function Home() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
  const updateMissionStartTime = useSensorStore((state) => state.updateMissionStartTime);
  const updateBoards = useSensorStore((state) => state.updateBoards);
  const updateNotification = useSensorStore((state) => state.updateNotification);
  const updateActuator = useSensorStore((s) => s.updateActuator);
  const updateActuatorExpectedPositions = useSensorStore((s) => s.updateActuatorExpectedPositions);
  const boardsMap = useSensorStore((state) => state.boards as Record<number, BoardStatus>);
  const ws = getWebSocketClient();
  const { controlEnabled } = useControlMode();

  const boards = useMemo(() => {
    const map = boardsMap ?? {};
    return Object.values(map).sort((a, b) => {
      if (a.type !== b.type) return a.type.localeCompare(b.type);
      const an = a.boardNumber ?? Number.MAX_SAFE_INTEGER;
      const bn = b.boardNumber ?? Number.MAX_SAFE_INTEGER;
      if (an !== bn) return an - bn;
      return a.id - b.id;
    });
  }, [boardsMap]);

  useEffect(() => {
    ws.connect();
  }, [ws]);

  const pressureSensors: SensorCardProps[] = [
    ...PRESSURE_SENSORS.map((s) => ({
      label: s.label.replace('Upstream', 'Up').replace('Downstream', 'Down'),
      entity: s.entity,
      component: s.component,
      color: s.color,
      nop: s.nop,
      meop: s.meop,
    })),
  ];

  // Show all actuators (matching Controls page)
  const { actuators: actuatorsFromConfig } = useActuatorsFromConfig();
  const actuators = actuatorsFromConfig.map((a) => ({ label: a.name, entity: a.entity }));

  const hasAbortDoneBoard = boards.some((b) => b.boardState === 4);

  return (
    <main className="flex-1 bg-background text-text flex flex-col overflow-auto">
      <div className="w-full px-3 py-2 flex flex-col gap-2 flex-1">

        {/* ── Safety controls ───────────────────────────────────────────── */}
        <div className="flex items-center justify-between mb-1">
          <SectionHeader color="bg-red-500">Safety</SectionHeader>
          <button
            type="button"
            disabled={!hasAbortDoneBoard || !controlEnabled}
            onClick={() => {
              if (!controlEnabled) return;
              const cmd: CommandPayload = {
                commandType: 'clear_abort',
                data: {},
              };
              ws.sendCommand(cmd);
            }}
            className={`px-4 py-1.5 rounded-md text-sm font-semibold border transition-colors ${hasAbortDoneBoard && controlEnabled
                ? 'border-red-500 text-red-200 bg-red-900/40 hover:bg-red-800/60'
                : 'border-gray-700 text-gray-500 bg-gray-900/40 cursor-not-allowed'
              }`}
          >
            Clear Abort (Sync Actuators)
          </button>
        </div>

        {/* ── Sensors ────────────────────────────────────────────────── */}
        <div>
          <SectionHeader color="bg-blue-500">Live Pressures</SectionHeader>
          <div className="grid grid-cols-5 lg:grid-cols-9 gap-2">
            {pressureSensors.map((s) => (
              <SensorCard key={s.label} {...s} />
            ))}
          </div>
        </div>

        {/* ── Actuators ──────────────────────────────────────────────── */}
        <div>
          <SectionHeader color="bg-purple-500">Actuators</SectionHeader>
          <div className="grid grid-cols-4 lg:grid-cols-7 gap-2">
            {actuators.map((a) => (
              <ActuatorPill key={a.label} {...a} />
            ))}
          </div>
        </div>

        {/* ── Windows ─────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">
          <SectionHeader color="bg-green-500">Windows</SectionHeader>
          <div className="flex-1">
            <WindowLauncher />
          </div>
        </div>

      </div>
    </main>
  );
}
