'use client'

import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';

export default function ControllerPage() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const getSensorValue = useSensorStore((state) => state.getSensorValue);
  const ws = getWebSocketClient();
  useEffect(() => {
    ws.connect();
    const unsubscribe = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });
    return unsubscribe;
  }, [ws, updateSensor]);

  // Frequency is set in config, not dynamically changed
  // Controller only adjusts duty cycle, not frequency
  const controllerFrequency = 10; // Hz - set in config.toml

  return (
    <main className="min-h-screen bg-background text-text p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Controller Status</h1>

          {/* Frequency Display (read-only, set in config) */}
          <div className="flex items-center gap-4 text-sm">
            <div className="bg-card px-4 py-2 rounded-lg border border-gray-700">
              <span className="text-text-muted">PWM Frequency: </span>
              <span className="font-mono font-bold">{controllerFrequency} Hz</span>
              <span className="text-text-muted ml-2">(set in config)</span>
            </div>
            <div className="text-text-muted text-xs max-w-xs">
              Controller adjusts duty cycle only. Frequency is hardware configuration.
            </div>
          </div>
        </div>

        {/* Duty Cycles */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-card rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Fuel Solenoid</h2>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <span>Duty Cycle</span>
                  <span className="font-mono">
                    {(getSensorValue('CONTROLLER.Fuel', 'duty_cycle') || 0).toFixed(2)}%
                  </span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-4">
                  <div
                    className="bg-blue-500 h-4 rounded-full transition-all"
                    style={{
                      width: `${(getSensorValue('CONTROLLER.Fuel', 'duty_cycle') || 0)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-between">
                <span>State:</span>
                <span className={getSensorValue('CONTROLLER.Fuel', 'onoff') ? 'text-green-500' : 'text-red-500'}>
                  {getSensorValue('CONTROLLER.Fuel', 'onoff') ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-card rounded-lg p-6">
            <h2 className="text-xl font-bold mb-4">Oxidizer Solenoid</h2>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between mb-2">
                  <span>Duty Cycle</span>
                  <span className="font-mono">
                    {(getSensorValue('CONTROLLER.Ox', 'duty_cycle') || 0).toFixed(2)}%
                  </span>
                </div>
                <div className="w-full bg-gray-700 rounded-full h-4">
                  <div
                    className="bg-red-500 h-4 rounded-full transition-all"
                    style={{
                      width: `${(getSensorValue('CONTROLLER.Ox', 'duty_cycle') || 0)}%`,
                    }}
                  />
                </div>
              </div>
              <div className="flex justify-between">
                <span>State:</span>
                <span className={getSensorValue('CONTROLLER.Ox', 'onoff') ? 'text-green-500' : 'text-red-500'}>
                  {getSensorValue('CONTROLLER.Ox', 'onoff') ? 'ON' : 'OFF'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Valve States */}
        <div className="bg-card rounded-lg p-6">
          <h2 className="text-xl font-bold mb-4">Valve States</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {['LOX_Main', 'Fuel_Main', 'LOX_Vent', 'Fuel_Vent', 'LOX_Press', 'Fuel_Press', 'GSE_Low_Vent'].map((valve) => {
              const state = getSensorValue(`ACT.${valve}`, 'status');
              return (
                <div key={valve} className="text-center">
                  <div className="text-sm text-text-muted mb-1">{valve.replace('_', ' ')}</div>
                  <div className={`text-2xl font-bold ${state === 1 ? 'text-green-500' : 'text-red-500'}`}>
                    {state === 1 ? 'OPEN' : 'CLOSED'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Duty Cycle Plots */}
        <TimeSeriesPlot
          title="Duty Cycles"
          entities={['CONTROLLER.Fuel', 'CONTROLLER.Ox']}
          component="duty_cycle"
          colors={['#3498DB', '#E74C3C']}
          yLabel="Duty Cycle (%)"
          height={300}
        />
      </div>
    </main>
  );
}
