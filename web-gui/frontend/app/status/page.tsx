'use client'

import { useEffect } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';

const PRESSURE_SENSORS = [
  { label: 'GN2 Regulated', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi', color: '#27AE60', nop: 900, meop: 950 },
  { label: 'Fuel Upstream', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi', color: '#3498DB', nop: 600, meop: 650 },
  { label: 'Fuel Downstream', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi', color: '#2980B9', nop: 600, meop: 650 },
  { label: 'LOX Upstream', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi', color: '#E74C3C', nop: 600, meop: 650 },
  { label: 'LOX Downstream', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi', color: '#C0392B', nop: 600, meop: 650 },
  { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi', color: '#F39C12', nop: 500, meop: 700 },
  { label: 'GSE MID', entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi', color: '#9B59B6', nop: 4000, meop: 4500 },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', component: 'pressure_psi', color: '#8E44AD', nop: 500, meop: 700 },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi', color: '#1ABC9C', nop: 900, meop: 950 },
];

const ACTUATORS = [
  { label: 'LOX Main', entity: 'ACT.LOX_Main' },
  { label: 'Fuel Main', entity: 'ACT.Fuel_Main' },
  { label: 'LOX Vent', entity: 'ACT.LOX_Vent' },
  { label: 'Fuel Vent', entity: 'ACT.Fuel_Vent' },
  { label: 'LOX Press', entity: 'ACT.LOX_Press' },
  { label: 'Fuel Press', entity: 'ACT.Fuel_Press' },
  { label: 'GSE Low Vent', entity: 'ACT.GSE_Low_Vent' },
];

// High Pressure PT sensors (4-20 mA ratiometric)
const HP_PT_SENSORS = [
  { label: 'GSE Mid', entity: 'PT_Cal.GSE_Mid', color: '#9B59B6' },
  { label: 'GSE High', entity: 'PT_Cal.GSE_High', color: '#8E44AD' },
  { label: 'GN2 High', entity: 'PT_Cal.GN2_High', color: '#1ABC9C' },
];

function fmtValue(v: number | null): string {
  if (v === null || !isFinite(v)) return '---';
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(1);
  return v.toFixed(2);
}

export default function StatusPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const currentState = useSensorStore((s) => s.currentState);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    return unsub;
  }, [ws, updateSensor]);

  const stateNames: Record<number, string> = {
    0: 'DEBUG', 1: 'IDLE', 2: 'ARMED', 3: 'FUEL FILL', 4: 'OX FILL',
    5: 'GN2 PRESS', 6: 'GN2 VENT', 7: 'FUEL PRESS', 8: 'FUEL VENT',
    9: 'OX PRESS', 10: 'OX VENT', 11: 'HIGH PRESS', 12: 'HIGH VENT',
    13: 'VENT', 14: 'CALIBRATE', 15: 'READY', 16: 'FIRE', 17: 'ABORT',
  };

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-auto p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-text mb-1">System Status</h1>
        <div className="text-lg font-mono">
          State: <span className="font-bold">{currentState != null ? stateNames[currentState] ?? 'UNKNOWN' : '---'}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Pressure Sensors */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Pressure Sensors</h2>
          <div className="space-y-2">
            {PRESSURE_SENSORS.map((s) => {
              const value = useSensorValue(s.entity, s.component);
              const val = value ?? null;
              const statusColor = val !== null && val > (s.meop ?? 0) ? '#E74C3C' :
                                 val !== null && val > (s.nop ?? 0) ? '#F39C12' : s.color;
              return (
                <div key={s.label} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: s.color }} />
                    <span className="text-base font-semibold text-text">{s.label}</span>
                  </div>
                  <div className="flex items-center gap-4">
                    {s.nop && s.meop && (
                      <div className="text-xs text-gray-500 font-mono">
                        NOP: {s.nop} | MEOP: {s.meop}
                      </div>
                    )}
                    <span className="text-xl font-bold font-mono tabular-nums" style={{ color: statusColor }}>
                      {fmtValue(val)} PSI
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Actuators */}
        <div className="bg-card rounded-lg p-4 border border-gray-800">
          <h2 className="text-lg font-bold text-text-muted uppercase tracking-wider mb-3">Actuators</h2>
          <div className="space-y-2">
            {ACTUATORS.map((a) => {
              const status = useSensorValue(a.entity, 'status');
              const adc = useSensorValue(a.entity, 'raw_adc_counts');
              const isOpen = status === 1 || (adc !== null && adc > 1000);
              const hasData = status !== null || adc !== null;
              return (
                <div key={a.label} className="flex items-center justify-between py-2 border-b border-gray-800 last:border-0">
                  <span className="text-base font-semibold text-text">{a.label}</span>
                  <div className="flex items-center gap-3">
                    {hasData && (
                      <span className="text-sm font-mono text-gray-500">
                        ADC: {adc?.toLocaleString() ?? '---'}
                      </span>
                    )}
                    <span
                      className={`text-base font-bold font-mono px-3 py-1 rounded ${
                        !hasData ? 'bg-gray-800 text-gray-600' :
                        isOpen ? 'bg-green-900/60 text-green-400' : 'bg-red-900/60 text-red-400'
                      }`}
                    >
                      {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* High Pressure PT Sensors Section */}
      <div className="mt-4">
        <h2 className="text-xl font-bold text-text-muted uppercase tracking-wider mb-4">High Pressure PT Sensors</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {HP_PT_SENSORS.map((sensor) => {
            const pressure = useSensorValue(sensor.entity, 'pressure_psi');
            const adc = useSensorValue(sensor.entity, 'raw_adc_counts');
            const vExc = useSensorValue(sensor.entity, 'excitation_voltage');
            const vSense = useSensorValue(sensor.entity, 'sense_voltage');
            const current = useSensorValue(sensor.entity, 'current_ma');

            return (
              <div key={sensor.label} className="bg-card rounded-lg p-4 border border-gray-800">
                <h3 className="text-lg font-bold text-text mb-3 flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: sensor.color }} />
                  {sensor.label}
                </h3>

                {/* Current Values */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Pressure</div>
                    <div className="text-xl font-bold font-mono tabular-nums" style={{ color: sensor.color }}>
                      {fmtValue(pressure)} PSI
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">Current</div>
                    <div className="text-xl font-bold font-mono tabular-nums text-blue-400">
                      {current !== null ? `${current.toFixed(2)} mA` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">V_exc</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-green-400">
                      {vExc !== null ? `${vExc.toFixed(3)} V` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">V_sense</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-yellow-400">
                      {vSense !== null ? `${vSense.toFixed(3)} V` : '---'}
                    </div>
                  </div>
                  <div className="bg-gray-900/50 rounded p-2 col-span-2">
                    <div className="text-xs text-gray-400 uppercase tracking-wider mb-1">ADC Code</div>
                    <div className="text-lg font-bold font-mono tabular-nums text-purple-400">
                      {adc !== null ? adc.toLocaleString() : '---'}
                    </div>
                  </div>
                </div>

                {/* Time Series Plots */}
                <div className="space-y-3">
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="Voltage"
                      entities={[sensor.entity]}
                      components={['excitation_voltage', 'sense_voltage']}
                      labels={['V_exc', 'V_sense']}
                      colors={['#27AE60', '#F39C12']}
                      yLabel="Voltage (V)"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="Current"
                      entities={[sensor.entity]}
                      components={['current_ma']}
                      labels={['Current']}
                      colors={[sensor.color]}
                      yLabel="Current (mA)"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                  <div className="h-32">
                    <TimeSeriesPlot
                      title="ADC Code"
                      entities={[sensor.entity]}
                      components={['raw_adc_counts']}
                      labels={['ADC']}
                      colors={['#9B59B6']}
                      yLabel="ADC Code"
                      height={128}
                      windowSeconds={60}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
