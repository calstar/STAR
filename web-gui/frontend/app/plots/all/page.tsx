'use client'

import { useEffect, useState } from 'react';
import { useSensorStore, useSensorValue } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';

// ── Tab definitions ───────────────────────────────────────────────────────────
type TabId = 'fuel' | 'lox' | 'copv' | 'gse' | 'raw';

const TABS: { id: TabId; label: string; color: string }[] = [
  { id: 'fuel',  label: '⛽ FUEL',  color: '#3498DB' },
  { id: 'lox',   label: '🧊 LOX',   color: '#E74C3C' },
  { id: 'copv',  label: '🫀 COPV',  color: '#27AE60' },
  { id: 'gse',   label: '🔧 GSE',   color: '#F39C12' },
  { id: 'raw',   label: '📡 RAW',   color: '#9B59B6' },
];

// ── Pressure readout pill ─────────────────────────────────────────────────────
function ValPill({ label, entity, component = 'pressure_psi', unit = 'PSI', color }: {
  label: string; entity: string; component?: string; unit?: string; color: string;
}) {
  const val = useSensorValue(entity, component);
  return (
    <div className="flex flex-col items-center min-w-[72px]">
      <div className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider mb-0.5">{label}</div>
      <div className="text-base font-bold font-mono leading-none" style={{ color }}>
        {val !== null ? val.toFixed(1) : '---'}
      </div>
      <div className="text-[10px] text-gray-600 mt-0.5">{unit}</div>
    </div>
  );
}

// ── Per-tab plot definitions ──────────────────────────────────────────────────
function FuelTab() {
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-6 px-1 flex-shrink-0">
        <ValPill label="Fuel Up"   entity="PT_Cal.PT_CH1" color="#3498DB" />
        <ValPill label="Fuel Down" entity="PT_Cal.PT_CH4" color="#2980B9" />
      </div>
      <TimeSeriesPlot
        title="FUEL Pressure (PSI)"
        entities={['PT_Cal.PT_CH1','PT_Cal.PT_CH4']}
        labels={['Fuel Upstream','Fuel Downstream']}
        component="pressure_psi"
        colors={['#3498DB','#2980B9']}
        yLabel="Pressure (PSI)"
      />
      <ActuatorStatePanel
        title="Fuel Actuators"
        actuators={[
          { label: 'Fuel Main',  entity: 'ACT.Fuel_Main', color: '#27AE60' },
          { label: 'Fuel Vent',  entity: 'ACT.Fuel_Vent', color: '#E74C3C' },
          { label: 'Fuel Press', entity: 'ACT.Fuel_Press', color: '#F39C12' },
        ]}
      />
    </div>
  );
}

function LOXTab() {
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-6 px-1 flex-shrink-0">
        <ValPill label="LOX Up"   entity="PT_Cal.PT_CH5" color="#E74C3C" />
        <ValPill label="LOX Down" entity="PT_Cal.PT_CH7" color="#C0392B" />
      </div>
      <TimeSeriesPlot
        title="LOX Pressure (PSI)"
        entities={['PT_Cal.PT_CH5','PT_Cal.PT_CH7']}
        labels={['LOX Upstream','LOX Downstream']}
        component="pressure_psi"
        colors={['#E74C3C','#C0392B']}
        yLabel="Pressure (PSI)"
      />
      <ActuatorStatePanel
        title="LOX Actuators"
        actuators={[
          { label: 'LOX Main',  entity: 'ACT.LOX_Main', color: '#27AE60' },
          { label: 'LOX Vent',  entity: 'ACT.LOX_Vent', color: '#E74C3C' },
          { label: 'LOX Press', entity: 'ACT.LOX_Press', color: '#F39C12' },
        ]}
      />
    </div>
  );
}

