'use client'

import { connectionBadge } from '@/lib/connection-badge';
import { useEffect, useMemo, useState } from 'react';
import { useSensorStore, useSensorValue, usePressureHistoryPlotSeries } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { SystemState, CommandPayload } from '@/lib/types';
import { useActuatorsFromConfig } from '@/lib/dashboard-hooks';
import { startDataCache } from '@/lib/data-cache';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useControlMode } from '@/lib/control-mode';
import { useSensorConfig } from '@/lib/sensor-config';
import { useGuiConfig } from '@/lib/gui-config';
import { usePressureLimits } from '@/lib/pressure-limits';
import { buildPressureBarDefsFromSensorConfig, buildPressurePlotSeriesFromSensorList } from '@/lib/pressure-bar-defs';
import { stateNameUpper } from '@/lib/states';
import { stateIdByName, bootStateId } from '@/lib/states';
import WindowPicker from '@/components/ui/WindowPicker';

// ── Constants shared with TopBar/UnifiedDashboard ────────────────────────────


const STATE_COLORS: Record<number, string> = {
  16: 'text-red-400', 17: 'text-red-500', 13: 'text-yellow-400',
  15: 'text-green-400', 2: 'text-ink', 0: 'text-ink-3',
};

const TIME_WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5m', seconds: 300 },
];

// ── Compact pressure readout pill (for mobile header strip) ──────────────────

function PressurePill({
  label,
  entity,
  color,
  avgEntities,
}: {
  label: string;
  entity: string;
  color: string;
  avgEntities?: string[];
}) {
  const primary = avgEntities?.[0] ?? entity;
  const v1 = useSensorValue(primary, 'pressure_psi');
  const v2 = useSensorValue(avgEntities?.[1] ?? primary, 'pressure_psi');
  const value =
    avgEntities && avgEntities.length >= 2 && v1 != null && v2 != null ? (v1 + v2) / 2 : v1;
  return (
    <div className="flex min-w-[64px] flex-shrink-0 flex-col items-center border border-line px-2 py-1">
      <span className="font-mono text-[9px] uppercase tracking-[0.08em]" style={{ color }}>{label}</span>
      <span className="font-mono text-sm tabular-nums text-ink">
        {value != null ? value.toFixed(0) : '---'}
      </span>
      <span className="font-mono text-[9px] text-ink-3">PSI</span>
    </div>
  );
}

// ── Main mobile dashboard ────────────────────────────────────────────────────

