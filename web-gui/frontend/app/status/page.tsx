'use client'

import { useEffect } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

interface StatusTableProps {
  title: string;
  entities: string[];
  component: string;
}

function StatusTable({ title, entities, component }: StatusTableProps) {
  const getSensorValue = useSensorStore((state) => state.getSensorValue);

  return (
    <div className="bg-card rounded-lg p-6">
      <h2 className="text-xl font-bold mb-4">{title}</h2>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-2 px-4 text-text-muted">Entity</th>
              <th className="text-right py-2 px-4 text-text-muted">Value</th>
            </tr>
          </thead>
          <tbody>
            {entities.map((entity) => {
              const value = getSensorValue(entity, component);
              return (
                <tr key={entity} className="border-b border-gray-800">
                  <td className="py-2 px-4">{entity}</td>
                  <td className="py-2 px-4 text-right font-mono">
                    {value !== null ? value.toFixed(2) : '---'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function StatusPage() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();

    const unsubscribe = ws.on(MessageType.SENSOR_UPDATE, (payload: unknown) => {
      updateSensor(payload as SensorUpdate);
    });

    return unsubscribe;
  }, [ws, updateSensor]);

  return (
    <main className="min-h-screen bg-background text-text p-8">
      <div className="max-w-7xl mx-auto space-y-6">
        <h1 className="text-3xl font-bold">Status Tables</h1>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <StatusTable
            title="Pressure (Calibrated)"
            entities={[
              'PT_Cal.GN2_Regulated',
              'PT_Cal.Fuel_Upstream',
              'PT_Cal.Ox_Upstream',
              'PT_Cal.Fuel_Downstream',
              'PT_Cal.Ox_Downstream',
              'PT_Cal.GSE_Low',
              'PT_Cal.GSE_Mid',
            ]}
            component="pressure_psi"
          />

          <StatusTable
            title="Actuators"
            entities={[
              'ACT.LOX_Main',
              'ACT.Fuel_Main',
              'ACT.LOX_Press',
              'ACT.Fuel_Press',
              'ACT.LOX_Vent',
              'ACT.Fuel_Vent',
              'ACT.GSE_Low_Vent',
            ]}
            component="raw_adc_counts"
          />

          <StatusTable
            title="Raw ADC"
            entities={[
              'PT.GN2_Regulated',
              'PT.Fuel_Upstream',
              'PT.Ox_Upstream',
              'PT.Fuel_Downstream',
              'PT.Ox_Downstream',
              'PT.GSE_Low',
              'PT.GSE_Mid',
            ]}
            component="raw_adc_counts"
          />
        </div>
      </div>
    </main>
  );
}
