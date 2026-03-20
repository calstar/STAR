'use client'

import { useEffect, useState } from 'react';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import PressureBar from '@/components/plots/PressureBar';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import SensorReadoutStrip from '@/components/plots/SensorReadoutStrip';
import { useSensorValue } from '@/lib/store';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig, filterByRole } from '@/lib/sensor-config';
import { usePressureLimits, getLimitsForSystem } from '@/lib/pressure-limits';
import { pt1000VoltageToTempC } from '@/lib/sense-conversions';

const RTD_ADC_REF_V = 2.5;
const ADC_FULL_SCALE = 2 ** 31;
function adcToVoltage(rawAdc: number, refV: number): number {
  const u = (rawAdc >>> 0) as number;
  const signed = u > 0x7fffffff ? u - 0x100000000 : u;
  return (signed / ADC_FULL_SCALE) * refV;
}

function RtdReadoutStrip({
  sensors,
  colors,
}: {
  sensors: { entity: string; calEntity: string; role: string }[];
  colors: string[];
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {sensors.map((s, i) => (
        <RtdReadoutBox
          key={s.entity}
          entity={s.entity}
          calEntity={s.calEntity}
          label={s.role}
          color={colors[i] ?? getEntityColor(s.entity)}
        />
      ))}
    </div>
  );
}

function RtdReadoutBox({
  entity,
  calEntity,
  label,
  color,
}: {
  entity: string;
  calEntity: string;
  label: string;
  color: string;
}) {
  const calTemp = useSensorValue(calEntity, 'temperature_c');
  const raw = useSensorValue(entity, 'raw_resistance_counts');
  const volt =
    raw !== null && Number.isFinite(raw) ? adcToVoltage(raw, RTD_ADC_REF_V) : null;
  const fromRaw =
    volt !== null && Number.isFinite(volt) ? pt1000VoltageToTempC(volt) : null;
  const value =
    calTemp !== null && Number.isFinite(calTemp)
      ? calTemp
      : fromRaw !== null && Number.isFinite(fromRaw)
        ? fromRaw
        : null;
  const display = value !== null ? value.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : '---';
  return (
    <div className="bg-white/[0.02] backdrop-blur-md border border-white/5 rounded-xl px-5 py-3.5 flex items-center gap-4 min-w-0 hover:bg-white/[0.04] hover:shadow-lg transition-all duration-300 flex-1">
      <span className="text-[13px] text-gray-400 font-bold uppercase tracking-widest truncate">
        {label}
      </span>
      <span
        className="text-3xl font-black font-mono tabular-nums ml-auto"
        style={{ color, textShadow: `0 0 15px ${color}60` }}
      >
        {display}
      </span>
      <span className="text-xs text-gray-500 font-bold uppercase tracking-widest">
        °C
      </span>
    </div>
  );
}

