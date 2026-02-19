'use client'

import { useEffect } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate } from '@/lib/types';

// Channel → role mapping from config.toml
const CH_LABELS_PT = ['Fuel Up', 'GSE Low', 'GSE Mid', 'Fuel Dn', 'LOX Up', 'GN2 Reg', 'LOX Dn', 'GSE Hi', 'GN2 Hi', 'CH10'];
const CH_LABELS_ACT = ['LOX Main', 'Fuel Vent', 'Fuel Press', 'CH4', 'GSE Vent', 'LOX Vent', 'Fuel Main', 'LOX Press', 'CH9', 'CH10'];

export default function RawReadoutsPage() {
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
        <div className="w-1 h-5 bg-blue-500 rounded-full" />
        <h1 className="text-lg font-bold">Raw Sensor Readouts</h1>
        <span className="text-xs text-text-muted font-mono ml-2">
          40 s rolling window · 20 Hz render
        </span>
      </div>

      {/* 3 rows × 2 cols — each plot fills 1/3 of the viewport height */}
      <div className="flex-1 grid grid-cols-2 grid-rows-3 gap-2 min-h-0">

        {/* Row 1: PT raw ADC counts */}
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

        {/* Row 2: Calibrated PSI */}
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

        {/* Row 3: Actuator current feedback */}
        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="ACT CH 1–5  •  Current Feedback (ADC)"
            entities={['ACT.ACT_CH1','ACT.ACT_CH2','ACT.ACT_CH3','ACT.ACT_CH4','ACT.ACT_CH5']}
            labels={CH_LABELS_ACT.slice(0, 5)}
            component="raw_adc_counts"
            colors={['#9B59B6','#8E44AD','#7D3C98','#6C3483','#5B2C6F']}
            yLabel="ADC Counts"
          />
        </div>

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0 overflow-hidden">
          <TimeSeriesPlot
            title="ACT CH 6–10  •  Current Feedback (ADC)"
            entities={['ACT.ACT_CH6','ACT.ACT_CH7','ACT.ACT_CH8','ACT.ACT_CH9','ACT.ACT_CH10']}
            labels={CH_LABELS_ACT.slice(5, 10)}
            component="raw_adc_counts"
            colors={['#27AE60','#229954','#1E8449','#196F3D','#145A32']}
            yLabel="ADC Counts"
          />
        </div>

      </div>
    </main>
  );
}
