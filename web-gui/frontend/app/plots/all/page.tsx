'use client'

import { useEffect, useState } from 'react';
import { useSensorStore } from '@/lib/store';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import TimeSeriesPlot from '@/components/plots/TimeSeriesPlot';
import ActuatorStatePanel from '@/components/plots/ActuatorStatePanel';
import { getEntityColor, getActuatorColor } from '@/lib/sensor-colors';
import { useSensorConfig, filterByRole, SensorConfig } from '@/lib/sensor-config';
import { useActuatorsFromConfig } from '@/lib/actuators-from-config';

// ── Tab definitions ───────────────────────────────────────────────────────────
type TabId = 'fuel' | 'lox' | 'copv' | 'gse' | 'raw';

const TABS: { id: TabId; label: string; roleKeywords: string[] }[] = [
  { id: 'fuel', label: '⛽ FUEL', roleKeywords: ['Fuel'] },
  { id: 'lox', label: '🧊 LOX', roleKeywords: ['Ox', 'LOX'] },
  { id: 'copv', label: '🫀 COPV', roleKeywords: ['GN2'] },
  { id: 'gse', label: '🔧 GSE', roleKeywords: ['GSE'] },
  { id: 'raw', label: '📡 RAW', roleKeywords: [] }, // shows all sensors
];

// ── Pressure readout pill ─────────────────────────────────────────────────────
import { useSensorValue } from '@/lib/store';

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

// ── Per-tab plot ──────────────────────────────────────────────────────────────
function CalibratedTab({ sensors, title, actuators }: {
  sensors: SensorConfig[];
  title: string;
  actuators?: { label: string; entity: string; color: string }[];
}) {
  const entities = sensors.map((s) => s.calEntity);
  const labels = sensors.map((s) => s.role);
  const colors = entities.map((e) => getEntityColor(e));

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="flex gap-6 px-1 flex-shrink-0">
        {sensors.map((s) => (
          <ValPill key={s.calEntity} label={s.role} entity={s.calEntity} color={getEntityColor(s.calEntity)} />
        ))}
      </div>
      <TimeSeriesPlot
        title={title}
        entities={entities}
        labels={labels}
        component="pressure_psi"
        colors={colors}
        yLabel="Pressure (PSI)"
      />
      {actuators && actuators.length > 0 && (
        <ActuatorStatePanel title="Actuators" actuators={actuators} />
      )}
    </div>
  );
}

function RawTab({ sensors }: { sensors: SensorConfig[] }) {
  const half = Math.ceil(sensors.length / 2);
  const first = sensors.slice(0, half);
  const second = sensors.slice(half);

  const mkEntities = (s: SensorConfig[]) => s.map((x) => x.entity);
  const mkLabels = (s: SensorConfig[]) => s.map((x) => x.role);
  const mkColors = (s: SensorConfig[]) => s.map((x) => getEntityColor(x.entity));

  return (
    <div className="flex flex-col h-full gap-2">
      {first.length > 0 && (
        <TimeSeriesPlot
          title={`PT CH 1–${half} (Raw ADC)`}
          entities={mkEntities(first)}
          labels={mkLabels(first)}
          component="raw_adc_counts"
          colors={mkColors(first)}
          yLabel="ADC Counts"
        />
      )}
      {second.length > 0 && (
        <TimeSeriesPlot
          title={`PT CH ${half + 1}–${sensors.length} (Raw ADC)`}
          entities={mkEntities(second)}
          labels={mkLabels(second)}
          component="raw_adc_counts"
          colors={mkColors(second)}
          yLabel="ADC Counts"
        />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AllPlotsPage() {
  const updateSensor = useSensorStore((s) => s.updateSensor);
  const updateState = useSensorStore((s) => s.updateState);
  const [activeTab, setActiveTab] = useState<TabId>('fuel');
  const ws = getWebSocketClient();
  const allSensors = useSensorConfig();

  useEffect(() => {
    ws.connect();
    const unsub1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const unsub2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    return () => { unsub1(); unsub2(); };
  }, [ws, updateSensor, updateState]);

  const activeTabDef = TABS.find((t) => t.id === activeTab)!;

  // Filter sensors for the active tab
  const tabSensors: SensorConfig[] =
    activeTab === 'raw'
      ? allSensors
      : filterByRole(allSensors, ...activeTabDef.roleKeywords);

  // Pick a representative color for the active tab indicator
  const activeColor = tabSensors.length > 0 ? getEntityColor(tabSensors[0].calEntity) : '#3498DB';

  // Per-tab actuator panels from config (filter by name keyword)
  const { actuators } = useActuatorsFromConfig();
  const toPanel = (a: { name: string; entity: string }) => ({ label: a.name, entity: a.entity, color: getActuatorColor(a.entity) });
  const tabActuators: Record<TabId, { label: string; entity: string; color: string }[]> = {
    fuel: actuators.filter((a) => a.name.includes('Fuel')).map(toPanel),
    lox: actuators.filter((a) => a.name.includes('LOX') || a.name.includes('Ox')).map(toPanel),
    gse: actuators.filter((a) => a.name.includes('GSE')).map(toPanel),
    copv: actuators.filter((a) => a.name.includes('GN2') || a.name.includes('COPV')).map(toPanel),
    raw: [],
  };

  return (
    <main className="h-full bg-background text-text flex flex-col overflow-hidden">
      {/* ── Tab bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1 px-3 pt-2 pb-0 border-b border-gray-800 flex-shrink-0">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const sensors = tab.id === 'raw' ? allSensors : filterByRole(allSensors, ...tab.roleKeywords);
          const color = sensors.length > 0 ? getEntityColor(sensors[0].calEntity) : '#3498DB';
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 text-xs font-bold tracking-wider rounded-t transition-all
                ${isActive
                  ? 'text-white border-b-2 bg-gray-900'
                  : 'text-gray-500 hover:text-gray-300 border-b-2 border-transparent'}`}
              style={isActive ? { borderColor: color, color } : {}}
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
            {activeTabDef.label.split(' ').slice(1).join(' ')}
          </span>
        </div>
      </div>

      {/* ── Plot area ───────────────────────────────────────────────────── */}
      <div className="flex-1 min-h-0 overflow-hidden p-3">
        {activeTab === 'raw' ? (
          <RawTab sensors={allSensors} />
        ) : (
          <CalibratedTab
            sensors={tabSensors}
            title={`${activeTabDef.label.split(' ').slice(1).join(' ')} Pressure (PSI)`}
            actuators={tabActuators[activeTab]}
          />
        )}
      </div>
    </main>
  );
}
