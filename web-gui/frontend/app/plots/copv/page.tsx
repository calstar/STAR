'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

export default function COPVGraphsPage() {
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
          <h1 className="text-3xl font-bold text-gn2">COPV System</h1>
          <div className="flex gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-gn2"></div>
              <span>GN2 High: {getSensorValue('PT_Cal.GN2_High', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#229954' }}></div>
              <span>GN2 Reg: {getSensorValue('PT_Cal.GN2_Regulated', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
          </div>
        </div>

        {/* Pressure Bars */}
        <div className="bg-card rounded-lg p-6">
          <h2 className="text-xl font-bold mb-6">Pressure Bars (NOP/MEOP)</h2>
          <div className="flex gap-8 justify-center items-end flex-wrap">
            <PressureBar
              label="GN2 High"
              value={getSensorValue('PT_Cal.GN2_High', 'pressure_psi')}
              nop={900}
              meop={950}
              color="#27AE60"
            />
            <PressureBar
              label="GN2 Reg"
              value={getSensorValue('PT_Cal.GN2_Regulated', 'pressure_psi')}
              nop={900}
              meop={950}
              color="#229954"
            />
          </div>
        </div>

        <TimeSeriesPlot
          title="COPV Pressure"
          entities={['PT_Cal.GN2_High', 'PT_Cal.GN2_Regulated']}
          component="pressure_psi"
          colors={['#27AE60', '#229954']}
          yLabel="Pressure (PSI)"
          height={500}
        />
      </div>
    </main>
  );
}