export default function LOXGraphsPage() {
  const allSensors = useSensorConfig();
  const pressureLimits = usePressureLimits();
  const loxLimits = getLimitsForSystem(pressureLimits, 'LOX');
  const [activeTab, setActiveTab] = useState<'PT' | 'RTD'>('PT');

  const ptSensors = filterByRole(allSensors, 'Ox', 'LOX').filter(
    (s) => s.calEntity.startsWith('PT') || s.calEntity.startsWith('PT_Cal')
  );
  // RTDs: LOX/Ox/Tank role names (config has "LOX Tank 1".."LOX Tank 4"); sort by id for stable order
  const rtdByRole = filterByRole(allSensors, 'Ox', 'LOX', 'Tank').filter(
    (s) => s.calEntity.startsWith('RTD') || s.calEntity.startsWith('RTD_Cal')
  );
  const rtdSensors = (
    rtdByRole.length > 0
      ? rtdByRole
      : allSensors.filter(
          (s) => s.calEntity.startsWith('RTD') || s.calEntity.startsWith('RTD_Cal')
        )
  ).sort((a, b) => a.id - b.id);

  const currentSensors = activeTab === 'PT' ? ptSensors : rtdSensors;
  const componentName = activeTab === 'PT' ? 'pressure_psi' : 'temperature_c';
  const yLabel = activeTab === 'PT' ? 'Pressure (PSI)' : 'Temperature (°C)';

  // RTD tab: use raw entities + transform (matches LCS/TCS/RTD pane; RTD_Cal may not flow)
  const plotEntities =
    activeTab === 'RTD'
      ? rtdSensors.map((s) => s.entity)
      : currentSensors.map((s) => s.calEntity);
  const plotComponent =
    activeTab === 'RTD' ? 'raw_resistance_counts' : componentName;
  const rtdTransform = (v: number) => {
    if (!Number.isFinite(v)) return NaN;
    const volt = adcToVoltage(v, RTD_ADC_REF_V);
    return pt1000VoltageToTempC(volt) ?? NaN;
  };
  const valueTransforms =
    activeTab === 'RTD'
      ? rtdSensors.map(() => rtdTransform)
      : undefined;

  const entities = currentSensors.map((s) => s.calEntity);
  const labels = currentSensors.map((s) => s.role);
  const colors = (activeTab === 'RTD' ? plotEntities : entities).map((e) =>
    getEntityColor(e)
  );

  const upSensor   = ptSensors.find((s) => s.role.toLowerCase().includes('upstream'));
  const downSensor = ptSensors.find((s) => s.role.toLowerCase().includes('downstream'));
  const up   = useSensorValue(upSensor?.calEntity   ?? '', 'pressure_psi');
  const down = useSensorValue(downSensor?.calEntity ?? '', 'pressure_psi');

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden p-3 gap-2">

      {/* Header + tab toggle */}
      <div className="flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-1 h-5 bg-red-500 rounded-full" />
          <h1 className="text-base font-bold text-red-400 tracking-wider">LOX SYSTEM</h1>
        </div>
        <div className="flex gap-2 bg-gray-900 rounded-lg p-1">
          <button
            onClick={() => setActiveTab('PT')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'PT' ? 'bg-red-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            PTs (Pressures)
          </button>
          <button
            onClick={() => setActiveTab('RTD')}
            className={`px-4 py-1.5 text-sm font-bold rounded-md transition-colors ${activeTab === 'RTD' ? 'bg-orange-500 text-black' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
          >
            RTDs (Temperatures)
          </button>
        </div>
      </div>

      {/* Live readout strip — RTD uses raw-derived temp when RTD_Cal not available */}
      <div className="flex-shrink-0">
        {activeTab === 'PT' ? (
          <SensorReadoutStrip
            sensors={currentSensors.map((s) => ({
              label: s.role,
              entity: s.calEntity,
              component: componentName,
              color: getEntityColor(s.calEntity),
            }))}
          />
        ) : (
          <RtdReadoutStrip sensors={rtdSensors} colors={colors} />
        )}
      </div>

      {/* Body: chart + sidebar */}
      <div className="flex-1 min-h-0 flex flex-row gap-2">
        <div className="flex-1 flex flex-col gap-2 min-h-0 min-w-0">
          <div className="flex-[3] min-h-0 bg-card rounded-lg p-2 flex flex-col min-w-0">
            <TimeSeriesPlot
              title={`LOX ${activeTab}`}
              entities={plotEntities}
              labels={labels}
              component={plotComponent}
              colors={colors}
              yLabel={yLabel}
              valueTransforms={valueTransforms}
            />
          </div>

          <div className="flex-[1] min-h-[280px] flex-shrink-0 overflow-auto">
            <ActuatorStatePanel
              title="LOX Actuators"
              actuators={[
                { label: 'LOX Main',  entity: 'ACT.LOX_Main',  color: getActuatorColor('ACT.LOX_Main') },
                { label: 'LOX Vent',  entity: 'ACT.LOX_Vent',  color: getActuatorColor('ACT.LOX_Vent') },
                { label: 'LOX Press', entity: 'ACT.LOX_Press', color: getActuatorColor('ACT.LOX_Press') },
                { label: 'LOX Fill',  entity: 'ACT.LOX_Fill',  color: getActuatorColor('ACT.LOX_Fill') },
                { label: 'LOX Dump',  entity: 'ACT.LOX_Dump',  color: getActuatorColor('ACT.LOX_Dump') },
              ]}
            />
          </div>
        </div>

        {/* Pressure bars sidebar — PT only (narrower) */}
        <div className="w-40 bg-card rounded-lg p-3 flex flex-col gap-2 flex-shrink-0 overflow-visible">
          <div className="text-xs font-bold uppercase tracking-widest text-gray-400 text-center flex-shrink-0">
            Pressures
          </div>
          <div className="flex flex-row flex-1 gap-2 min-h-0 overflow-visible w-full pr-6">
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Up"   value={up}   nop={loxLimits.NOP} meop={loxLimits.MEOP} color={getEntityColor(upSensor?.calEntity   ?? '')} showLabels={false} />
            </div>
            <div className="flex-1 min-h-0 min-w-0 max-w-full overflow-visible">
              <PressureBar label="Down" value={down} nop={loxLimits.NOP} meop={loxLimits.MEOP} color={getEntityColor(downSensor?.calEntity ?? '')} showLabels={false} />
            </div>
          </div>
        </div>
      </div>

    </main>
  );
}
