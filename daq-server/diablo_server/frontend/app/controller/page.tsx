'use client'

import { useCallback, useEffect, useState } from 'react';
import { useSensorStore, useSensorValue, useActuatorCommandedState } from '@/lib/store';
import { ActuatorState } from '@/lib/types';
import { getWebSocketClient, getApiBaseUrl } from '@/lib/websocket';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';
import { MessageType, SystemState } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { getEntityColor } from '@/lib/sensor-colors';

const LBF_TO_N = 4.44822;

function buildLcChannels(boards: Record<string, unknown>): number[] {
  const channels: number[] = [];
  for (const board of Object.values(boards)) {
    const b = board as { type?: string; enabled?: boolean; active_connectors?: number[]; num_sensors?: number };
    if (b.type !== 'LC' || b.enabled === false) continue;
    const active: number[] =
      Array.isArray(b.active_connectors) && b.active_connectors.length > 0
        ? b.active_connectors
        : Array.from({ length: (b.num_sensors ?? 4) }, (_, i) => i + 1);
    channels.push(...active);
  }
  return Array.from(new Set(channels)).sort((a, b) => a - b);
}

/** Display follows commanded state only (state machine / user command); no ADC. */
function ValveStatusRow({ label, entity }: { label: string; entity: string }) {
  const commanded = useActuatorCommandedState(entity);
  const isOpen = commanded === ActuatorState.OPEN;
  const hasState = commanded === ActuatorState.OPEN || commanded === ActuatorState.CLOSED;

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-800/60 last:border-0">
      <span className="text-sm text-text-muted">{label}</span>
      <span className={`text-xs font-bold font-mono w-16 text-right ${!hasState ? 'text-gray-600' : isOpen ? 'text-green-400' : 'text-red-400'}`}>
        {!hasState ? '---' : isOpen ? '● OPEN' : '○ CLOSED'}
      </span>
    </div>
  );
}

