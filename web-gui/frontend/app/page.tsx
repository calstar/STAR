'use client'

import { useSensorStore } from '@/lib/store';
import { useEffect } from 'react';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate, MissionStartTime } from '@/lib/types';
import WindowLauncher from '@/components/windows/WindowLauncher';
import { useSensorValue } from '@/lib/store';

// ── Sensor value card ────────────────────────────────────────────────────────
interface SensorCardProps {
  label: string;
  entity: string;
  component: string;
  unit?: string;
  color: string;
  nop?: number;
  meop?: number;
}

function SensorCard({ label, entity, component, unit = 'PSI', color, nop, meop }: SensorCardProps) {
  const value = useSensorValue(entity, component);

  let valueColor = color;
  let statusClass = 'border-gray-800';
  if (value !== null && meop && value > meop) {
    valueColor = '#E74C3C';
    statusClass = 'border-red-700 bg-red-950/20';
  } else if (value !== null && nop && value > nop) {
    valueColor = '#F39C12';
    statusClass = 'border-yellow-700 bg-yellow-950/20';
  }

  return (
    <div className={`bg-card border rounded-lg px-3 py-2 hover:border-gray-600 transition-all ${statusClass}`}>
      <div className="text-xs text-text-muted font-semibold tracking-wider uppercase truncate mb-0.5">
        {label}
      </div>

      {/* Current value */}
      <div
        className="text-2xl font-bold font-mono tabular-nums leading-tight"
        style={{ color: valueColor }}
      >
        {value !== null ? value.toFixed(1) : <span className="text-gray-700">---</span>}
      </div>

      {/* Unit */}
      <div className="text-[10px] text-text-muted mt-0.5">{unit}</div>
    </div>
  );
}

// ── Actuator status pill ─────────────────────────────────────────────────────
function ActuatorPill({ label, entity }: { label: string; entity: string }) {
  const status = useSensorValue(entity, 'status');
  const adc    = useSensorValue(entity, 'raw_adc_counts');
  const isOpen = status === 1 || (adc !== null && adc > 1000);
  const hasData = status !== null || adc !== null;

  return (
    <div className={`flex flex-col items-center justify-center bg-card border rounded-xl px-3 py-3 gap-2.5 transition-all min-h-[100px] ${
      !hasData ? 'border-gray-800' : isOpen ? 'border-green-700/80' : 'border-red-700/80'
    }`}>
      <span className="text-xs font-bold text-text-muted uppercase tracking-wider text-center leading-tight">{label}</span>
      <span
        className={`text-xl font-bold font-mono px-3 py-2 rounded-lg w-full text-center ${
          !hasData ? 'text-gray-600 bg-gray-900/40' : isOpen ? 'bg-green-900/50 text-green-300' : 'bg-red-900/50 text-red-300'
        }`}
      >
        {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
      </span>
    </div>
  );
}

// ── Section header ───────────────────────────────────────────────────────────
function SectionHeader({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <div className={`w-1.5 h-5 rounded-full ${color}`} />
      <h2 className="text-sm font-bold tracking-widest text-text-muted uppercase">{children}</h2>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────
export default function Home() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
  const updateMissionStartTime = useSensorStore((state) => state.updateMissionStartTime);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.on(MessageType.MISSION_START_TIME, (p: unknown) => {
      const payload = p as MissionStartTime;
      updateMissionStartTime(payload.missionStartTime);
    });
    const u4 = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    return () => { u1(); u2(); u3(); u4(); };
  }, [ws, updateSensor, updateState, updateConnectionStatus, updateMissionStartTime]);

  const pressureSensors: SensorCardProps[] = [
    { label: 'GN2 Reg', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi', color: '#27AE60', nop: 900, meop: 950 },
    { label: 'Fuel Up', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi', color: '#3498DB', nop: 600, meop: 650 },
    { label: 'Fuel Down', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi', color: '#2980B9', nop: 600, meop: 650 },
    { label: 'LOX Up', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi', color: '#E74C3C', nop: 600, meop: 650 },
    { label: 'LOX Down', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi', color: '#C0392B', nop: 600, meop: 650 },
    { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi', color: '#F39C12', nop: 500, meop: 700 },
    { label: 'GSE MID', entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi', color: '#9B59B6', nop: 4000, meop: 4500 },
    { label: 'GSE High', entity: 'PT_Cal.GSE_High', component: 'pressure_psi', color: '#8E44AD', nop: 500, meop: 700 },
    { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi', color: '#1ABC9C', nop: 900, meop: 950 },
  ];

  // Show all actuators (matching Controls page)
  const actuators = [
    // Main valves
    { label: 'LOX Main',        entity: 'ACT.LOX_Main' },
    { label: 'Fuel Main',       entity: 'ACT.Fuel_Main' },
    // Vent valves
    { label: 'LOX Vent',        entity: 'ACT.LOX_Vent' },
    { label: 'Fuel Vent',       entity: 'ACT.Fuel_Vent' },
    { label: 'GN2 Vent',        entity: 'ACT.GSE_Low_Vent' },
    // Press valves
    { label: 'LOX Press',       entity: 'ACT.LOX_Press' },
    { label: 'Fuel Press',      entity: 'ACT.Fuel_Press' },
    // Fill valves / additional
    { label: 'Fuel Fill Vent',  entity: 'ACT.Fuel_Fill_Vent' },
    { label: 'Fuel Fill Press', entity: 'ACT.Fuel_Fill_Press' },
    { label: 'LOX Fill',        entity: 'ACT.ACT_CH4' },
    { label: 'LOX Dump',        entity: 'ACT.ACT_CH4' },
    { label: 'GSE Low Press Vent',  entity: 'ACT.GSE_Low_Vent' },
    { label: 'GSE High Press Vent', entity: 'ACT.GSE_Low_Vent' },
    { label: 'GSE LOX Fill Vent',   entity: 'ACT.GSE_Low_Vent' },
    { label: 'GSE High Press Control', entity: 'ACT.GSE_Low_Vent' },
    { label: 'GSE Med Press Control',  entity: 'ACT.GSE_Low_Vent' },
  ];

  return (
    <main className="flex-1 bg-background text-text flex flex-col overflow-auto">
      <div className="w-full px-3 py-2 flex flex-col gap-2 flex-1">

        {/* ── Sensors ────────────────────────────────────────────────── */}
        <div>
          <SectionHeader color="bg-blue-500">Live Pressures</SectionHeader>
          <div className="grid grid-cols-5 lg:grid-cols-9 gap-2">
            {pressureSensors.map((s) => (
              <SensorCard key={s.label} {...s} />
            ))}
          </div>
        </div>

        {/* ── Actuators ──────────────────────────────────────────────── */}
        <div>
          <SectionHeader color="bg-purple-500">Actuators</SectionHeader>
          <div className="grid grid-cols-4 lg:grid-cols-7 gap-2">
            {actuators.map((a) => (
              <ActuatorPill key={a.label} {...a} />
            ))}
          </div>
        </div>

        {/* ── Windows ─────────────────────────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0">
          <SectionHeader color="bg-green-500">Windows</SectionHeader>
          <div className="flex-1">
            <WindowLauncher />
          </div>
        </div>

      </div>
    </main>
  );
}
