'use client'

import { useCallback, useEffect, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SystemState, ActuatorId } from '@/lib/types';
import { startDataCache } from '@/lib/data-cache';
import StateMachineDiagram from '@/components/controls/StateMachineDiagram';
import ActuatorControl from '@/components/controls/ActuatorControl';
import ActuatorControlByName from '@/components/controls/ActuatorControlByName';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { PRESSURE_SENSORS, getEntityColor } from '@/lib/sensor-colors';

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

const FALLBACK_PRESSURE_SENSORS_PLOT = PRESSURE_SENSORS.map((s) => ({
  label: s.label.replace('Upstream', 'Up').replace('Downstream', 'Down').replace('Regulated', 'Reg'),
  entity: s.entity,
  color: s.color,
}));

// Time window options for history plotting
const TIME_WINDOWS = [
  { label: '10s', seconds: 10 },
  { label: '30s', seconds: 30 },
  { label: '60s', seconds: 60 },
  { label: '5min', seconds: 300 },
];

export default function UnifiedDashboard() {
  const currentState = useSensorStore((state) => state.currentState);
  const ws = getWebSocketClient();
  const [timeWindow, setTimeWindow] = useState(60);
  const [actuatorsFromConfig, setActuatorsFromConfig] = useState<{ name: string; channel: number; entity: string; id?: ActuatorId }[]>([]);
  const [pressureSensorsPlot, setPressureSensorsPlot] = useState<{ label: string; entity: string; color: string }[]>([]);

  const loadActuatorsFromConfig = useCallback(() => {
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { config?: { actuator_roles?: Record<string, any>; adc?: { internal_v?: number; absolute_5v_v?: number } } } | null) => {
        const config = data?.config;
        const adc = config?.adc;
        if (adc && typeof adc.internal_v === 'number' && typeof adc.absolute_5v_v === 'number') {
          useSensorStore.getState().setVoltageRefNominals({ internalV: adc.internal_v, absolute5vV: adc.absolute_5v_v });
        }
        const roles = config?.actuator_roles;
        if (!roles || typeof roles !== 'object') return;
        setActuatorsFromConfig(
          Object.entries(roles).map(([name, value]) => {
            const channel = Array.isArray(value) && value.length >= 2 && typeof value[1] === 'number' ? value[1] : 1;
            const entity = `ACT.${name.replace(/\s+/g, '_')}`;
            return { name, channel, entity, id: NAME_TO_ACTUATOR_ID[name] };
          })
        );
      })
      .catch(() => { });
  }, []);

  const loadPressureSensors = useCallback(() => {
    fetch('/api/sensor-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: any) => {
        const sensors = data?.sensors as any[] | undefined;
        if (!Array.isArray(sensors)) return;
        const pts = sensors
          .filter((s) => typeof s?.calEntity === 'string' && (s.calEntity as string).startsWith('PT_Cal.'))
          .map((s) => {
            const role = String(s.role || s.calEntity);
            const label = role.replace('Upstream', 'Up').replace('Downstream', 'Down').replace('Regulated', 'Reg');
            const entity = String(s.calEntity);
            return { label, entity, color: getEntityColor(entity) };
          });
        if (pts.length > 0) setPressureSensorsPlot(pts);
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    loadActuatorsFromConfig();
    loadPressureSensors();
  }, [loadActuatorsFromConfig, loadPressureSensors]);

  useEffect(() => {
    ws.connect();

    const u6 = ws.on(MessageType.CONFIG_UPDATED, () => {
      loadActuatorsFromConfig();
      loadPressureSensors();
    });

    return () => {
      u6();
    };
  }, [ws, loadActuatorsFromConfig, loadPressureSensors]);

  const isFireState = currentState === SystemState.FIRE;
  const effectivePressureSensorsPlot = pressureSensorsPlot.length > 0 ? pressureSensorsPlot : FALLBACK_PRESSURE_SENSORS_PLOT;

  return (
    <main className="h-full w-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Main content: 3-section split view ─────────────────────────────── */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 overflow-hidden">

        {/* ── Left column: Pressure graphs ─────────────────────────────────── */}
        <div className="flex-1 min-w-0 overflow-auto">
          <div className="bg-card rounded-xl border border-gray-800 p-4 h-full flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-3 flex-shrink-0">
              <h2 className="text-base font-bold tracking-widest text-text-muted uppercase">Pressure History</h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-text-muted font-medium">Window:</span>
                {TIME_WINDOWS.map((w) => (
                  <button
                    key={w.label}
                    onClick={() => {
                      const newWindow = w.seconds;
                      setTimeWindow(newWindow);
                      console.log(`[UnifiedDashboard] Time window changed to ${newWindow}s`);
                    }}
                    className={`px-2 py-0.5 text-xs font-semibold rounded transition-all ${timeWindow === w.seconds
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                        : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
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
                entities={effectivePressureSensorsPlot.map(s => s.entity)}
                labels={effectivePressureSensorsPlot.map(s => s.label)}
                component="pressure_psi"
                colors={effectivePressureSensorsPlot.map(s => s.color)}
                yLabel="Pressure (PSI)"
                windowSeconds={timeWindow}
              />
            </div>
          </div>
        </div>

        {/* ── Right column: Actuators grid (top) + State machine (bottom) ───── */}
        <div className="flex-1 min-w-0 flex flex-col gap-3 overflow-hidden">

          {/* Actuators: 4x4 grid, dynamically sized to fit allotment */}
          <div className="bg-card rounded-xl border border-gray-800 p-2 flex flex-col min-h-0 flex-1 max-h-[38vh]">
            <h2 className="text-[10px] font-bold tracking-widest text-text-muted uppercase mb-1 leading-none flex-shrink-0">
              Actuator Controls
            </h2>
            <div className="flex-1 min-h-0 grid grid-cols-4 grid-rows-4 gap-1 overflow-hidden">
              {Array.from({ length: 16 }, (_, i) => {
                const a = actuatorsFromConfig[i];
                if (!a) return <div key={`empty-${i}`} className="bg-gray-900/30 rounded border border-gray-800/50 min-h-0" />;
                return a.id !== undefined ? (
                  <ActuatorControl key={a.name} actuatorId={a.id} />
                ) : (
                  <ActuatorControlByName key={a.name} name={a.name} channel={a.channel} entity={a.entity} />
                );
              })}
            </div>
          </div>

          {/* State machine diagram */}
          <div className="mt-auto min-h-0 overflow-auto bg-card rounded-xl border border-gray-800 p-4 max-h-[50vh]">
            <StateMachineDiagram />
          </div>
        </div>
      </div>

      {/* ── Bottom Section: Controller Status (when in FIRE state) ─────── */}
      {isFireState && (
        <div className="flex-shrink-0 border-t border-gray-800 p-3 bg-card">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              <span className="text-xs font-bold tracking-wider text-text-muted uppercase">Controller Active (FIRE)</span>
            </div>
            <ControllerStatusDisplay />
          </div>
        </div>
      )}
    </main>
  );
}

// Controller status display component
function ControllerStatusDisplay() {
  const fuelDuty = useSensorValue('CONTROLLER.Fuel', 'duty_cycle') ?? 0;
  const oxDuty = useSensorValue('CONTROLLER.Ox', 'duty_cycle') ?? 0;
  const fuelOn = useSensorValue('CONTROLLER.Fuel', 'onoff') ?? 0;
  const oxOn = useSensorValue('CONTROLLER.Ox', 'onoff') ?? 0;

  return (
    <div className="flex items-center gap-6">
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Fuel:</span>
        <span className="text-sm font-mono font-bold text-blue-400">{fuelDuty.toFixed(1)}%</span>
        <span className={`text-xs px-2 py-0.5 rounded ${fuelOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
            'bg-gray-900/50 text-gray-500 border border-gray-800'
          }`}>
          {fuelOn ? 'ON' : 'OFF'}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-text-muted">Ox:</span>
        <span className="text-sm font-mono font-bold text-red-400">{oxDuty.toFixed(1)}%</span>
        <span className={`text-xs px-2 py-0.5 rounded ${oxOn ? 'bg-green-900/50 text-green-400 border border-green-800' :
            'bg-gray-900/50 text-gray-500 border border-gray-800'
          }`}>
          {oxOn ? 'ON' : 'OFF'}
        </span>
      </div>
    </div>
  );
}
