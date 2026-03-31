'use client'

import { useEffect, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getApiBaseUrl, getWebSocketClient } from '@/lib/websocket';
import { SystemState, ActuatorId, CommandPayload } from '@/lib/types';
import { startDataCache } from '@/lib/data-cache';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { PRESSURE_SENSORS, PRESSURE_BAR_SENSORS } from '@/lib/sensor-colors';
import { useControlMode } from '@/lib/control-mode';
import { useSensorConfig } from '@/lib/sensor-config';

// ── Constants shared with TopBar/UnifiedDashboard ────────────────────────────

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 LOW PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'GN2 HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  20: 'PRESS STANDBY',
};

const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400', 17: 'text-red-500', 13: 'text-yellow-400',
  15: 'text-green-400', 2: 'text-blue-400', 0: 'text-gray-500',
};

const NAME_TO_ACTUATOR_ID: Partial<Record<string, ActuatorId>> = {
  'LOX Main': ActuatorId.LOX_MAIN, 'Fuel Main': ActuatorId.FUEL_MAIN,
  'LOX Vent': ActuatorId.LOX_VENT, 'Fuel Vent': ActuatorId.FUEL_VENT,
  'GN2 Vent': ActuatorId.GSE_LOW_VENT, 'GSE Low Vent': ActuatorId.GSE_LOW_VENT,
  'GSE High Press Vent': ActuatorId.GSE_HIGH_PRESS_VENT, 'GSE LOX Fill Vent': ActuatorId.GSE_LOX_FILL_VENT,
  'LOX Press': ActuatorId.LOX_PRESS, 'Fuel Press': ActuatorId.FUEL_PRESS,
  'Fuel Fill Press': ActuatorId.FUEL_FILL_PRESS, 'GSE High Press Control': ActuatorId.GSE_HIGH_PRESS_CONTROL,
  'GSE Med Press Control': ActuatorId.GSE_MED_PRESS_CONTROL,
  'Fuel Fill Vent': ActuatorId.FUEL_FILL_VENT, 'LOX Fill': ActuatorId.LOX_FILL,
  'LOX Dump': ActuatorId.LOX_DUMP,
};

const TIME_WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5m', seconds: 300 },
];

const SHORT_LABELS: Record<string, string> = {
  'PT_Cal.GN2_Regulated': 'GN2 REG', 'PT_Cal.Fuel_Upstream': 'FUEL UP', 'PT_Cal.Fuel_Downstream': 'FUEL DN',
  'PT_Cal.Ox_Upstream': 'LOX UP', 'PT_Cal.Ox_Downstream': 'LOX DN', 'PT_Cal.GSE_Low': 'GSE LO',
  'PT_Cal.GSE_Mid': 'GSE MID', 'PT_Cal.GSE_High': 'GSE HI', 'PT_Cal.GN2_High': 'GN2 HI',
};

// ── Compact pressure readout pill (for mobile header strip) ──────────────────

function PressurePill({ label, entity, color }: { label: string; entity: string; color: string }) {
  const value = useSensorValue(entity, 'pressure_psi');
  return (
    <div className="flex-shrink-0 flex flex-col items-center bg-background rounded px-2 py-1 border border-gray-800 min-w-[64px]">
      <span className="text-[9px] font-bold tracking-wider uppercase" style={{ color }}>{label}</span>
      <span className="text-sm font-mono font-bold text-text tabular-nums">
        {value != null ? value.toFixed(0) : '---'}
      </span>
      <span className="text-[9px] text-text-muted">PSI</span>
    </div>
  );
}

// ── Main mobile dashboard ────────────────────────────────────────────────────

