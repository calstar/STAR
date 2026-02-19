'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

export default function LOXGraphsPage() {
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
      <div className="max-w-7xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold text-lox">LOX System</h1>
          <div className="flex gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-lox"></div>
              <span>Upstream: {getSensorValue('PT_Cal.Ox_Upstream', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#C0392B' }}></div>
              <span>Downstream: {getSensorValue('PT_Cal.Ox_Downstream', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#F1948A' }}></div>
              <span>Press: {getSensorValue('PT_Cal.Ox_Press', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span>Main: {getSensorValue('ACT.LOX_Main', 'status') === 1 ? 'OPEN' : 'CLOSED'}</span>
            </div>
          </div>
        </div>

        {/* Pressure Bars */}
        <div className="bg-card rounded-lg p-6">
          <h2 className="text-xl font-bold mb-6">Pressure Bars (NOP/MEOP)</h2>
          <div className="flex gap-8 justify-center items-end flex-wrap">
            <PressureBar
              label="Upstream"
              value={getSensorValue('PT_Cal.Ox_Upstream', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#E74C3C"
            />
            <PressureBar
              label="Downstream"
              value={getSensorValue('PT_Cal.Ox_Downstream', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#C0392B"
            />
            <PressureBar
              label="Press"
              value={getSensorValue('PT_Cal.Ox_Press', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#F1948A"
            />
          </div>
        </div>

        {/* Pressure Plot */}
        <TimeSeriesPlot
          title="LOX Pressure"
          entities={['PT_Cal.Ox_Upstream', 'PT_Cal.Ox_Downstream', 'PT_Cal.Ox_Press']}
          component="pressure_psi"
          colors={['#E74C3C', '#C0392B', '#F1948A']}
          yLabel="Pressure (PSI)"
          height={400}
        />

        {/* Actuator States Plot */}
        <TimeSeriesPlot
          title="LOX Actuator States"
          entities={['ACT.LOX_Main', 'ACT.LOX_Vent', 'ACT.LOX_Press']}
          component="raw_adc_counts"
          colors={['#27AE60', '#E74C3C', '#F39C12']}
          yLabel="ADC Counts / Status"
          height={300}
        />
      </div>
    </main>
  );
}
