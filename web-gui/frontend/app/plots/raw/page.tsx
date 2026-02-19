'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

export default function RawReadoutsPage() {
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
        <h1 className="text-3xl font-bold">Raw Sensor Readouts</h1>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <TimeSeriesPlot
            title="FUEL Raw ADC"
            entities={['PT.Fuel_Upstream', 'PT.Fuel_Downstream', 'PT.Fuel_Press']}
            component="raw_adc_counts"
            colors={['#3498DB', '#2980B9', '#5DADE2']}
            yLabel="ADC Counts"
            height={400}
          />

          <TimeSeriesPlot
            title="LOX Raw ADC"
            entities={['PT.Ox_Upstream', 'PT.Ox_Downstream', 'PT.Ox_Press']}
            component="raw_adc_counts"
            colors={['#E74C3C', '#C0392B', '#F1948A']}
            yLabel="ADC Counts"
            height={400}
          />

          <TimeSeriesPlot
            title="COPV Raw ADC"
            entities={['PT.GN2_High', 'PT.GN2_Regulated']}
            component="raw_adc_counts"
            colors={['#27AE60', '#229954']}
            yLabel="ADC Counts"
            height={400}
          />

          <TimeSeriesPlot
            title="GSE Raw ADC"
            entities={['PT.Fuel_Transfer_Tank', 'PT.Lox_Fill_Pressure', 'PT.GSE_Low', 'PT.GSE_Mid', 'PT.GSE_High']}
            component="raw_adc_counts"
            colors={['#F39C12', '#9B59B6', '#F39C12', '#9B59B6', '#8E44AD']}
            yLabel="ADC Counts"
            height={400}
          />

          <TimeSeriesPlot
            title="Actuator Raw ADC"
            entities={['ACT.LOX_Main', 'ACT.Fuel_Main', 'ACT.LOX_Vent', 'ACT.Fuel_Vent', 'ACT.LOX_Press', 'ACT.Fuel_Press', 'ACT.GSE_Low_Vent']}
            component="raw_adc_counts"
            colors={['#E74C3C', '#3498DB', '#EC7063', '#5DADE2', '#F1948A', '#85C1E9', '#F39C12']}
            yLabel="ADC Counts"
            height={400}
          />
        </div>
      </div>
    </main>
  );
}
