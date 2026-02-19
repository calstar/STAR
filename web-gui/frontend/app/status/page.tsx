'use client'

import { useEffect } from 'react';
import { useSensorStore, useGetSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

// Named entities match the main dashboard — avoids disagreement between windows
// caused by raw channel IDs (PT_Cal.PT_CHX) showing INT_MAX on uncalibrated paths
const PT_CAL_ROWS = [
  { entity: 'PT_Cal.PT_CH1',  label: 'Fuel Upstream    (CH1)' },
  { entity: 'PT_Cal.PT_CH2',  label: 'GSE Low          (CH2)' },
  { entity: 'PT_Cal.PT_CH3',  label: 'GSE Mid          (CH3)' },
  { entity: 'PT_Cal.PT_CH4',  label: 'Fuel Downstream  (CH4)' },
  { entity: 'PT_Cal.PT_CH5',  label: 'LOX Upstream     (CH5)' },
  { entity: 'PT_Cal.PT_CH6',  label: 'GN2 Regulated    (CH6)' },
  { entity: 'PT_Cal.PT_CH7',  label: 'LOX Downstream   (CH7)' },
  { entity: 'PT_Cal.PT_CH8',  label: 'GSE High         (CH8)' },
  { entity: 'PT_Cal.PT_CH9',  label: 'GN2 High         (CH9)' },
  { entity: 'PT_Cal.PT_CH10', label: 'PT_CH10          (CH10)' },
];

const PT_RAW_ROWS = Array.from({ length: 10 }, (_, i) => ({
  entity: `PT.PT_CH${i + 1}`,
  label: `PT_CH${i + 1}`,
}));

const ACT_ROWS = [
  { entity: 'ACT.ACT_CH1',  label: 'LOX Main         (CH1)' },
  { entity: 'ACT.ACT_CH2',  label: 'Fuel Vent        (CH2)' },
  { entity: 'ACT.ACT_CH3',  label: 'Fuel Press       (CH3)' },
  { entity: 'ACT.ACT_CH4',  label: 'ACT_CH4          (CH4)' },
  { entity: 'ACT.ACT_CH5',  label: 'GSE Low Vent     (CH5)' },
  { entity: 'ACT.ACT_CH6',  label: 'LOX Vent         (CH6)' },
  { entity: 'ACT.ACT_CH7',  label: 'Fuel Main        (CH7)' },
  { entity: 'ACT.ACT_CH8',  label: 'LOX Press        (CH8)' },
  { entity: 'ACT.ACT_CH9',  label: 'ACT_CH9          (CH9)' },
  { entity: 'ACT.ACT_CH10', label: 'ACT_CH10         (CH10)' },
];

interface TableProps {
  title: string;
  rows: { entity: string; label: string }[];
  component: string;
  unit: string;
  accent: string;
}

function StatusTable({ title, rows, component, unit, accent }: TableProps) {
  const getSensorValue = useGetSensorValue();
  return (
    <div className="bg-card rounded-lg border border-gray-800 overflow-hidden flex-1 min-h-0 flex flex-col">
      <div className="px-3 py-2 border-b border-gray-800 flex-shrink-0 flex items-center gap-2">
        <div className="w-0.5 h-4 rounded-full" style={{ backgroundColor: accent }} />
        <h2 className="text-xs font-bold tracking-wider text-text-muted uppercase">{title}</h2>
      </div>
      <div className="overflow-y-auto flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-b border-gray-800">
              <th className="text-left py-1.5 px-3 text-[10px] text-gray-600 font-medium uppercase tracking-wider">Channel</th>
              <th className="text-right py-1.5 px-3 text-[10px] text-gray-600 font-medium uppercase tracking-wider">Value</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ entity, label }) => {
              const value = getSensorValue(entity, component);
              return (
                <tr key={entity} className="border-b border-gray-900/60 hover:bg-gray-900/30">
                  <td className="py-1.5 px-3 text-gray-500 text-xs font-mono">{label}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-semibold">
                    {value !== null ? (
                      <span className="text-gray-200">
                        {value > 1e6
                          ? (value / 1e6).toFixed(2) + 'M'
                          : value.toFixed(2)}
                        <span className="text-gray-600 text-[10px] ml-1">{unit}</span>
                      </span>
                    ) : (
                      <span className="text-gray-700">---</span>
                    )}
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
    const unsub = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    return unsub;
  }, [ws, updateSensor]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-1 h-5 bg-green-500 rounded-full" />
        <h1 className="text-base font-bold tracking-wider">Status Tables</h1>
        <span className="text-xs text-gray-600 font-mono">live · all channels</span>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-3 gap-2">
        <StatusTable title="Calibrated Pressure" rows={PT_CAL_ROWS} component="pressure_psi"    unit="PSI" accent="#3498DB" />
        <StatusTable title="Raw ADC"              rows={PT_RAW_ROWS} component="raw_adc_counts"  unit="ADC" accent="#9B59B6" />
        <StatusTable title="Actuators"            rows={ACT_ROWS}    component="raw_adc_counts"  unit="ADC" accent="#27AE60" />
      </div>
    </main>
  );
}