function COPVTab() {
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-6 px-1 flex-shrink-0">
        <ValPill label="GN2 High" entity="PT_Cal.PT_CH9" color="#27AE60" />
        <ValPill label="GN2 Reg"  entity="PT_Cal.PT_CH6" color="#229954" />
      </div>
      <TimeSeriesPlot
        title="COPV / GN2 Pressure (PSI)"
        entities={['PT_Cal.PT_CH9','PT_Cal.PT_CH6']}
        labels={['GN2 High','GN2 Regulated']}
        component="pressure_psi"
        colors={['#27AE60','#229954']}
        yLabel="Pressure (PSI)"
      />
    </div>
  );
}

function GSETab() {
  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-6 px-1 flex-shrink-0">
        <ValPill label="GSE Lo"  entity="PT_Cal.PT_CH2" color="#F39C12" />
        <ValPill label="GSE MID" entity="PT_Cal.GSE_Mid" color="#9B59B6" />
        <ValPill label="GSE Hi"  entity="PT_Cal.PT_CH8" color="#8E44AD" />
      </div>
      <TimeSeriesPlot
        title="GSE Pressures (PSI)"
        entities={['PT_Cal.PT_CH2','PT_Cal.GSE_Mid','PT_Cal.PT_CH8']}
        labels={['GSE Low','GSE MID','GSE High']}
        component="pressure_psi"
        colors={['#F39C12','#9B59B6','#8E44AD']}
        yLabel="Pressure (PSI)"
      />
      <ActuatorStatePanel
        title="GSE Actuators"
        actuators={[
          { label: 'GSE Low Vent', entity: 'ACT.GSE_Low_Vent', color: '#F39C12' },
        ]}
      />
    </div>
  );
}

function RawTab() {
  return (
    <div className="flex flex-col h-full gap-2">
      <TimeSeriesPlot
        title="PT CH 1–5 (Raw ADC)"
        entities={['PT.PT_CH1','PT.PT_CH2','PT.PT_CH3','PT.PT_CH4','PT.PT_CH5']}
        labels={['Fuel Up','GSE Lo','GSE MID','Fuel Down','LOX Up']}
        component="raw_adc_counts"
        colors={['#3498DB','#2980B9','#5DADE2','#1ABC9C','#16A085']}
        yLabel="ADC Counts"
      />
      <TimeSeriesPlot
        title="PT CH 6–10 (Raw ADC)"
        entities={['PT.PT_CH6','PT.PT_CH7','PT.PT_CH8','PT.PT_CH9','PT.PT_CH10']}
        labels={['GN2 Reg','LOX Down','GSE Hi','GN2 Hi','PT10']}
        component="raw_adc_counts"
        colors={['#E74C3C','#C0392B','#F1948A','#F39C12','#E67E22']}
        yLabel="ADC Counts"
      />
    </div>
  );
}

const TAB_CONTENT: Record<TabId, React.ComponentType> = {
  fuel: FuelTab, lox: LOXTab, copv: COPVTab, gse: GSETab, raw: RawTab,
};

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AllPlotsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const [activeTab, setActiveTab] = useState<TabId>('fuel');
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  const TabContent = TAB_CONTENT[activeTab];
  const activeColor = TABS.find((t) => t.id === activeTab)?.color ?? '#3498DB';

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-0 border-b border-gray-800 flex-shrink-0">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 text-xs font-bold tracking-wider rounded-t transition-all
                ${isActive
                  ? 'text-white border-b-2 bg-gray-900'
                  : 'text-gray-500 hover:text-gray-300 border-b-2 border-transparent'}`}
              style={isActive ? { borderColor: tab.color, color: tab.color } : {}}
            >
              {tab.label}
            </button>
          );
        })}
        {/* Live strip */}
        <div className="ml-auto flex items-center gap-2 pr-1">
          <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
          <span className="text-[10px] font-mono text-gray-500">30 s rolling · 20 Hz</span>
          <div className="w-px h-4 bg-gray-700 mx-1" />
          <span className="text-[10px] font-mono" style={{ color: activeColor }}>
            {TABS.find((t) => t.id === activeTab)?.label.split(' ')[1]}
          </span>
        </div>
      </div>

      {/* ── Plot area ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden p-3">
        <TabContent />
      </div>
    </main>
  );
}