export default function MobileDashboard() {
  const currentState = useSensorStore((s) => s.currentState);
  const updateState = useSensorStore((s) => s.updateState);
  const debugMode = useSensorStore((s) => s.debugMode);
  const setDebugMode = useSensorStore((s) => s.setDebugMode);
  const connectionStatus = useSensorStore((s) => s.connectionStatus) ?? { connected: false, elodinConnected: false };
  const session = useSensorStore((s) => s.session);
  const connected = connectionStatus.connected;
  const elodinConnected = connectionStatus.elodinConnected;
  const isSimulated = !!connectionStatus.simulated;
  const dataFresh = !!connectionStatus.dataFresh; // backend-authoritative data-flowing signal
  // Session-enabled deployment with no active run: pipeline is intentionally down.
  const sessionStopped = !!(session?.enabled && !session.active);
  // Dot + label + tooltip, shared with TopBar so the two cannot drift.
  const badge = connectionBadge({
    connected,
    sessionStopped,
    dataFresh,
    simulated: isSimulated,
    throttled: connectionStatus.throttled,
    resolutionPct: connectionStatus.resolutionPct,
    lagMs: connectionStatus.lagMs,
  });

  const [clock, setClock] = useState('');
  const [timeWindow, setTimeWindow] = useState(60);
  const actuatorsFromConfig = useActuatorsFromConfig();

  const ws = getWebSocketClient();
  const { controlEnabled } = useControlMode();
  const sensors = useSensorConfig();

  useEffect(() => {
    try { startDataCache(); } catch { /* already started */ }
  }, [ws]);

  // ── Clock ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString('en-US', { hour12: true }));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Derived state ─────────────────────────────────────────────────────────
  const effectiveState = currentState ?? bootStateId() ?? -1;
  const currentStateName = stateNameUpper(effectiveState) ?? `STATE ${effectiveState}`;
  const stateColor = STATE_COLORS[effectiveState] ?? 'text-text';
  const isFullyConnected = connected && elodinConnected;

  const sendState = (state: SystemState) => {
    if (!controlEnabled) return;
    updateState({
      currentState: state,
      stateName: stateNameUpper(state) ?? `STATE ${state}`,
      timestamp: Date.now(),
    });
    const cmd: CommandPayload = { commandType: 'state_transition', data: { state } };
    ws.sendCommand(cmd);
  };

  // Same as TopBar: abort targets come from the config's [[states]] by name, not from the compiled
  // enum's 13/17/18/19, which a rig on another numbering simply does not have.
  const sendStateNamed = (name: string) => {
    const id = stateIdByName(name);
    if (id === null) {
      console.error(`[MobileDashboard] config declares no "${name}" state — command not sent`);
      return;
    }
    sendState(id);
  };

  // Disable a control the config cannot satisfy, so an abort never looks armed while resolving to
  // nothing — the same guard TopBar uses.
  const hasState = (name: string) => stateIdByName(name) !== null;

  const handleEngineAbort = () => {
    sendStateNamed('Vent');
    setTimeout(() => sendStateNamed('Engine Abort'), 5000);
  };
  const handleGseAbort = () => sendStateNamed('GSE Abort');
  const handleEmergencyAbort = () => {
    if (!confirm('⚠️ EMERGENCY ABORT — immediately vent GN2 and abort all operations?')) return;
    sendStateNamed('Emergency Abort');
  };

  const { pressureBars } = useGuiConfig();
  const limits = usePressureLimits();
  const pressureBarDefs = useMemo(() => buildPressureBarDefsFromSensorConfig(sensors, pressureBars, limits), [sensors, pressureBars, limits]);
  const pressureSensorsPlot = useMemo(() => buildPressurePlotSeriesFromSensorList(sensors, pressureBars, limits), [sensors, pressureBars, limits]);
  const pressurePlotForChart = usePressureHistoryPlotSeries(pressureSensorsPlot);

  return (
    <div className="flex flex-col h-full overflow-y-auto overflow-x-hidden bg-background text-text">

      {/* ── Sticky compact header ──────────────────────────────────────────── */}
      <div className="sticky top-0 z-20 flex-shrink-0 border-b border-line bg-black px-4 pb-3 pt-3">

        {/* Row 1: branding + connection + state + clock */}
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-[13px] font-bold uppercase tracking-[0.2em] text-ink">STAR DAQ</span>
            <div className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${badge.dotClass}`} title={badge.title} />
            <span className="truncate font-mono text-[11px] uppercase tracking-[0.08em] text-ink-2" title={badge.title}>{badge.label}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] tabular-nums text-ink-3">{clock}</span>
            <span className={`font-mono text-[13px] font-bold uppercase tracking-[0.12em] ${stateColor}`}>{currentStateName}</span>
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
            className={`ctl h-9 flex-shrink-0 px-3 text-[10px] ${debugMode ? '!border-yellow-500 !text-yellow-400' : ''}`}
            title={controlEnabled ? undefined : 'Viewer mode: controls locked'}
          >
            {debugMode ? 'Debug' : 'Safe'}
          </button>
          <button
            onClick={handleEngineAbort}
            disabled={!controlEnabled || !hasState('Vent') || !hasState('Engine Abort')}
            className="ctl h-9 flex-1 border-[var(--color-danger)] text-[10px] tracking-[0.06em] text-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:!text-white"
            title={
              !controlEnabled
                ? 'Viewer mode: controls locked'
                : !hasState('Vent') || !hasState('Engine Abort')
                  ? 'Config declares no Vent / Engine Abort state'
                  : undefined
            }
          >
            ENGINE ABORT
          </button>
          <button
            onClick={handleGseAbort}
            disabled={!controlEnabled || !hasState('GSE Abort')}
            className="ctl h-9 flex-1 border-orange-500/70 text-[10px] tracking-[0.06em] text-orange-400 hover:!bg-orange-700 hover:!text-white"
            title={
              !controlEnabled
                ? 'Viewer mode: controls locked'
                : !hasState('GSE Abort')
                  ? 'Config declares no GSE Abort state'
                  : undefined
            }
          >
            GSE ABORT
          </button>
          <button
            onClick={handleEmergencyAbort}
            disabled={!controlEnabled || !hasState('Emergency Abort')}
            className="ctl h-9 flex-1 border-[var(--color-danger)] text-[10px] tracking-[0.06em] text-[var(--color-danger)] hover:!bg-[var(--color-danger-solid)] hover:!text-white"
            title={
              !controlEnabled
                ? 'Viewer mode: controls locked'
                : !hasState('Emergency Abort')
                  ? 'Config declares no Emergency Abort state'
                  : undefined
            }
          >
            E-ABORT
          </button>
        </div>
      </div>

      {/* ── Pressure readout strip ─────────────────────────────────────────── */}
      <div className="flex flex-shrink-0 gap-2 overflow-x-auto border-b border-line px-4 py-3">
        {pressureBarDefs.map((d) => (
          <PressurePill
            key={`${d.label}:${d.entity}:${d.avgEntities?.join() ?? ''}`}
            label={d.label}
            entity={d.entity}
            color={d.color}
            avgEntities={d.avgEntities}
          />
        ))}
      </div>

      {/* ── Pressure history plot ──────────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-line px-4 py-4" style={{ height: 300 }}>
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between mb-2 flex-shrink-0">
            <h2 className="caps text-[11px]">Pressure History</h2>
            <WindowPicker windows={TIME_WINDOWS} value={timeWindow} onChange={setTimeWindow} />
          </div>
          <div className="flex-1 min-h-0">
            <TimeSeriesPlot
              title="All Pressure Sensors (PSI)"
              entities={pressurePlotForChart.map((s) => s.entity)}
              labels={pressurePlotForChart.map((s) => s.label)}
              component="pressure_psi"
              colors={pressurePlotForChart.map((s) => s.color)}
              yLabel="PSI"
              windowSeconds={timeWindow}
            />
          </div>
        </div>
      </div>

      {/* ── Actuator controls ──────────────────────────────────────────────── */}
      <div className="border-b border-line px-4 py-4">
        <div>
          <h2 className="caps mb-3 text-[11px]">Actuators</h2>
          <div className="grid grid-cols-2 gap-2">
            {actuatorsFromConfig.map((a) => (
              <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} boardId={a.boardId} ballValve={a.ballValve} />
            ))}
          </div>
        </div>
      </div>

      {/* ── State machine ──────────────────────────────────────────────────── */}
      <div className="px-4 pb-6 pt-4">
        <div>
          <StateMachineDiagram />
        </div>
      </div>
    </div>
  );
}