export default function MobileDashboard() {
  const currentState = useSensorStore((s) => s.currentState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const connectionStatus = useSensorStore((s) => s.connectionStatus) ?? { connected: false, elodinConnected: false };
  const connected = connectionStatus.connected;
  const elodinConnected = connectionStatus.elodinConnected;

  const [clock, setClock] = useState('');
  const [timeWindow, setTimeWindow] = useState(60);
  const [actuatorsFromConfig, setActuatorsFromConfig] = useState<
    { name: string; channel: number; entity: string; boardId?: number; id?: ActuatorId }[]
  >([]);

  const ws = getWebSocketClient();
  const { controlEnabled } = useControlMode();
  const sensors = useSensorConfig();

  useEffect(() => {
    ws.connect();
    try { startDataCache(); } catch { /* already started */ }
  }, [ws]);

  // ── Clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Config fetch ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetch(`${getApiBaseUrl()}/api/config`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { config?: { actuator_roles?: Record<string, [string, number] | [string, number, string]> } } | null) => {
        const roles = data?.config?.actuator_roles;
        if (!roles || typeof roles !== 'object') return;
        setActuatorsFromConfig(
          Object.entries(roles).map(([name, value]) => {
            const channel = Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number' ? value[1] : 1;
            const boardId = Array.isArray(value) && value.length >= 3 && typeof value[2] === 'number' ? value[2] : undefined;
            const entity = `ACT.${name.replace(/\s+/g, '_')}`;
            return { name, channel, entity, boardId, id: NAME_TO_ACTUATOR_ID[name] };
          })
        );
      })
      .catch(() => {});
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const effectiveState = currentState ?? SystemState.IDLE;
  const currentStateName = STATE_NAMES[effectiveState] ?? `STATE ${effectiveState}`;
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isFullyConnected = connected && elodinConnected;

  const sendState = (state: SystemState) => {
    if (!controlEnabled) return;
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  const handleEngineAbort = () => {
    sendState(SystemState.VENT);
    setTimeout(() => sendState(SystemState.ENGINE_ABORT), 5000);
  };
  const handleGseAbort = () => sendState(SystemState.GSE_ABORT);
  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    sendState(SystemState.EMERGENCY_ABORT);
  };

  const roleToEntity = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sensors) m.set(String(s.role || ''), String(s.calEntity || ''));
    return m;
  }, [sensors]);

  const pickEntity = useCallback((roles: string[], fallback: string) => {
    for (const r of roles) {
      const e = roleToEntity.get(r);
      if (e) return e;
    }
    return fallback;
  }, [roleToEntity]);

  const pressurePills = useMemo(() => [
    { label: 'GN2 HI', entity: pickEntity(['GN2 High'], 'PT_Cal.GN2_High') },
    { label: 'GN2 REG', entity: pickEntity(['GN2 Regulated'], 'PT_Cal.GN2_Regulated') },
    { label: 'FUEL UP', entity: pickEntity(['Fuel Upstream'], 'PT_Cal.Fuel_Upstream') },
    { label: 'FUEL DN', entity: pickEntity(['Fuel Downstream'], 'PT_Cal.Fuel_Downstream') },
    { label: 'LOX UP', entity: pickEntity(['Ox Upstream', 'LOX Upstream'], 'PT_Cal.Ox_Upstream') },
    { label: 'LOX DN', entity: pickEntity(['Ox Downstream', 'LOX Downstream'], 'PT_Cal.Ox_Downstream') },
    { label: 'GSE LO', entity: pickEntity(['GSE Low'], 'PT_Cal.GSE_Low') },
    { label: 'GSE MID', entity: pickEntity(['GSE Mid'], 'PT_Cal.GSE_Mid') },
    { label: 'GSE HI', entity: pickEntity(['GSE High'], 'PT_Cal.GSE_High') },
  ].map((s) => ({ ...s, color: PRESSURE_SENSORS.find((p) => p.entity === s.entity)?.color ?? '#38BDF8' })), [pickEntity]);

  const pressureSensorsPlot = useMemo(() => pressurePills.map((p) => ({
    label: p.label,
    entity: p.entity,
    color: p.color,
  })), [pressurePills]);

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden bg-background text-text">

      {/* ── Sticky compact header ──────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 bg-card border-b border-gray-800 px-3 pt-2 pb-2 flex-shrink-0">

        {/* Row 1: branding + connection + state + clock */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold tracking-widest text-blue-400 uppercase">DIABLO DAQ</span>
            <div className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${
              isFullyConnected ? 'bg-green-500' : connected ? 'bg-yellow-500' : 'bg-red-500'
            }`} />
            <span className="text-xs text-gray-400">{isFullyConnected ? 'Connected' : connected ? 'WS Only' : 'Disconnected'}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-gray-400 tabular-nums">{clock}</span>
            <span className={`text-sm font-bold font-mono tracking-wide ${stateColor}`}>{currentStateName}</span>
          </div>
        </div>

        {/* Row 2: MODE toggle + Abort buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (!controlEnabled) return;
              const next = !debugMode;
              setDebugMode(next);
              ws.sendCommand({ commandType: 'debug_mode', data: { debugMode: next } });
            }}
            disabled={!controlEnabled}
            className={`px-3 py-2 rounded text-xs font-bold uppercase tracking-wider border transition-all flex-shrink-0 ${
              !controlEnabled
                ? 'bg-gray-900 border-gray-800 text-gray-600 cursor-not-allowed'
                : debugMode
                  ? 'bg-yellow-800/60 border-yellow-600 text-yellow-300'
                  : 'bg-gray-800 border-gray-700 text-gray-500'
            }`}
            title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
          >
            {debugMode ? '🔓 DEBUG' : '🔒 SAFE'}
          </button>
          <button
            onClick={handleEngineAbort}
            disabled={!controlEnabled}
            className="flex-1 py-2 bg-amber-800 hover:bg-amber-700 active:bg-amber-900 border border-amber-600
                       text-white font-bold text-xs rounded tracking-wider transition-colors disabled:bg-amber-900 disabled:border-amber-900 disabled:text-amber-700 disabled:cursor-not-allowed"
            title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
          >
            ENGINE ABORT
          </button>
          <button
            onClick={handleGseAbort}
            disabled={!controlEnabled}
            className="flex-1 py-2 bg-orange-800 hover:bg-orange-700 active:bg-orange-900 border border-orange-600
                       text-white font-bold text-xs rounded tracking-wider transition-colors disabled:bg-orange-900 disabled:border-orange-900 disabled:text-orange-700 disabled:cursor-not-allowed"
            title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
          >
            GSE ABORT
          </button>
          <button
            onClick={handleEmergencyAbort}
            disabled={!controlEnabled}
            className="flex-1 py-2 bg-red-700 hover:bg-red-600 active:bg-red-800 border border-red-500
                       text-white font-bold text-xs rounded tracking-wider transition-colors
                       shadow-[0_0_6px_rgba(239,68,68,0.3)] disabled:bg-red-900 disabled:border-red-900 disabled:text-red-700 disabled:cursor-not-allowed"
            title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
          >
            E-ABORT
          </button>
        </div>
      </div>

      {/* ── Pressure readout strip ─────────────────────────────────────────── */}
      <div className="flex gap-2 px-3 py-2 overflow-x-auto flex-shrink-0 border-b border-gray-800/60">
        {pressurePills.map(({ label, entity, color }) => (
          <PressurePill key={entity} label={label} entity={entity} color={color} />
        ))}
      </div>

      {/* ── Pressure history plot ──────────────────────────────────────────── */}
      <div className="px-3 pt-3 pb-2 flex-shrink-0" style={{ height: 300 }}>
        <div className="bg-card rounded-xl border border-gray-800 p-3 h-full flex flex-col">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h2 className="text-xs font-bold tracking-widest text-text-muted uppercase">Pressure History</h2>
            <div className="flex gap-1">
              {TIME_WINDOWS.map((w) => (
                <button
                  key={w.label}
                  onClick={() => setTimeWindow(w.seconds)}
                  className={`px-2 py-1 text-xs font-semibold rounded transition-all ${
                    timeWindow === w.seconds
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {w.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex-1 min-h-0">
            <TimeSeriesPlot
              title="All Pressure Sensors (PSI)"
              entities={pressureSensorsPlot.map((s) => s.entity)}
              labels={pressureSensorsPlot.map((s) => s.label)}
              component="pressure_psi"
              colors={pressureSensorsPlot.map((s) => s.color)}
              yLabel="PSI"
              windowSeconds={timeWindow}
            />
          </div>
        </div>
      </div>

      {/* ── Actuator controls ──────────────────────────────────────────────── */}
      <div className="px-3 pb-3">
        <div className="bg-card rounded-xl border border-gray-800 p-3">
          <h2 className="text-xs font-bold tracking-widest text-text-muted uppercase mb-3">Actuator Controls</h2>
          <div className="grid grid-cols-2 gap-2">
            {actuatorsFromConfig.map((a) =>
              a.id !== undefined ? (
                <ActuatorControl key={a.name} actuatorId={a.id} />
              ) : (
                <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} boardId={a.boardId} />
              )
            )}
          </div>
        </div>
      </div>

      {/* ── State machine ──────────────────────────────────────────────────── */}
      <div className="px-3 pb-6">
        <div className="bg-card rounded-xl border border-gray-800 p-3">
          <h2 className="text-xs font-bold tracking-widest text-text-muted uppercase mb-3">State Machine</h2>
          <StateMachineDiagram />
        </div>
      </div>
    </div>
  );
}
