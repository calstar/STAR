'use client'

import { useEffect } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, SystemState } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';

// Valve rows: [label, entity, component]
const VALVES = [
  { label: 'LOX Main',     entity: 'ACT.LOX_Main',     ch: 'ACT.ACT_CH1' },
  { label: 'Fuel Main',    entity: 'ACT.Fuel_Main',    ch: 'ACT.ACT_CH7' },
  { label: 'LOX Vent',     entity: 'ACT.LOX_Vent',     ch: 'ACT.ACT_CH6' },
  { label: 'Fuel Vent',    entity: 'ACT.Fuel_Vent',    ch: 'ACT.ACT_CH2' },
  { label: 'LOX Press',    entity: 'ACT.LOX_Press',    ch: 'ACT.ACT_CH8' },
  { label: 'Fuel Press',   entity: 'ACT.Fuel_Press',   ch: 'ACT.ACT_CH3' },
  { label: 'GSE Vent',     entity: 'ACT.GSE_Low_Vent', ch: 'ACT.ACT_CH5' },
];

function ValveStatusRow({ label, entity, ch }: { label: string; entity: string; ch: string }) {
  const status  = useSensorValue(entity, 'status');
  const adcNamed = useSensorValue(entity, 'raw_adc_counts');
  const adcCh    = useSensorValue(ch, 'raw_adc_counts');
  const adc = adcNamed ?? adcCh;
  const isOpen = status === 1 || (adc !== null && adc > 1000);
  const hasData = status !== null || adc !== null;

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-800/60 last:border-0">
      <span className="text-sm text-text-muted">{label}</span>
      <div className="flex items-center gap-3">
        {adc !== null && (
          <span className="text-xs font-mono text-gray-500">{adc.toFixed(0)} ADC</span>
        )}
        <span className={`text-xs font-bold font-mono w-16 text-right ${
          !hasData ? 'text-gray-600' : isOpen ? 'text-green-400' : 'text-red-400'
        }`}>
          {!hasData ? '---' : isOpen ? '● OPEN' : '○ CLOSED'}
        </span>
      </div>
    </div>
  );
}

function DutyCycleCard({ label, entity, color }: { label: string; entity: string; color: string }) {
  const dc  = useSensorValue(entity, 'duty_cycle') ?? 0;
  const on  = useSensorValue(entity, 'onoff');

  return (
    <div className="bg-card rounded-xl border border-gray-800 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-bold tracking-wider text-text-muted uppercase">{label}</h3>
        <span className={`text-xs font-bold font-mono px-2 py-0.5 rounded ${
          on ? 'bg-green-900/50 text-green-400 border border-green-800' :
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
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const currentState = useSensorStore((state) => state.currentState);
  const ws = getWebSocketClient();

  useEffect(() => {
    if (!ws.isConnected()) {
      ws.connect();
    }
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => {
      updateSensor(p as SensorUpdate);
    });
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => {
      const stateUpdate = p as StateUpdate;
      updateState(stateUpdate);
      console.log('[ControllerPage] State updated:', stateUpdate);
    });
    
    // Also subscribe to sensor updates for the controller entities
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
    
    return () => { 
      u1(); 
      u2(); 
    };
  }, [ws, updateSensor, updateState]);

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
            <span className={`font-mono font-bold ${
              currentState === SystemState.FIRE ? 'text-red-400' :
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
          <DutyCycleCard label="Fuel Solenoid"     entity="CONTROLLER.Fuel" color="#3498DB" />
          <DutyCycleCard label="Oxidizer Solenoid" entity="CONTROLLER.Ox"   color="#E74C3C" />

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

        {/* Right column: duty cycle time series */}
        <div className="bg-card rounded-xl border border-gray-800 p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="PWM Duty Cycles (%)"
            entities={['CONTROLLER.Fuel', 'CONTROLLER.Ox']}
            labels={['Fuel Sol.', 'Ox Sol.']}
            component="duty_cycle"
            colors={['#3498DB', '#E74C3C']}
            yLabel="Duty Cycle (%)"
          />
        </div>

      </div>
    </main>
  );
}
