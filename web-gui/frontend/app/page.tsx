'use client'

import { useSensorStore, useActuatorCommandedState, useActuatorStateByEntity, useSensorValue } from '@/lib/store';
import { useEffect, useMemo } from 'react';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, MissionStartTime, CommandPayload, BoardStatus, BoardStatusPayload, NotificationPayload } from '@/lib/types';
import WindowLauncher from '@/components/windows/WindowLauncher';
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
  let statusClass = 'border-white/5';
  if (value !== null && meop && value > meop) {
    valueColor = '#F43F5E';
    statusClass = 'border-rose-500/50 shadow-[0_0_15px_rgba(244,63,94,0.2)] bg-rose-950/20';
  } else if (value !== null && nop && value > nop) {
    valueColor = '#FBBF24';
    statusClass = 'border-yellow-500/50 shadow-[0_0_15px_rgba(251,191,36,0.2)] bg-yellow-950/20';
  }

  return (
    <div className={`bg-white/[0.02] backdrop-blur-md rounded-xl px-4 py-3 hover:bg-white/[0.04] hover:shadow-xl transition-all duration-300 group border ${statusClass}`}>
      <div className="text-[11px] text-gray-400 font-bold tracking-widest uppercase truncate mb-1.5 group-hover:text-gray-300 transition-colors">
        {label}
      </div>

      {/* Current value */}
      <div
        className="text-3xl font-black font-mono tabular-nums leading-none tracking-tight"
        style={{ color: valueColor, textShadow: `0 0 12px ${valueColor}60` }}
      >
        {value !== null ? value.toFixed(1) : <span className="text-gray-600">---</span>}
      </div>

      {/* Unit */}
      <div className="text-[10px] text-gray-500 font-semibold tracking-wider uppercase mt-1.5">{unit}</div>
    </div>
  );
}

// ── Actuator status pill (same source of truth as Controls pane: commanded + actual from store) ──
function ActuatorPill({ label, entity }: { label: string; entity: string }) {
  const commanded = useActuatorCommandedState(entity);
  const actual = useActuatorStateByEntity(entity);
  const status = useSensorValue(entity, 'status');
  const adc = useSensorValue(entity, 'raw_adc_counts');
  const sensorOpen = status === 1 || (adc !== null && adc > 1000);
  const hasSensor = status !== null || adc !== null;
  const actualOpen = actual === 1;
  const actualClosed = actual === 0;
  const hasActual = actual === 0 || actual === 1;
  const showCommanded = commanded !== null ? (commanded === 1 ? 'OPEN' : 'CLOSED') : null;
  const showActual = hasActual ? (actualOpen ? 'OPEN' : 'CLOSED') : (hasSensor ? (sensorOpen ? 'OPEN' : 'CLOSED') : null);
  const display = showCommanded ?? showActual ?? '---';
  const isOpen = display === 'OPEN';
  const mismatch = showCommanded != null && showActual != null && showCommanded !== showActual;

  return (
    <div className={`flex flex-col items-center justify-center bg-white/[0.02] backdrop-blur-md rounded-xl px-3 py-3 gap-2.5 transition-all duration-300 min-h-[105px] group hover:bg-white/[0.04] hover:shadow-xl border ${display === '---' ? 'border-white/5' : mismatch ? 'border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.2)] bg-yellow-950/20' : isOpen ? 'border-emerald-500/30' : 'border-rose-500/30'
      }`}>
      <span className="text-[11px] font-bold text-gray-400 uppercase tracking-widest text-center leading-tight group-hover:text-gray-300 transition-colors">{label}</span>
      {mismatch && <span className="text-[10px] font-bold text-yellow-400 uppercase animate-pulse drop-shadow-[0_0_5px_rgba(234,179,8,0.5)]">MISMATCH</span>}
      <span
        className={`text-xl font-black font-mono px-3 py-2 rounded-lg w-full text-center transition-colors duration-500 shadow-inner ${display === '---' ? 'text-gray-600 bg-gray-900/40 border border-gray-800/50' : isOpen ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shadow-[0_0_12px_rgba(16,185,129,0.15)]' : 'bg-rose-500/20 text-rose-400 border border-rose-500/30 shadow-[0_0_12px_rgba(244,63,94,0.15)]'
          }`}
      >
        {display}
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
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.on(MessageType.MISSION_START_TIME, (p: unknown) => {
      const payload = p as MissionStartTime;
      updateMissionStartTime(payload.missionStartTime);
    });
    const u4 = ws.on(MessageType.BOARD_STATUS_UPDATE, (p: unknown) => {
      const payload = p as BoardStatusPayload;
      if (payload?.boards) updateBoards(payload.boards as BoardStatus[]);
    });
    const u5 = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    const u6 = ws.on(MessageType.NOTIFICATION, (p: unknown) => updateNotification(p as NotificationPayload));
    return () => { u1(); u2(); u3(); u4(); u5(); u6(); };
  }, [ws, updateSensor, updateState, updateConnectionStatus, updateMissionStartTime, updateBoards, updateNotification]);

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
            className={`px-4 py-1.5 rounded-md text-sm font-semibold border transition-colors ${
              hasAbortDoneBoard && controlEnabled
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
