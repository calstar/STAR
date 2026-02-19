'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

export default function GSEGraphsPage() {
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
          <h1 className="text-3xl font-bold text-gse-low">GSE System</h1>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-gse-low"></div>
              <span>Fuel Transfer: {getSensorValue('PT_Cal.Fuel_Transfer_Tank', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-gse-mid"></div>
              <span>LOX Fill: {getSensorValue('PT_Cal.Lox_Fill_Pressure', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#F39C12' }}></div>
              <span>Low Side: {getSensorValue('PT_Cal.GSE_Low', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#9B59B6' }}></div>
              <span>Mid Side: {getSensorValue('PT_Cal.GSE_Mid', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full" style={{ backgroundColor: '#8E44AD' }}></div>
              <span>High Side: {getSensorValue('PT_Cal.GSE_High', 'pressure_psi')?.toFixed(1) || '---'} PSI</span>
            </div>
          </div>
        </div>

        {/* Pressure Bars */}
        <div className="bg-card rounded-lg p-6">
          <h2 className="text-xl font-bold mb-6">Pressure Bars (NOP/MEOP)</h2>
          <div className="flex gap-8 justify-center items-end flex-wrap">
            <PressureBar
              label="Fuel Transfer"
              value={getSensorValue('PT_Cal.Fuel_Transfer_Tank', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#F39C12"
            />
            <PressureBar
              label="LOX Fill"
              value={getSensorValue('PT_Cal.Lox_Fill_Pressure', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#9B59B6"
            />
            <PressureBar
              label="Low Side"
              value={getSensorValue('PT_Cal.GSE_Low', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#F39C12"
            />
            <PressureBar
              label="Mid Side"
              value={getSensorValue('PT_Cal.GSE_Mid', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#9B59B6"
            />
            <PressureBar
              label="High Side"
              value={getSensorValue('PT_Cal.GSE_High', 'pressure_psi')}
              nop={500}
              meop={700}
              color="#8E44AD"
            />
          </div>
        </div>

        <TimeSeriesPlot
          title="GSE Pressures"
          entities={['PT_Cal.Fuel_Transfer_Tank', 'PT_Cal.Lox_Fill_Pressure', 'PT_Cal.GSE_Low', 'PT_Cal.GSE_Mid', 'PT_Cal.GSE_High']}
          component="pressure_psi"
          colors={['#F39C12', '#9B59B6', '#F39C12', '#9B59B6', '#8E44AD']}
          yLabel="Pressure (PSI)"
          height={500}
        />

        {/* Actuator States Plot */}
        <TimeSeriesPlot
          title="GSE Actuator States"
          entities={['ACT.GSE_Low_Vent']}
          component="raw_adc_counts"
          colors={['#F39C12']}
          yLabel="ADC Counts / Status"
          height={300}
        />
      </div>
    </main>
  );
}
