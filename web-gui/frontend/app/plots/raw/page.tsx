'use client'

import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { getEntityColor } from '@/lib/sensor-colors';
import { useSensorConfig } from '@/lib/sensor-config';



export default function RawReadoutsPage() {
  const allSensors = useSensorConfig();

  const labels = allSensors.map((s) => s.role);
  const entities = allSensors.map((s) => s.entity);
  const calEntities = allSensors.map((s) => s.calEntity);
  const colors = entities.map((e) => getEntityColor(e));
  const calColors = calEntities.map((e) => getEntityColor(e));
  const half = Math.ceil(allSensors.length / 2);

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
          allSensors.map((s) => ({
            label: s.role,
            entity: s.entity,
            component: 'raw_adc_counts',
            unit: 'ADC',
            color: getEntityColor(s.entity),
            decimals: 0,
          }))
        } />
      </div>

      {/* 2 rows × 2 cols */}
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 min-h-0">

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0" style={{ minHeight: '250px' }}>
          <TimeSeriesPlot
            title={`PT CH 1–${half}  •  Raw ADC Counts`}
            entities={entities.slice(0, half)}
            labels={labels.slice(0, half)}
            component="raw_adc_counts"
            colors={colors.slice(0, half)}
            yLabel="ADC Counts"
          />
        </div>

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0" style={{ minHeight: '250px' }}>
          <TimeSeriesPlot
            title={`PT CH ${half + 1}–${allSensors.length}  •  Raw ADC Counts`}
            entities={entities.slice(half)}
            labels={labels.slice(half)}
            component="raw_adc_counts"
            colors={colors.slice(half)}
            yLabel="ADC Counts"
          />
        </div>

        {/* Calibrated PSI */}
        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0" style={{ minHeight: '250px' }}>
          <TimeSeriesPlot
            title={`PT CH 1–${half}  •  Calibrated PSI`}
            entities={calEntities.slice(0, half)}
            labels={labels.slice(0, half)}
            component="pressure_psi"
            colors={calColors.slice(0, half)}
            yLabel="Pressure (PSI)"
          />
        </div>

        <div className="bg-card rounded-lg p-3 flex flex-col min-h-0 min-w-0" style={{ minHeight: '250px' }}>
          <TimeSeriesPlot
            title={`PT CH ${half + 1}–${allSensors.length}  •  Calibrated PSI`}
            entities={calEntities.slice(half)}
            labels={labels.slice(half)}
            component="pressure_psi"
            colors={calColors.slice(half)}
            yLabel="Pressure (PSI)"
          />
        </div>

      </div>
    </main>
  );
}
