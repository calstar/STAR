'use client'

import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { startDataCache } from '@/lib/data-cache';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionStatus, SystemState, CommandPayload, StateUpdate, SensorUpdate, ActuatorUpdate, MessageType, NotificationPayload } from '@/lib/types';
import PressureBar from '@/components/plots/PressureBar';
import { getEntityColor } from '@/lib/sensor-colors';
import NotificationPanel from '@/components/dashboard/NotificationPanel';

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  20: 'PRESS STANDBY',
};

const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400',
  17: 'text-red-500',
  13: 'text-yellow-400',
  15: 'text-green-400',
  2:  'text-blue-400',
  0:  'text-gray-500',
};

const SHORT_LABELS: Record<string, string> = {
  'PT_Cal.GN2_Regulated': 'GN2 REG', 'PT_Cal.Fuel_Upstream': 'FUEL UP', 'PT_Cal.Fuel_Downstream': 'FUEL DN',
  'PT_Cal.Ox_Upstream': 'LOX UP', 'PT_Cal.Ox_Downstream': 'LOX DN', 'PT_Cal.GSE_Low': 'GSE LO',
  'PT_Cal.GSE_Mid': 'GSE MID', 'PT_Cal.GSE_High': 'GSE HI', 'PT_Cal.GN2_High': 'GN2 HI',
};

// Separate component for each pressure bar to properly use hooks
function ReactivePressureBar({ label, entity, nop, meop, color }: {
  label: string;
  entity: string;
  nop?: number;
  meop?: number;
  color: string;
}) {
  const value = useSensorValue(entity, 'pressure_psi');
  return (
    <div className="flex-1 min-w-0 h-full overflow-hidden" style={{ maxWidth: 90 }}>
      <PressureBar
        label={label}
        value={value}
        nop={nop} meop={meop} color={color}
        compact
      />
    </div>
  );
}

type PressureBarDef = { label: string; entity: string; nop?: number; meop?: number; color: string };

function inferSystemFromRole(role: string): 'GN2' | 'ETH' | 'LOX' | null {
  const r = role.toLowerCase();
  if (r.includes('gn2')) return 'GN2';
  if (r.includes('fuel') || r.includes('eth')) return 'ETH';
  if (r.includes('ox') || r.includes('lox')) return 'LOX';
  return null;
}

