'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';

// Channel → role mapping from config.toml
const CH_LABELS_PT = ['Fuel Up', 'GSE Low', 'GSE Mid', 'Fuel Dn', 'LOX Up', 'GN2 Reg', 'LOX Dn', 'GSE Hi', 'GN2 Hi', 'CH10'];

export default function RawReadoutsPage() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">
      <div className="flex items-center gap-3 flex-shrink-0">
        <div className="w-1 h-5 bg-blue-500 rounded-full" />
        <h1 className="text-lg font-bold">Raw Sensor Readouts</h1>
        <span className="text-xs text-text-muted font-mono ml-2">
          30 s rolling window · 20 Hz render
        </span>
      </div>

      {/* Live readout strips */}
      <div className="flex-shrink-0">
        <SensorReadoutStrip sensors={
          Array.from({ length: 10 }, (_, i) => ({
            label: CH_LABELS_PT[i],
            entity: `PT.PT_CH${i + 1}`,
            component: 'raw_adc_counts',
            unit: 'ADC',
            color: '#3498DB',
            decimals: 0,
          }))
        } />
      </div>

      {/* 2 rows × 2 cols */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 min-h-0">

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="PT CH 1–5  •  Raw ADC Counts"
            entities={['PT.PT_CH1','PT.PT_CH2','PT.PT_CH3','PT.PT_CH4','PT.PT_CH5']}
            labels={CH_LABELS_PT.slice(0, 5)}
            component="raw_adc_counts"
            colors={['#3498DB','#2980B9','#5DADE2','#1ABC9C','#16A085']}
            yLabel="ADC Counts"
          />
        </div>

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="PT CH 6–10  •  Raw ADC Counts"
            entities={['PT.PT_CH6','PT.PT_CH7','PT.PT_CH8','PT.PT_CH9','PT.PT_CH10']}
            labels={CH_LABELS_PT.slice(5, 10)}
            component="raw_adc_counts"
            colors={['#E74C3C','#C0392B','#F1948A','#F39C12','#E67E22']}
            yLabel="ADC Counts"
          />
        </div>

        {/* Calibrated PSI */}
        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="PT CH 1–5  •  Calibrated PSI"
            entities={['PT_Cal.PT_CH1','PT_Cal.PT_CH2','PT_Cal.PT_CH3','PT_Cal.PT_CH4','PT_Cal.PT_CH5']}
            labels={CH_LABELS_PT.slice(0, 5)}
            component="pressure_psi"
            colors={['#3498DB','#2980B9','#5DADE2','#1ABC9C','#16A085']}
            yLabel="Pressure (PSI)"
          />
        </div>

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="PT CH 6–10  •  Calibrated PSI"
            entities={['PT_Cal.PT_CH6','PT_Cal.PT_CH7','PT_Cal.PT_CH8','PT_Cal.PT_CH9','PT_Cal.PT_CH10']}
            labels={CH_LABELS_PT.slice(5, 10)}
            component="pressure_psi"
            colors={['#E74C3C','#C0392B','#F1948A','#F39C12','#E67E22']}
            yLabel="Pressure (PSI)"
          />
        </div>

      </div>
    </main>
  );
}