function DutyCycleCard({ label, entity, color }: { label: string; entity: string; color: string }) {
  const raw = useSensorValue(entity, 'duty_cycle') ?? 0;
  const on = useSensorValue(entity, 'onoff');
  // Backend sends 0–1; display as 0–100%
  const dc = raw <= 1 && raw >= 0 ? raw * 100 : raw;

  return (
    <div className="bg-card rounded-xl border border-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold tracking-wider text-text-muted uppercase">{label}</h3>
        <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded ${on ? 'bg-green-900/50 text-green-400 border border-green-800' :
            'bg-gray-900/50 text-gray-500 border border-gray-800'
          }`}>
          {on ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold font-mono tabular-nums" style={{ color }}>
          {dc.toFixed(1)}
        </span>
        <span className="text-sm text-text-muted">%</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-3 overflow-hidden">
        <div
          className="h-3 rounded-full transition-all duration-100"
          style={{ width: `${Math.min(100, Math.max(0, dc))}%`, background: color }}
        />
      </div>
    </div>
  );
}

const STATE_NAMES: Record<number, string> = {
  0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
  5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
  9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
  13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
};

export default function ControllerPage() {
  const currentState = useSensorStore((state) => state.currentState);
  const ws = getWebSocketClient();
  const { actuators } = useActuatorsFromConfig();
  const VALVES = actuators.map((a) => ({ label: a.name, entity: a.entity, ch: a.entity, channel: a.channel }));

  const [lcChannels, setLcChannels] = useState<number[]>([1]);
  const loadLcConfig = useCallback(async () => {
    try {
      const base = getApiBaseUrl();
      const res = await fetch(`${base}/api/config`);
      const cfg = await res.json();
      const boards = (cfg?.boards ?? {}) as Record<string, unknown>;
      const chs = buildLcChannels(boards);
      if (chs.length > 0) setLcChannels(chs);
    } catch {
      setLcChannels([1]);
    }
  }, []);

  useEffect(() => {
    loadLcConfig();
  }, [loadLcConfig]);

  useEffect(() => {
    const unsub = ws.on(MessageType.CONFIG_UPDATED, loadLcConfig);

    ws.send({
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: 'CONTROLLER.Fuel' },
    });
    ws.send({
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: 'CONTROLLER.Ox' },
    });
    ws.send({
      type: MessageType.SUBSCRIBE_SENSOR,
      timestamp: Date.now(),
      payload: { entity: 'CONTROLLER.diagnostics' },
    });
    lcChannels.forEach((ch) => {
      ws.send({
        type: MessageType.SUBSCRIBE_SENSOR,
        timestamp: Date.now(),
        payload: { entity: `LC_Cal.CH${ch}` },
      });
    });

    return () => { unsub(); };
  }, [ws, loadLcConfig, lcChannels]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-3">

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-purple-500 rounded-full" />
          <h1 className="text-lg font-bold">Controller Status</h1>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs bg-gray-900 rounded px-3 py-1.5 border border-gray-800">
            <span className="text-text-muted">STATE:</span>
            <span className={`font-mono font-bold ${currentState === SystemState.FIRE ? 'text-red-400' :
                currentState === SystemState.READY ? 'text-green-400' :
                  currentState === SystemState.ABORT ? 'text-red-500' :
                    'text-text'
              }`}>
              {currentState !== null ? STATE_NAMES[currentState] : '---'}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted bg-gray-900 rounded px-3 py-1.5 border border-gray-800">
            <span>PWM Frequency:</span>
            <span className="font-mono font-bold text-text">10 Hz</span>
            <span className="text-gray-600">·</span>
            <span>set in config.toml</span>
          </div>
        </div>
      </div>

      {/* ── Body: duty cycles + valve states + plot ───────────────────── */}
      <div className="flex-1 grid grid-cols-3 gap-3 min-h-0">

        {/* Left column: duty cycle cards */}
        <div className="flex flex-col gap-3">
          <DutyCycleCard label="Fuel Solenoid" entity="CONTROLLER.Fuel" color={getEntityColor('CONTROLLER.Fuel')} />
          <DutyCycleCard label="Oxidizer Solenoid" entity="CONTROLLER.Ox" color={getEntityColor('CONTROLLER.Ox')} />

          {/* Data-flow info card */}
          <div className="bg-card rounded-xl border border-gray-800 p-4 flex-1">
            <h3 className="text-xs font-bold tracking-widest text-text-muted uppercase mb-3">
              Controller Loop
            </h3>
            <div className="space-y-2 text-xs text-text-muted">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0" />
                <span>DAQ Board → PT calibrated PSI</span>
              </div>
              <div className="w-px h-3 bg-gray-700 ml-1" />
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-500 flex-shrink-0" />
                <span>FSW / control package</span>
              </div>
              <div className="w-px h-3 bg-gray-700 ml-1" />
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0" />
                <span>PWM duty cycle → solenoid</span>
              </div>
              <div className="mt-3 pt-3 border-t border-gray-800 text-gray-600 leading-relaxed">
                The FSW controller reads Elodin DB → computes duty cycle → sends UDP PWM command to actuator board.
                Frequency is fixed at 10 Hz; only duty cycle varies.
              </div>
            </div>
          </div>
        </div>

        {/* Middle column: valve states */}
        <div className="bg-card rounded-xl border border-gray-800 p-4 overflow-y-auto">
          <h3 className="text-xs font-bold tracking-widest text-text-muted uppercase mb-3">
            Valve States
          </h3>
          {VALVES.map((v) => (
            <ValveStatusRow key={v.label} {...v} />
          ))}
        </div>

        {/* Right column: duty cycle + thrust overlay (stacked) */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0 overflow-hidden flex-1">
          <div className="bg-card rounded-xl border border-gray-800 p-3 flex flex-col min-h-[120px] flex-1 min-w-0 overflow-hidden shrink-0">
            <TimeSeriesPlot
              title="PWM Duty Cycles (%)"
              entities={['CONTROLLER.Fuel', 'CONTROLLER.Ox']}
              labels={['Fuel Sol.', 'Ox Sol.']}
              component="duty_cycle"
              colors={[getEntityColor('CONTROLLER.Fuel'), getEntityColor('CONTROLLER.Ox')]}
              yLabel="Duty Cycle (%)"
              valueTransforms={[(v) => (v <= 1 && v >= 0 ? v * 100 : v), (v) => (v <= 1 && v >= 0 ? v * 100 : v)]}
              windowSeconds={60}
            />
          </div>
          <div className="bg-card rounded-xl border border-gray-800 p-3 flex flex-col min-h-[120px] flex-1 min-w-0 overflow-hidden shrink-0">
            <TimeSeriesPlot
              key={`thrust-${lcChannels.join(',')}`}
              title="Thrust (N)"
              component="F_ref"
              entities={[
                'CONTROLLER.diagnostics',
                'CONTROLLER.diagnostics',
                ...lcChannels.map((ch) => `LC_Cal.CH${ch}`),
              ]}
              components={[
                'F_ref',
                'F_estimated',
                ...lcChannels.map(() => 'force_lbf'),
              ]}
              labels={[
                'Desired',
                'Estimated',
                ...lcChannels.map((ch) => `Actual (LC${ch})`),
              ]}
              valueTransforms={[
                undefined,
                undefined,
                ...lcChannels.map(() => (v: number) => (isFinite(v) ? v * LBF_TO_N : v)),
              ]}
              colors={[
                '#60A5FA',
                '#34D399',
                ...lcChannels.map((_, i) => ['#F59E0B', '#EC4899', '#8B5CF6'][i % 3] ?? '#F59E0B'),
              ]}
              yLabel="Thrust (N)"
              windowSeconds={60}
            />
          </div>
        </div>

      </div>
    </main>
  );
}