export default function TopBar() {
  // Subscribe to sensor updates to ensure bar plots re-render when values change
  // Subscribe to the entire sensorData object to catch all updates
  const sensorData = useSensorStore((s) => s.sensorData);
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const updateConnectionStatus = useSensorStore((s) => s.updateConnectionStatus);
  const updateState = useSensorStore((s) => s.updateState);
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateActuator = useSensorStore((s) => s.updateActuator);
  const updateActuatorExpectedPositions = useSensorStore((s) => s.updateActuatorExpectedPositions);
  const updateNotification = useSensorStore((s) => s.updateNotification);

  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false, elodinConnected: false,
  });
  const [clock, setClock] = useState('');
  const [countdown, setCountdown] = useState('');
  const [countdownExpired, setCountdownExpired] = useState(false);
  const [pressureBars, setPressureBars] = useState<PressureBarDef[]>([]);

  const ws = getWebSocketClient();

  const loadPressureBars = useCallback(() => {
    Promise.allSettled([
      fetch('/api/sensor-config').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/pressure-limits').then((r) => (r.ok ? r.json() : null)),
    ]).then(([sensorRes, limitsRes]) => {
      const sensors = sensorRes.status === 'fulfilled' ? (sensorRes.value?.sensors as any[] | undefined) : undefined;
      const limits = limitsRes.status === 'fulfilled' ? (limitsRes.value?.pressure_limits as Record<string, any> | undefined) : undefined;
      if (!Array.isArray(sensors) || sensors.length === 0) return;

      const sorted = [...sensors].sort((a, b) => {
        const ba = Number(a.boardId ?? 0);
        const bb = Number(b.boardId ?? 0);
        if (ba !== bb) return ba - bb;
        return Number(a.id ?? 0) - Number(b.id ?? 0);
      });

      const bars: PressureBarDef[] = sorted
        .map((s) => {
          const role = String(s.role || '');
          const entity = String(s.calEntity || s.entity || '');
          const sys = inferSystemFromRole(role);
          const nop = sys ? limits?.[sys]?.NOP : undefined;
          const meop = sys ? limits?.[sys]?.MEOP : undefined;
          const label = SHORT_LABELS[entity] ?? role ?? entity;
          return { label, entity, nop, meop, color: getEntityColor(entity) };
        })
        .filter((b) => b.entity.startsWith('PT_Cal.'))
        .slice(0, 10);

      setPressureBars(bars);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    loadPressureBars();
  }, [loadPressureBars]);

  useEffect(() => {
    ws.connect();
    try {
      startDataCache(); // begin 1 Hz background sampling for plot history
    } catch (err) {
      console.error('[TopBar] Failed to start data cache:', err);
    }
    const unsubConn = ws.onConnectionStatus((status) => {
      setConnectionStatus(status);
      updateConnectionStatus(status);
    });
    const unsubState = ws.on(MessageType.STATE_UPDATE, (p: unknown) => {
      updateState(p as StateUpdate);
    });
    // CRITICAL: Subscribe to sensor updates to ensure bar plots update
    const unsubSensor = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      updateSensor(p as SensorUpdate);
    });
    const unsubActuator = ws.on(MessageType.ACTUATOR_UPDATE, (p: unknown) => {
      updateActuator(p as ActuatorUpdate);
    });
    const unsubExpected = ws.on(MessageType.ACTUATOR_EXPECTED_POSITIONS_UPDATE, (p: unknown) => {
      updateActuatorExpectedPositions(p as Record<number, Record<string, 'open' | 'closed' | null>>);
    });
    const unsubNotification = ws.on(MessageType.NOTIFICATION, (p: unknown) => {
      updateNotification(p as NotificationPayload);
    });
    const unsubConfig = ws.on(MessageType.CONFIG_UPDATED, () => {
      loadPressureBars();
    });
    return () => {
      unsubConn();
      unsubState();
      unsubSensor();
      unsubActuator();
      unsubExpected();
      unsubNotification();
      unsubConfig();
    };
  }, [ws, updateConnectionStatus, updateState, updateSensor, updateActuator, updateActuatorExpectedPositions, updateNotification, loadPressureBars]);

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // Countdown to Friday March 6, 2026 12:00:00 PST (UTC-8 = 20:00 UTC)
  const LAUNCH_TARGET_MS = Date.UTC(2026, 2, 6, 20, 0, 0); // month is 0-indexed
  useEffect(() => {
    const tick = () => {
      const diff = LAUNCH_TARGET_MS - Date.now();
      if (diff <= 0) {
        setCountdown('000:00:00');
        setCountdownExpired(true);
      } else {
        const totalSecs = Math.floor(diff / 1000);
        const h = Math.floor(totalSecs / 3600);
        const m = Math.floor((totalSecs % 3600) / 60);
        const s = totalSecs % 60;
        setCountdown(`${String(h).padStart(3, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
        setCountdownExpired(false);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? `STATE ${effectiveState}`;
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isConnected = connectionStatus.connected;
  const isFullyConnected = connectionStatus.connected && connectionStatus.elodinConnected;

  const effectivePressureBars = useMemo(() => {
    if (pressureBars.length > 0) return pressureBars;
    // Fallback: keep UI stable even if /api/sensor-config is unavailable
    return [
      { label: 'GN2 REG', entity: 'PT_Cal.GN2_Regulated', color: getEntityColor('PT_Cal.GN2_Regulated') },
      { label: 'FUEL UP', entity: 'PT_Cal.Fuel_Upstream', color: getEntityColor('PT_Cal.Fuel_Upstream') },
      { label: 'LOX UP', entity: 'PT_Cal.Ox_Upstream', color: getEntityColor('PT_Cal.Ox_Upstream') },
    ] as PressureBarDef[];
  }, [pressureBars]);

  // Simple helper: send a single state-transition command
  const sendState = (state: SystemState) => {
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  // ENGINE ABORT: go to VENT for 5 seconds, then ENGINE_ABORT (same as old ABORT functionality)
  const handleEngineAbort = () => {
    sendState(SystemState.VENT);
    // After 5 seconds, transition to ENGINE_ABORT
    setTimeout(() => {
      sendState(SystemState.ENGINE_ABORT);
    }, 5000);
  };

  // GSE ABORT: go directly to GSE_ABORT state
  const handleGseAbort = () => {
    sendState(SystemState.GSE_ABORT);
  };

  // EMERGENCY ABORT: immediately go to EMERGENCY_ABORT state
  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    // Go directly to EMERGENCY_ABORT state
    sendState(SystemState.EMERGENCY_ABORT);
  };

  return (
    <div className="bg-card border-b border-gray-800 select-none flex-shrink-0" style={{ minHeight: 64 }}>
      <div className="flex items-stretch h-full px-3 gap-3 py-1.5">

        {/* Left: brand + connection + clock + countdown */}
        <div className="flex flex-col justify-center gap-0.5 flex-shrink-0 pr-4 border-r border-gray-800/60">
          <span className="text-2xl font-bold tracking-widest text-blue-400 uppercase leading-none">
            DIABLO DAQ
          </span>
          <div className="flex items-center gap-2">
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${isFullyConnected ? 'bg-green-500' : isConnected ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-300 font-semibold">
              {isFullyConnected ? 'Connected' : isConnected ? 'WS Only' : 'Disconnected'}
            </span>
          </div>
          <span className="text-xl font-mono text-gray-200 tabular-nums font-bold leading-tight">{clock}</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-widest font-semibold">T−</span>
            <span className={`text-xl font-mono tabular-nums font-bold leading-tight ${countdownExpired ? 'text-red-400' : 'text-white'}`}>
              {countdown}
            </span>
          </div>
        </div>

        {/* Middle: notifications */}
        <div className="flex flex-col justify-center pr-1 flex-shrink-0">
          <NotificationPanel />
        </div>

        {/* Center: pressure bars — fills remaining space */}
        <div className="flex-1 flex items-stretch justify-end gap-2 py-1 pr-2 min-w-0 overflow-hidden">
          {PRESSURE_BARS.map(({ label, entity, nop, meop, color }) => (
            <ReactivePressureBar
              key={entity}
              label={label}
              entity={entity}
              nop={nop}
              meop={meop}
              color={color}
            />
          ))}
        </div>

        {/* Right: state + mode + abort (compact) */}
        <div className="flex items-center gap-2 flex-shrink-0 pl-2 border-l border-gray-800/60">
          <div className="flex flex-col items-center gap-0.5 w-28">
            <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">STATE</span>
            <span className={`text-lg font-bold font-mono tracking-wider text-center leading-tight whitespace-normal ${stateColor}`}>
              {currentStateName}
            </span>
          </div>

          {/* Debug mode toggle */}
          <div className="flex flex-col items-center gap-0.5 border-l border-gray-800/60 pl-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">MODE</span>
            <button
              onClick={() => {
                const newDebugMode = !debugMode;
                setDebugMode(newDebugMode);
                const cmd: CommandPayload = {
                  commandType: 'debug_mode',
                  data: { debugMode: newDebugMode }
                };
                ws.sendCommand(cmd);
              }}
              className={`px-2.5 py-1.5 rounded text-[11px] font-bold uppercase tracking-wider border transition-all ${
                debugMode
                  ? 'bg-yellow-800/60 border-yellow-600 text-yellow-300 shadow-[0_0_6px_rgba(234,179,8,0.3)]'
                  : 'bg-gray-800 border-gray-700 text-gray-500 hover:border-gray-500'
              }`}
            >
              {debugMode ? '🔓 DEBUG' : '🔒 SAFE'}
            </button>
          </div>

          {/* Abort buttons */}
          <div className="flex flex-col gap-0.5 border-l border-gray-800/60 pl-2">
            <span className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">ABORT</span>
            <div className="flex flex-col gap-0.5">
              <button
                onClick={handleEngineAbort}
                className="px-2.5 py-1 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border border-amber-600
                           text-white font-semibold text-[11px] rounded tracking-wider transition-colors"
              >
                ENGINE ABORT
              </button>
              <button
                onClick={handleGseAbort}
                className="px-2.5 py-1 bg-orange-800 hover:bg-orange-700 active:bg-orange-900 border border-orange-600
                           text-white font-semibold text-[11px] rounded tracking-wider transition-colors"
              >
                GSE ABORT
              </button>
              <button
                onClick={handleEmergencyAbort}
                className="px-2.5 py-1 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                           text-white font-semibold text-[11px] rounded tracking-wider transition-colors
                           shadow-[0_0_6px_rgba(239,68,68,0.4)]"
              >
                E-ABORT
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
