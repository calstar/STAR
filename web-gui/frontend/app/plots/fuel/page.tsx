'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

export default function FuelGraphsPage() {
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

  return (
    <main className="min-h-screen bg-background text-text p-6">
      <div className="max-w-7xl mx-auto space-y-8">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <h1 className="text-3xl font-bold text-fuel">FUEL System</h1>
          <div className="flex gap-4 text-sm flex-wrap">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-fuel"></div>
              <span>Upstream: {getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#2980B9' }}></div>
              <span>Downstream: {getSensorValue('PT_Cal.Fuel_Downstream', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#5DADE2' }}></div>
              <span>Press: {getSensorValue('ACT.Fuel_Press', 'raw_adc_counts') !== null ? (getSensorValue('ACT.Fuel_Press', 'raw_adc_counts')! > 0 ? 'ACTIVE' : 'INACTIVE') : '---'}</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span>Main: {getSensorValue('ACT.Fuel_Main', 'raw_adc_counts') !== null ? (getSensorValue('ACT.Fuel_Main', 'raw_adc_counts')! > 0 ? 'OPEN' : 'CLOSED') : 'CLOSED'}</span>
            </div>
          </div>
        </div>

        {/* Pressure Bars */}
        <div className="bg-card rounded-lg p-6">
          <h2 className="text-xl font-bold mb-6">Pressure Bars (NOP/MEOP)</h2>
          <div className="flex gap-8 justify-center items-end flex-wrap">
            <PressureBar
              label="Upstream"
              value={getSensorValue('PT_Cal.Fuel_Upstream', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#3498DB"
            />
            <PressureBar
              label="Downstream"
              value={getSensorValue('PT_Cal.Fuel_Downstream', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#2980B9"
            />
            {/* Fuel Press is an actuator, not a pressure sensor - removed from pressure bars */}
          </div>
        </div>

        {/* Pressure Plot */}
        <div className="bg-card rounded-lg p-6">
          <TimeSeriesPlot
            title="FUEL Pressure"
            entities={['PT_Cal.Fuel_Upstream', 'PT_Cal.Fuel_Downstream']}
            component="pressure_psi"
            colors={['#3498DB', '#2980B9']}
            yLabel="Pressure (PSI)"
            height={400}
          />
        </div>

        {/* Actuator States Plot */}
        <div className="bg-card rounded-lg p-6">
          <TimeSeriesPlot
            title="FUEL Actuator States"
            entities={['ACT.Fuel_Main', 'ACT.Fuel_Vent', 'ACT.Fuel_Press']}
            component="raw_adc_counts"
            colors={['#27AE60', '#E74C3C', '#F39C12']}
            yLabel="ADC Counts / Status"
            height={300}
          />
        </div>
      </div>
    </main>
  );
}
