'use client'

import { useSensorStore } from '@/lib/store';
import { useEffect } from 'react';
import { getWebSocketClient } from '@/lib/websocket';
import { MessageType, SensorUpdate, StateUpdate } from '@/lib/types';
import WindowLauncher from '@/components/windows/WindowLauncher';
import { useSensorValue } from '@/lib/store';

// ── Mini sensor value card ────────────────────────────────────────────────────
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
  if (value !== null && meop && value > meop) valueColor = '#E74C3C';
  else if (value !== null && nop && value > nop) valueColor = '#F39C12';

  return (
    <div className="bg-card border border-gray-800 rounded-lg p-3 hover:border-gray-600 transition-colors">
      <div className="text-xs text-text-muted font-medium truncate mb-1">{label}</div>
      <div className="text-xl font-bold font-mono tabular-nums" style={{ color: valueColor }}>
        {value !== null ? value.toFixed(1) : <span className="text-gray-600">---</span>}
      </div>
      <div className="text-xs text-text-muted">{unit}</div>
    </div>
  );
}

// ── Actuator status pill ──────────────────────────────────────────────────────
function ActuatorPill({ label, entity }: { label: string; entity: string }) {
  const status = useSensorValue(entity, 'status');
  const adc    = useSensorValue(entity, 'raw_adc_counts');
  const isOpen = status === 1 || (adc !== null && adc > 1000);
  const hasData = status !== null || adc !== null;

  return (
    <div className="flex items-center justify-between bg-card border border-gray-800 rounded-lg px-3 py-2">
      <span className="text-xs text-text-muted">{label}</span>
      <span
        className={`text-xs font-bold font-mono ${
          !hasData ? 'text-gray-600' : isOpen ? 'text-green-400' : 'text-red-400'
        }`}
      >
        {!hasData ? '---' : isOpen ? 'OPEN' : 'CLOSED'}
      </span>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function Home() {
  const updateSensor = useSensorStore((state) => state.updateSensor);
  const updateState = useSensorStore((state) => state.updateState);
  const updateConnectionStatus = useSensorStore((state) => state.updateConnectionStatus);
  const ws = getWebSocketClient();

  useEffect(() => {
    ws.connect();
    const u1 = ws.on(MessageType.SENSOR_UPDATE, (p: unknown) => updateSensor(p as SensorUpdate));
    const u2 = ws.on(MessageType.STATE_UPDATE, (p: unknown) => updateState(p as StateUpdate));
    const u3 = ws.onConnectionStatus((s) => updateConnectionStatus(s));
    return () => { u1(); u2(); u3(); };
  }, [ws, updateSensor, updateState, updateConnectionStatus]);

  const pressureSensors: SensorCardProps[] = [
    { label: 'GN2 Reg', entity: 'PT_Cal.GN2_Regulated', component: 'pressure_psi', color: '#27AE60', nop: 900, meop: 950 },
    { label: 'Fuel Up', entity: 'PT_Cal.Fuel_Upstream', component: 'pressure_psi', color: '#3498DB', nop: 600, meop: 650 },
    { label: 'Fuel Down', entity: 'PT_Cal.Fuel_Downstream', component: 'pressure_psi', color: '#2980B9', nop: 600, meop: 650 },
    { label: 'LOX Up', entity: 'PT_Cal.Ox_Upstream', component: 'pressure_psi', color: '#E74C3C', nop: 600, meop: 650 },
    { label: 'LOX Down', entity: 'PT_Cal.Ox_Downstream', component: 'pressure_psi', color: '#C0392B', nop: 600, meop: 650 },
    { label: 'GSE Low', entity: 'PT_Cal.GSE_Low', component: 'pressure_psi', color: '#F39C12', nop: 500, meop: 700 },
    { label: 'GSE Mid', entity: 'PT_Cal.GSE_Mid', component: 'pressure_psi', color: '#9B59B6', nop: 500, meop: 700 },
    { label: 'GSE High', entity: 'PT_Cal.GSE_High', component: 'pressure_psi', color: '#8E44AD', nop: 500, meop: 700 },
    { label: 'GN2 High', entity: 'PT_Cal.GN2_High', component: 'pressure_psi', color: '#1ABC9C', nop: 900, meop: 950 },
  ];

  const actuators = [
    { label: 'LOX Main', entity: 'ACT.LOX_Main' },
    { label: 'Fuel Main', entity: 'ACT.Fuel_Main' },
    { label: 'LOX Vent', entity: 'ACT.LOX_Vent' },
    { label: 'Fuel Vent', entity: 'ACT.Fuel_Vent' },
    { label: 'LOX Press', entity: 'ACT.LOX_Press' },
    { label: 'Fuel Press', entity: 'ACT.Fuel_Press' },
    { label: 'GSE Vent', entity: 'ACT.GSE_Low_Vent' },
  ];

  return (
    <main className="min-h-screen bg-background text-text">
      <div className="max-w-7xl mx-auto p-6 space-y-6">

        {/* ── Section header ───────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 bg-blue-500 rounded-full" />
          <h2 className="text-sm font-semibold tracking-wider text-text-muted uppercase">
            Live Sensor Overview
          </h2>
        </div>

        {/* ── Pressure sensor cards ────────────────────────────────────── */}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-9 gap-3">
          {pressureSensors.map((s) => (
            <SensorCard key={s.label} {...s} />
          ))}
        </div>

        {/* ── Actuator states ──────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-6 bg-purple-500 rounded-full" />
            <h2 className="text-sm font-semibold tracking-wider text-text-muted uppercase">
              Actuator States
            </h2>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-7 gap-3">
            {actuators.map((a) => (
              <ActuatorPill key={a.label} {...a} />
            ))}
          </div>
        </div>

        {/* ── Window launcher ──────────────────────────────────────────── */}
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-1 h-6 bg-green-500 rounded-full" />
            <h2 className="text-sm font-semibold tracking-wider text-text-muted uppercase">
              Windows
            </h2>
          </div>
          <WindowLauncher />
        </div>

      </div>
    </main>
  );
}
